import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import type { AbstractAgent } from "@ag-ui/client";
import { PostgresAgentRunner, redactReservedContext, redactReservedEvent } from "./pg-runner";
import { runWithUser, type RequestUser } from "@/lib/auth/request-context";
import { query } from "@/lib/db/pg";
import { runMigrations } from "@/lib/db/migrate";
import { useRealPostgres } from "@/lib/db/test-postgres";

const user1: RequestUser = {
  id: "user-1",
  role: "user",
  name: "Alice",
  email: "a@test.com",
  orgId: "org-1",
};
const user2: RequestUser = {
  id: "user-2",
  role: "user",
  name: "Bob",
  email: "b@test.com",
  orgId: "org-1",
};
// A DIFFERENT org — the cross-tenant isolation tests' attacker/outsider.
const user3: RequestUser = {
  id: "user-3",
  role: "user",
  name: "Carol",
  email: "c@test.com",
  orgId: "org-2",
};

// Cache access helper — the sync LocalThreadEndpointRunner methods read
// from private in-memory Maps. Tests need to seed these directly to
// exercise the sync read paths (production code seeds them via
// captureThreadData / startConnect / refreshCacheFromDB).
interface CacheAccessors {
  threadCache: Map<string, { id: string; name: string | null; agentId: string; organizationId: string; createdById: string; archived: boolean; createdAt: string; updatedAt: string }>;
  messageCache: Map<string, Message[]>;
  eventsCache: Map<string, BaseEvent[]>;
}
function caches(runner: PostgresAgentRunner): CacheAccessors {
  return runner as unknown as CacheAccessors;
}

function makeRunner() {
  return new PostgresAgentRunner();
}

// Seed a thread directly into the cache (bypasses the async DB path).
// Tests that need DB state (e.g. deleteThread's DB delete) also seed PG.
async function seedThreadCache(
  runner: PostgresAgentRunner,
  threadId: string,
  agentId: string,
  title: string,
  userId: string | null,
  orgId = "org-1",
) {
  const nowIso = new Date().toISOString();
  caches(runner).threadCache.set(threadId, {
    id: threadId,
    name: title,
    agentId,
    organizationId: orgId,
    createdById: userId ?? "",
    archived: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

// Seed a thread in BOTH the cache and PG (for tests that exercise the
// DB-write paths like deleteThread, renameThread).
async function seedThread(
  runner: PostgresAgentRunner,
  threadId: string,
  agentId: string,
  title: string,
  userId: string | null,
) {
  await seedThreadCache(runner, threadId, agentId, title, userId);
  await query(
    `INSERT INTO thread_metadata (thread_id, agent_id, title, user_id, org_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (thread_id) DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       title = EXCLUDED.title,
       user_id = EXCLUDED.user_id,
       org_id = EXCLUDED.org_id`,
    [threadId, agentId, title, userId, "org-1"],
  );
  await query(
    `INSERT INTO agent_runs (thread_id, run_id, parent_run_id, events, input, version)
     VALUES ($1, $2, NULL, $3::jsonb, $4::jsonb, 1)`,
    [threadId, `run-${threadId}`, JSON.stringify([]), JSON.stringify({})],
  );
}

beforeEach(async () => {
  await runMigrations();
  // Clear PG state for the next test. We do this directly rather than
  // via runner.clearThreads() (which is sync + fire-and-forget async DB
  // delete) to ensure PG is clean before the test starts.
  await query("DELETE FROM agent_runs");
  await query("DELETE FROM run_state");
  await query("DELETE FROM thread_messages");
  await query("DELETE FROM thread_metadata");
});

describe("PostgresAgentRunner — thread scoping (cache-based listThreads)", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    // Wait for the constructor's fire-and-forget refreshCacheFromDB() to
    // finish, then clear the cache. Without this, the refresh could fire
    // AFTER test seeding and overwrite the cache with stale (empty) data.
    await runner.awaitRefreshed();
    runner.clearThreads();
  });

  describe("listThreads", () => {
    it("returns only threads belonging to the current user via ALS", () => {
      seedThreadCache(runner, "t1", "agent-a", "Alice's chat", user1.id);
      seedThreadCache(runner, "t2", "agent-a", "Bob's chat", user2.id);

      const threads = runWithUser(user1, () => runner.listThreads());
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe("t1");
      expect(threads[0].createdById).toBe(user1.id);
    });

    it("returns all threads when no ALS context is set", () => {
      seedThreadCache(runner, "t1", "agent-a", "Alice's chat", user1.id);
      seedThreadCache(runner, "t2", "agent-a", "Bob's chat", user2.id);

      const threads = runner.listThreads();
      expect(threads).toHaveLength(2);
    });

    it("returns threads with empty createdById for org members (org-shared legacy rows)", () => {
      // Legacy rows with no recorded owner are org-shared (org-mate
      // semantics, same rule deleteThread applies) — but only within the
      // RIGHT org: the org match is exact.
      seedThreadCache(runner, "t1", "agent-a", "Legacy chat", null);
      seedThreadCache(runner, "t2", "agent-a", "Alice's chat", user1.id);

      const threads = runWithUser(user1, () => runner.listThreads());
      expect(threads).toHaveLength(2);
    });

    it("hides empty-org metadata rows from every authenticated user (the cross-tenant leak)", () => {
      // Rows written with NO org must not pass the filter for every
      // org — the empty tolerance widened the org boundary to everyone.
      seedThreadCache(runner, "t1", "agent-a", "Orphaned chat", null, "");
      const threads = runWithUser(user1, () => runner.listThreads());
      expect(threads).toHaveLength(0);
    });

    it("isolates orgs from each other", () => {
      seedThreadCache(runner, "t1", "agent-a", "Org-1 chat", user1.id);
      seedThreadCache(runner, "t2", "agent-a", "Org-2 chat", user3.id, "org-2");

      const org1Threads = runWithUser(user1, () => runner.listThreads());
      const org2Threads = runWithUser(user3, () => runner.listThreads());
      expect(org1Threads.map((t) => t.id)).toEqual(["t1"]);
      expect(org2Threads.map((t) => t.id)).toEqual(["t2"]);
    });

    it("isolates owners within the same org", () => {
      seedThreadCache(runner, "t1", "agent-a", "Alice's chat", user1.id);
      seedThreadCache(runner, "t2", "agent-a", "Bob's chat", user2.id);

      const aliceThreads = runWithUser(user1, () => runner.listThreads());
      const bobThreads = runWithUser(user2, () => runner.listThreads());

      expect(aliceThreads).toHaveLength(1);
      expect(aliceThreads[0].id).toBe("t1");
      expect(bobThreads).toHaveLength(1);
      expect(bobThreads[0].id).toBe("t2");
    });
  });

  describe("deleteThread", () => {
    it("allows owner to delete their thread", async () => {
      await seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = await runWithUser(user1, () => runner.deleteThread("t1"));
      expect(ok).toBe(true);
      // Cache should be cleared.
      expect(runner.listThreads()).toHaveLength(0);
    });

    it("prevents non-owner from deleting via ALS", async () => {
      await seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = await runWithUser(user2, () => runner.deleteThread("t1"));
      expect(ok).toBe(false);
      // Cache should be unchanged.
      expect(runner.listThreads()).toHaveLength(1);
    });

    it("prevents non-owner from deleting via explicit userId param", async () => {
      await seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = await runner.deleteThread("t1", user2.id, "org-1");
      expect(ok).toBe(false);
    });

    it("allows deletion of legacy threads (null user_id → createdById=''", async () => {
      await seedThread(runner, "t1", "agent-a", "Legacy chat", null);

      const ok = await runner.deleteThread("t1", user1.id, "org-1");
      expect(ok).toBe(true);
    });

    it("allows deletion without user context (backwards compat)", async () => {
      await seedThread(runner, "t1", "agent-a", "Chat", user1.id);

      const ok = await runner.deleteThread("t1");
      expect(ok).toBe(true);
    });

    it("removes rows from all 4 PG tables + clears cache", async () => {
      await seedThread(runner, "t1", "agent-a", "Chat", user1.id);
      await query(
        `INSERT INTO thread_messages (thread_id, messages)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (thread_id) DO NOTHING`,
        ["t1", JSON.stringify([{ id: "m1", role: "user", content: "hi" }])],
      );

      const ok = await runner.deleteThread("t1", user1.id, "org-1");
      expect(ok).toBe(true);

      const ar = await query("SELECT count(*)::int as c FROM agent_runs WHERE thread_id = $1", ["t1"]);
      const tm = await query("SELECT count(*)::int as c FROM thread_messages WHERE thread_id = $1", ["t1"]);
      const tmeta = await query("SELECT count(*)::int as c FROM thread_metadata WHERE thread_id = $1", ["t1"]);
      const rs = await query("SELECT count(*)::int as c FROM run_state WHERE thread_id = $1", ["t1"]);
      expect(ar.rows[0].c).toBe(0);
      expect(tm.rows[0].c).toBe(0);
      expect(tmeta.rows[0].c).toBe(0);
      expect(rs.rows[0].c).toBe(0);
      // Cache cleared too.
      expect(runner.listThreads()).toHaveLength(0);
    });

    it("returns false when thread is not in cache (not visible to this process)", async () => {
      // Thread exists in PG but not in this process's cache — e.g. created
      // on another instance. deleteThread's ownership check reads cache
      // first, returns false. Documented in pg-runner.ts class doc.
      await query(
        `INSERT INTO thread_metadata (thread_id, agent_id, title, user_id, org_id)
         VALUES ($1, $2, $3, $4, $5)`,
        ["t-ghost", "agent-a", "Ghost", user1.id, "org-1"],
      );

      const ok = await runner.deleteThread("t-ghost", user1.id);
      expect(ok).toBe(false);
    });
  });

  describe("renameThread", () => {
    it("allows owner to rename their thread", async () => {
      await seedThread(runner, "t1", "agent-a", "Old title", user1.id);

      const ok = await runner.renameThread("t1", "New title", user1.id, "org-1");
      expect(ok).toBe(true);

      // Cache should reflect the new name.
      const threads = runner.listThreads();
      expect(threads[0].name).toBe("New title");

      // PG should too.
      const row = await query<{ title: string }>(
        `SELECT title FROM thread_metadata WHERE thread_id = $1`,
        ["t1"],
      );
      expect(row.rows[0].title).toBe("New title");
    });

    it("prevents non-owner from renaming", async () => {
      await seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = await runner.renameThread("t1", "Hacked", user2.id, "org-1");
      expect(ok).toBe(false);
      expect(runner.listThreads()[0].name).toBe("Alice's chat");
    });

    it("allows renaming legacy threads (null user_id)", async () => {
      await seedThread(runner, "t1", "agent-a", "Legacy", null);

      const ok = await runner.renameThread("t1", "Renamed", user1.id, "org-1");
      expect(ok).toBe(true);
    });

    it("allows renaming without user context (backwards compat)", async () => {
      await seedThread(runner, "t1", "agent-a", "Old title", user1.id);

      const ok = await runner.renameThread("t1", "New title");
      expect(ok).toBe(true);
    });
  });
});

describe("PostgresAgentRunner — thread reads + stop (cross-tenant IDOR guards)", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    await runner.awaitRefreshed();
    runner.clearThreads();
  });

  it("hides another org's cached messages/events/state from a member of a different org", async () => {
    seedThreadCache(runner, "t1", "agent-a", "Alice's chat", user1.id);
    caches(runner).messageCache.set("t1", [
      { id: "m1", role: "user", content: "the launch keys are under the mat" },
    ]);
    caches(runner).eventsCache.set("t1", [
      { type: EventType.STATE_SNAPSHOT, snapshot: { apiKey: "sk-internal" } } as BaseEvent,
    ]);

    const carol = runWithUser(user3, () => ({
      messages: runner.getThreadMessages("t1"),
      events: runner.getThreadEvents("t1"),
      state: runner.getThreadState("t1"),
    }));
    // Empty/null — indistinguishable from an unknown thread id. Nothing
    // about another org's thread may cross the boundary, even though the
    // process cache holds it.
    expect(carol.messages).toEqual([]);
    expect(carol.events).toEqual([]);
    expect(carol.state).toBeNull();
  });

  it("serves the owner their own thread", async () => {
    seedThreadCache(runner, "t1", "agent-a", "Alice's chat", user1.id);
    caches(runner).messageCache.set("t1", [
      { id: "m1", role: "user", content: "hello" },
    ]);
    const messages = runWithUser(user1, () => runner.getThreadMessages("t1"));
    expect(messages).toHaveLength(1);
  });

  it("serves org-mates an ownerless (legacy) thread in their own org", () => {
    seedThreadCache(runner, "t1", "agent-a", "Legacy chat", null);
    caches(runner).messageCache.set("t1", [
      { id: "m1", role: "user", content: "org-shared" },
    ]);
    const messages = runWithUser(user2, () => runner.getThreadMessages("t1"));
    expect(messages).toHaveLength(1);
  });

  it("refuses to stop another org's in-flight run", async () => {
    seedThreadCache(runner, "t1", "agent-a", "Alice's chat", user1.id);
    const stopped = await runWithUser(user3, () => runner.stop({ threadId: "t1" }));
    expect(stopped).toBe(false);
  });

  it("refuses to delete another org's thread (the row survives)", async () => {
    await seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);
    const deleted = await runWithUser(user3, () => runner.deleteThread("t1"));
    expect(deleted).toBe(false);
    const row = await query(`SELECT thread_id FROM thread_metadata WHERE thread_id = $1`, ["t1"]);
    expect(row.rows).toHaveLength(1);
  });
});

describe("PostgresAgentRunner — connect() smart replay", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    await runner.awaitRefreshed();
    runner.clearThreads();
  });

  // These can only run against REAL Postgres — pg-mem's parser doesn't
  // support `WITH RECURSIVE` (and can't do cross-statement ROLLBACK). A
  // testcontainers Postgres is swapped in for this suite (Docker
  // required — the daemon is up in dev; without it the suite SKIPS with a
  // note instead of failing, keeping the suite green everywhere). The
  // connect() smart-replay logic (RUN_ERROR filtering, STATE_*
  // preservation, live-bridging) is exercised end-to-end by the manual
  // smoke test in docs/agent-registry.md.
  let pgStarted = false;
  let restorePg: (() => void) | null = null;

  beforeAll(async () => {
    restorePg = await useRealPostgres();
    pgStarted = restorePg !== null;
  });

  afterAll(() => {
    restorePg?.();
    restorePg = null;
  });

  it("replays events from agent_runs, filtering out RUN_ERROR", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    const eventsWithErr: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-err" } as unknown as BaseEvent,
      { type: EventType.RUN_ERROR, message: "backend unreachable" } as unknown as BaseEvent,
    ];
    await query(
      `INSERT INTO agent_runs (thread_id, run_id, events, input, version)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 1)`,
      ["t-err", "run-err", JSON.stringify(eventsWithErr), JSON.stringify({})],
    );

    const obs = runner.connect({ threadId: "t-err" });
    const received: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      obs.subscribe({
        next: (e) => received.push(e),
        complete: () => resolve(),
        error: () => resolve(),
      });
    });

    expect(received.find((e) => e.type === EventType.RUN_ERROR)).toBeUndefined();
  });

  it("preserves STATE_* events (intermediate events not lost)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    const eventsWithState: BaseEvent[] = [
      { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1 } } as unknown as BaseEvent,
    ];
    await query(
      `INSERT INTO agent_runs (thread_id, run_id, events, input, version)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 1)`,
      ["t-state", "run-state", JSON.stringify(eventsWithState), JSON.stringify({})],
    );

    const obs = runner.connect({ threadId: "t-state" });
    const received: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      obs.subscribe({
        next: (e) => received.push(e),
        complete: () => resolve(),
        error: () => resolve(),
      });
    });

    expect(received.some((e) => e.type === EventType.STATE_SNAPSHOT)).toBe(true);
  });

  it("completes immediately (no live-bridging) when no run is in flight", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await query(
      `INSERT INTO agent_runs (thread_id, run_id, events, input, version)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 1)`,
      ["t-done", "run-done", JSON.stringify([]), JSON.stringify({})],
    );

    const obs = runner.connect({ threadId: "t-done" });
    let completed = false;
    await new Promise<void>((resolve) => {
      obs.subscribe({
        complete: () => {
          completed = true;
          resolve();
        },
        error: () => resolve(),
      });
    });
    expect(completed).toBe(true);
  });
});

describe("PostgresAgentRunner — isRunning / stop", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    await runner.awaitRefreshed();
    runner.clearThreads();
  });

  it("isRunning returns false for a thread with no run state", async () => {
    const running = await runner.isRunning({ threadId: "t-never" });
    expect(running).toBe(false);
  });

  it("stop returns false when no run is in flight", async () => {
    const result = await runner.stop({ threadId: "t-never" });
    expect(result).toBe(false);
  });
});

describe("PostgresAgentRunner — stop during a thread's FIRST in-flight run", () => {
  // The stop gate reads the in-memory thread cache, which (before the
  // seed-in-startRun fix) was only populated at run END — so stopping a
  // brand-new thread's first in-flight run was impossible for everyone.
  // This needs a REAL run through startRun (getHistoricRuns uses a
  // recursive CTE pg-mem can't parse), so: real Postgres, same skip
  // discipline as the connect() suite above.
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    await runner.awaitRefreshed();
    runner.clearThreads();
  });

  let pgStarted = false;
  let restorePg: (() => void) | null = null;

  beforeAll(async () => {
    restorePg = await useRealPostgres();
    pgStarted = restorePg !== null;
  });

  afterAll(() => {
    restorePg?.();
    restorePg = null;
  });

  // A stub agent that emits RUN_STARTED and then hangs until abortRun()
  // is called — simulating an in-flight model stream that only the stop
  // path can end.
  function hangingAgent(threadId: string, runId: string) {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abortRun = vi.fn(() => release());
    const agent = {
      agentId: "agent-a",
      agentName: "A",
      abortRun,
      runAgent: async (
        _input: unknown,
        hooks: { onEvent: (e: { event: BaseEvent }) => void },
      ) => {
        hooks.onEvent({
          event: { type: EventType.RUN_STARTED, threadId, runId } as unknown as BaseEvent,
        });
        await blocker;
        hooks.onEvent({
          event: { type: EventType.RUN_FINISHED, threadId, runId } as unknown as BaseEvent,
        });
      },
    } as unknown as AbstractAgent;
    return { agent, abortRun };
  }

  function startRun(threadId: string, runId: string) {
    const { agent, abortRun } = hangingAgent(threadId, runId);
    const events: BaseEvent[] = [];
    let startedResolve!: () => void;
    let completeResolve!: () => void;
    const started = new Promise<void>((r) => (startedResolve = r));
    const completed = new Promise<void>((r) => (completeResolve = r));
    // The run must start INSIDE the runner ALS for user1 — the
    // provisional cache seed takes its owner/org from getRunnerUser().
    const observable = runWithUser(user1, () =>
      runner.run({
        threadId,
        agent,
        input: {
          threadId,
          runId,
          messages: [{ id: "m1", role: "user", content: "hello" }],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
      }),
    );
    observable.subscribe({
      next: (event) => {
        events.push(event);
        if (event.type === EventType.RUN_STARTED) startedResolve();
      },
      complete: () => completeResolve(),
    });
    return { events, started, completed, abortRun };
  }

  it("the owner can stop their own in-flight first run (no cache entry yet)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    const { started, completed, abortRun } = startRun("t-stop-first", "run-sf1");

    await started;
    const stopped = await runWithUser(user1, () =>
      runner.stop({ threadId: "t-stop-first" }),
    );
    expect(stopped).toBe(true);
    expect(abortRun).toHaveBeenCalledTimes(1);

    await completed;
  });

  it("a foreign-org user still cannot stop another org's in-flight first run", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    const { started, completed } = startRun("t-stop-cross", "run-sf2");

    await started;
    const stopped = await runWithUser(user3, () =>
      runner.stop({ threadId: "t-stop-cross" }),
    );
    expect(stopped).toBe(false);

    // The run is still in flight — the owner aborts it to let the
    // runner finish cleanly.
    await runWithUser(user1, () => runner.stop({ threadId: "t-stop-cross" }));
    await completed;
  });
});

describe("PostgresAgentRunner — sync cache reads (getThreadMessages / getThreadState)", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    await runner.awaitRefreshed();
    runner.clearThreads();
  });

  it("getThreadMessages returns empty array when thread not in cache", () => {
    const msgs = runner.getThreadMessages("t-none");
    expect(msgs).toEqual([]);
  });

  it("getThreadMessages returns the cached snapshot (sync read)", () => {
    const messages: Message[] = [
      { id: "m1", role: "user", content: "hello" } as Message,
      { id: "m2", role: "assistant", content: "hi there" } as Message,
    ];
    caches(runner).messageCache.set("t-msgs", messages);

    const msgs = runner.getThreadMessages("t-msgs");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("getThreadState returns null when no events cached for thread", () => {
    expect(runner.getThreadState("t-empty")).toBeNull();
  });

  it("getThreadState returns null when no STATE_SNAPSHOT in cached events", () => {
    caches(runner).eventsCache.set("t-nostate", [
      { type: EventType.RUN_STARTED, threadId: "t-nostate" } as unknown as BaseEvent,
    ]);
    expect(runner.getThreadState("t-nostate")).toBeNull();
  });

  it("getThreadState returns the latest snapshot from cached events", () => {
    caches(runner).eventsCache.set("t-state", [
      { type: EventType.RUN_STARTED, threadId: "t-state" } as unknown as BaseEvent,
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { step: 1 },
      } as unknown as BaseEvent,
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { step: 2, final: true },
      } as unknown as BaseEvent,
    ]);
    expect(runner.getThreadState("t-state")).toEqual({ step: 2, final: true });
  });

  it("clearThreads clears all 3 caches synchronously", () => {
    caches(runner).threadCache.set("t1", {
      id: "t1", name: "T1", agentId: "a", organizationId: "",
      createdById: "", archived: false, createdAt: "", updatedAt: "",
    });
    caches(runner).messageCache.set("t1", [{ id: "m1", role: "user", content: "x" } as Message]);
    caches(runner).eventsCache.set("t1", [
      { type: EventType.RUN_STARTED, threadId: "t1" } as unknown as BaseEvent,
    ]);

    runner.clearThreads();

    expect(runner.listThreads()).toHaveLength(0);
    expect(runner.getThreadMessages("t1")).toEqual([]);
    expect(runner.getThreadEvents("t1")).toEqual([]);
    expect(runner.getThreadState("t1")).toBeNull();
  });
});

describe("redactReservedContext", () => {
  // The reserved set the run gate injects into input.context: the model
  // key, tool contract dep keys, and mcp_connectors (org connector
  // URLs+tokens). Mirrors what storeRun assembles from the runner ALS.
  const reserved = new Set(["openai_api_key", "x_consumer_key", "mcp_connectors"]);

  it("filters context items whose description is a reserved dep key", () => {
    const input = {
      context: [
        { description: "openai_api_key", value: "sk-secret" },
        { description: "user_note", value: "keep me" },
        { description: "mcp_connectors", value: [{ url: "https://x", token: "t" }] },
      ],
    };
    const out = redactReservedContext(input, reserved);
    expect(out).toEqual({ context: [{ description: "user_note", value: "keep me" }] });
  });

  it("matches on name as well as description", () => {
    const input = { context: [{ name: "x_consumer_key", value: "v" }, { name: "safe", value: 1 }] };
    expect(redactReservedContext(input, reserved)).toEqual({ context: [{ name: "safe", value: 1 }] });
  });

  it("returns the same object untouched when nothing is reserved", () => {
    const input = { context: [{ description: "safe", value: 1 }] };
    expect(redactReservedContext(input, reserved)).toBe(input);
  });

  it("leaves non-array and missing context alone", () => {
    const notArray = { context: "nope" };
    expect(redactReservedContext(notArray, reserved)).toBe(notArray);
    const noContext = { messages: [] };
    expect(redactReservedContext(noContext, reserved)).toBe(noContext);
    expect(redactReservedContext(undefined, reserved)).toBeUndefined();
  });

  it("keeps non-object context items", () => {
    const input = { context: ["raw-string", 42, null] };
    expect(redactReservedContext(input, reserved)).toBe(input);
  });

  it("redacts events carrying an embedded input (RUN_STARTED shape)", () => {
    const event = {
      type: EventType.RUN_STARTED,
      input: {
        context: [
          { description: "openai_api_key", value: "sk-secret" },
          { description: "user_doc", value: "keep" },
        ],
      },
    };
    const out = redactReservedEvent(event, reserved);
    expect((out as { input: { context: unknown[] } }).input.context).toEqual([
      { description: "user_doc", value: "keep" },
    ]);
    // Original event object is not mutated.
    expect((event as { input: { context: unknown[] } }).input.context).toHaveLength(2);
  });

  it("returns events without an embedded input untouched", () => {
    const event = { type: EventType.RUN_STARTED };
    expect(redactReservedEvent(event, reserved)).toBe(event);
  });
});

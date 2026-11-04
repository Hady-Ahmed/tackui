import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import type { AbstractAgent } from "@ag-ui/client";
import { PostgresAgentRunner, redactReservedContext, redactReservedEvent } from "./pg-runner";
import { runWithUser, runWithRunnerContext, type RequestUser } from "@/lib/auth/request-context";
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

// An agent that emits RUN_STARTED then RUN_FINISHED and returns — the
// run completes on its own, exercising the full startRun pipeline.
function finishingAgent(threadId: string, runId: string) {
  const agent = {
    agentId: "agent-a",
    agentName: "A",
    abortRun: vi.fn(),
    runAgent: async (
      _input: unknown,
      hooks: { onEvent: (e: { event: BaseEvent }) => void },
    ) => {
      hooks.onEvent({
        event: { type: EventType.RUN_STARTED, threadId, runId } as unknown as BaseEvent,
      });
      hooks.onEvent({
        event: { type: EventType.RUN_FINISHED, threadId, runId } as unknown as BaseEvent,
      });
    },
  } as unknown as AbstractAgent;
  return agent;
}

function runInput(threadId: string, runId: string) {
  return {
    threadId,
    runId,
    messages: [{ id: "m1", role: "user" as const, content: "hello" }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

/** Drive a full run() for `user` and collect its outcome (events/error/completion). */
function runAs(
  runner: PostgresAgentRunner,
  user: RequestUser,
  threadId: string,
  runId: string,
) {
  return new Promise<{
    events: BaseEvent[];
    error: unknown;
    completed: boolean;
  }>((resolve) => {
    const events: BaseEvent[] = [];
    let completed = false;
    runWithUser(user, () =>
      runner.run({
        threadId,
        agent: finishingAgent(threadId, runId),
        input: runInput(threadId, runId),
      }),
    ).subscribe({
      next: (e) => events.push(e),
      error: (err) => resolve({ events, error: err, completed }),
      complete: () => {
        completed = true;
        resolve({ events, error: null, completed });
      },
    });
  });
}

describe("PostgresAgentRunner — run/connect cross-tenant guards", () => {
  // startRun writes runs keyed by threadId alone and startConnect replays
  // history by threadId alone — both previously trusted the caller with
  // only the sync-read gates policing reads. These tests pin the
  // threadVisible enforcement on the two async paths. They need REAL
  // Postgres: the guard resolves thread existence from PG (pg-mem can't
  // parse the recursive CTE used by the replay path either), so the same
  // skip discipline as the connect() suite applies.
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    // No runner.clearThreads() here: it's fire-and-forget async DB work
    // that can land AFTER this test's seeded rows and wipe them (source
    // of a rare flake). The file-level beforeEach already clears every
    // table with awaited deletes, and the fresh runner's refresh sees an
    // empty DB.
    await runner.awaitRefreshed();
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

  it("denies a foreign-org run on an existing thread — no run_state write, no history append", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await seedThread(runner, "t-victim", "agent-a", "Victim chat", "user-1");

    const result = await runAs(runner, user3, "t-victim", "run-attack");
    expect((result.error as Error).message).toBe("Thread not found");

    // The guard fires BEFORE any state change: no "running" marker was
    // written (the victim's next real run isn't blocked) and no attacker
    // run row was appended to the victim's persisted history.
    const state = await query<{ is_running: boolean }>(
      `SELECT is_running FROM run_state WHERE thread_id = 't-victim'`,
    );
    expect(state.rows).toHaveLength(0);
    const runs = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_runs WHERE thread_id = 't-victim'`,
    );
    expect(runs.rows[0]?.n).toBe("1");
  });

  it("denies a same-org NON-OWNER run on an existing thread (owner-or-empty-owner rule)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await seedThread(runner, "t-mate", "agent-a", "Alice's chat", "user-1");

    const result = await runAs(runner, user2, "t-mate", "run-mate");
    expect((result.error as Error).message).toBe("Thread not found");
  });

  it("still allows the OWNER to run an existing thread (regression guard)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await seedThread(runner, "t-own", "agent-a", "Alice's chat", "user-1");

    const result = await runAs(runner, user1, "t-own", "run-own");
    expect(result.error).toBeNull();
    expect(result.completed).toBe(true);
    expect(result.events.some((e) => e.type === EventType.RUN_STARTED)).toBe(true);
  });

  it("still allows a brand-new thread (cache miss + no PG row = creatable)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // A new chat is a cache miss AND has no PG row — the fail-closed
    // deny-on-unknown rule must apply only to threads that EXIST. The
    // creator becomes the owner via captureThreadData on first run.
    const result = await runAs(runner, user1, "t-fresh", "run-fresh");
    expect(result.error).toBeNull();
    expect(result.completed).toBe(true);

    const meta = await query<{ user_id: string | null; org_id: string | null }>(
      `SELECT user_id, org_id FROM thread_metadata WHERE thread_id = 't-fresh'`,
    );
    expect(meta.rows[0]?.user_id).toBe("user-1");
    expect(meta.rows[0]?.org_id).toBe("org-1");
  });

  it("connect() replays NOTHING for a foreign thread (and leaves the events cache untouched)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await seedThread(runner, "t-victim", "agent-a", "Victim chat", "user-1");
    const victimEvents: BaseEvent[] = [
      { type: EventType.STATE_SNAPSHOT, snapshot: { secret: "victim data" } } as unknown as BaseEvent,
    ];
    await query(
      `UPDATE agent_runs SET events = $1::jsonb WHERE thread_id = 't-victim'`,
      [JSON.stringify(victimEvents)],
    );

    const received: BaseEvent[] = [];
    let completed = false;
    await new Promise<void>((resolve) => {
      runWithUser(user3, () => runner.connect({ threadId: "t-victim" })).subscribe({
        next: (e) => received.push(e),
        error: () => resolve(),
        complete: () => {
          completed = true;
          resolve();
        },
      });
    });

    // The denial reads identically to an unknown thread: empty replay,
    // immediate complete — and it happens BEFORE the PG fetch, so the
    // victim's events were never read into this process's caches.
    expect(completed).toBe(true);
    expect(received).toHaveLength(0);
    expect(caches(runner).eventsCache.has("t-victim")).toBe(false);
  });

  it("connect() still replays for the OWNER (regression guard)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await seedThread(runner, "t-own", "agent-a", "Alice's chat", "user-1");
    const ownEvents: BaseEvent[] = [
      { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1 } } as unknown as BaseEvent,
    ];
    await query(
      `UPDATE agent_runs SET events = $1::jsonb WHERE thread_id = 't-own'`,
      [JSON.stringify(ownEvents)],
    );

    const received: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      runWithUser(user1, () => runner.connect({ threadId: "t-own" })).subscribe({
        next: (e) => received.push(e),
        error: () => resolve(),
        complete: () => resolve(),
      });
    });
    expect(received.some((e) => e.type === EventType.STATE_SNAPSHOT)).toBe(true);
  });
});

describe("PostgresAgentRunner — run lock + teardown lifecycle", () => {
  // The run lock (run_state.is_running) and the ACTIVE_CONNECTIONS entry
  // must survive every failure mode: a crash, a pre-run DB failure, a
  // mid-run persistence failure, and — the subtle one — an aborted run's
  // teardown racing a replacement run that reused the thread. Real
  // Postgres: the lock is a conditional SQL upsert, same skip discipline
  // as the suites above.
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    // No fire-and-forget clearThreads() — same flake reasoning as the
    // cross-tenant guards suite above.
    await runner.awaitRefreshed();
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

  // An agent that emits RUN_STARTED and then hangs on a blocker the test
  // controls. abortRun releases the blocker only when `abortReleases` —
  // tests that need the teardown to happen LATER (after a replacement run
  // started) pass false and fire `release()` manually.
  function controlledAgent(
    threadId: string,
    runId: string,
    opts: { throwOnRelease?: boolean; abortReleases?: boolean } = {},
  ) {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abortRun = vi.fn(() => {
      if (opts.abortReleases) release();
    });
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
        if (opts.throwOnRelease) {
          throw new Error("model exploded");
        }
        hooks.onEvent({
          event: { type: EventType.RUN_FINISHED, threadId, runId } as unknown as BaseEvent,
        });
      },
    } as unknown as AbstractAgent;
    return { agent, release, abortRun };
  }

  function startControlled(
    threadId: string,
    runId: string,
    opts: { throwOnRelease?: boolean; abortReleases?: boolean } = {},
  ) {
    const { agent, release, abortRun } = controlledAgent(threadId, runId, opts);
    const events: BaseEvent[] = [];
    let startedResolve!: () => void;
    let settledResolve!: () => void;
    const started = new Promise<void>((r) => (startedResolve = r));
    const settled = new Promise<void>((r) => (settledResolve = r));
    // Inside the runner ALS for user1 — the guard and the provisional
    // cache seed read the runner user from here.
    const observable = runWithUser(user1, () =>
      runner.run({ threadId, agent, input: runInput(threadId, runId) }),
    );
    observable.subscribe({
      next: (event) => {
        events.push(event);
        if (event.type === EventType.RUN_STARTED) startedResolve();
      },
      complete: () => settledResolve(),
      error: () => settledResolve(),
    });
    return { events, started, settled, release, abortRun };
  }

  it("only one of two concurrent claims on a thread wins the lock", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The atomic upsert directly: two concurrent claims on the SAME
    // thread race the conditional INSERT .. ON CONFLICT .. WHERE — the
    // loser's UPDATE matches zero rows (the winner's is_running=true
    // fails the WHERE), so exactly one RETURNING row comes back. The old
    // check-then-act pair (getRunState → setRunState) let both through.
    const acquire = (runId: string) =>
      (
        runner as unknown as {
          acquireRunState: (t: string, r: string) => Promise<boolean>;
        }
      ).acquireRunState("t-lockrace", runId);
    const [first, second] = await Promise.all([
      acquire("run-C1"),
      acquire("run-C2"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("a sequential second run while the first is in flight is still refused", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    const first = startControlled("t-lock", "run-1", { abortReleases: true });
    await first.started;

    const second = await runAs(runner, user1, "t-lock", "run-2");
    expect((second.error as Error).message).toBe("Thread already running");

    // Clean up: stop releases the lock and lets the first run finish.
    await runWithUser(user1, () => runner.stop({ threadId: "t-lock" }));
    await first.settled;
  });

  it("a stale lock row (a release that hit a transient DB failure) is stolen by the next run", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // teardownRun's release is best-effort — a transient DB failure used
    // to leave is_running=true forever (no TTL, no runtime recovery):
    // every subsequent run was refused with "Thread already running"
    // until the next process restart. acquireRunState now detects the
    // stale row (current_run_id with no live ACTIVE_CONNECTIONS entry in
    // this process) and steals it. The row is aged past the grace window
    // — a fresh row is indistinguishable from a winner still
    // mid-registration (the grace is what makes the steal safe against
    // the concurrent-claims race).
    await query(
      `INSERT INTO run_state (thread_id, is_running, current_run_id, updated_at)
       VALUES ('t-stale', true, 'run-ghost', now() - interval '60 seconds')`,
    );
    const outcome = await runAs(runner, user1, "t-stale", "run-live");
    expect(outcome.completed).toBe(true);
    const state = await query<{ is_running: boolean }>(
      `SELECT is_running FROM run_state WHERE thread_id = 't-stale'`,
    );
    // The stealing run ran AND released normally afterwards.
    expect(state.rows[0]?.is_running).toBe(false);
  });

  it("a LIVE lock holder is never stolen", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The stale-lock steal keys on the in-memory connection: an in-flight
    // run holds BOTH the row and a live map entry — a concurrent acquire
    // must still be refused (the steal exists only for rows whose run is
    // gone from this process).
    const first = startControlled("t-livelock", "run-1", { abortReleases: true });
    await first.started;
    const second = await runAs(runner, user1, "t-livelock", "run-2");
    expect((second.error as Error).message).toBe("Thread already running");
    await runWithUser(user1, () => runner.stop({ threadId: "t-livelock" }));
    await first.settled;
  });

  it("a thread deleted mid-run is not resurrected by the run's persistence", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The user deletes a thread from the sidebar while its run is still
    // streaming. The finishing run's storeRun + captureThreadData used to
    // re-insert agent_runs/thread_messages/thread_metadata rows and
    // re-seed the sidebar cache — silently undoing the deletion with a
    // thread holding only the in-flight run's data. deleteThread now
    // marks the live connection; the persistence window skips writes.
    const a = startControlled("t-del", "run-del", { abortReleases: true });
    await a.started;
    const deleted = await runner.deleteThread("t-del", user1.id, user1.orgId);
    expect(deleted).toBe(true);
    a.release();
    await a.settled;

    const runs = await query<{ run_id: string }>(
      `SELECT run_id FROM agent_runs WHERE thread_id = 't-del'`,
    );
    expect(runs.rows).toEqual([]);
    expect(runner.getThreadMessages("t-del")).toEqual([]);
    expect(runner.getThreadEvents("t-del")).toEqual([]);
  });

  it("a lock row inside the grace window is refused, not stolen", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The grace is what makes the stale-lock steal safe against the
    // concurrent-claims race: a map-absent row younger than the grace is
    // a winner still mid-registration, not an orphan. A row aged just
    // under STALE_LOCK_GRACE_MS must still be refused — a regression
    // that drops the grace (or the NaN→refuse default) would let a
    // second run steal a fresh winner's lock and double-stream a thread.
    await query(
      `INSERT INTO run_state (thread_id, is_running, current_run_id, updated_at)
       VALUES ('t-grace', true, 'run-ghost', now() - interval '5 seconds')`,
    );
    const outcome = await runAs(runner, user1, "t-grace", "run-live");
    expect((outcome.error as Error).message).toBe("Thread already running");
    const state = await query<{ current_run_id: string | null }>(
      `SELECT current_run_id FROM run_state WHERE thread_id = 't-grace'`,
    );
    // The refused acquire left the row untouched.
    expect(state.rows[0]?.current_run_id).toBe("run-ghost");
  });

  it("a connect bridging an in-flight run terminates the trailing failed run first", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The round-3 rule leaves a failed run unresolved at the END of the
    // persisted history — correct when the stream ends there. But the
    // live bridge appends the in-flight run's RUN_STARTED to the SAME
    // verified stream, and the verifier rejects RUN_STARTED while a run
    // is still active: when the bridge will fire, the trailing failed
    // run must be closed (open sequences first) exactly as the
    // in-history unlock case. (Found in round 4; the
    // failed-run-then-retry-in-history case is pinned separately.)
    const failingAgent = {
      agentId: "agent-a",
      agentName: "A",
      abortRun: vi.fn(),
      runAgent: async (
        _input: unknown,
        hooks: { onEvent: (e: { event: BaseEvent }) => void },
      ) => {
        hooks.onEvent({
          event: { type: EventType.RUN_STARTED, threadId: "t-bridge", runId: "run-fail-1" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: {
            type: EventType.TOOL_CALL_START,
            toolCallId: "tc1",
            toolCallName: "search",
            parentMessageId: "m1",
          } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
        });
      },
    } as unknown as AbstractAgent;

    await new Promise<void>((resolve) => {
      runWithUser(user1, () =>
        runner.run({
          threadId: "t-bridge",
          agent: failingAgent,
          input: runInput("t-bridge", "run-fail-1"),
        }),
      ).subscribe({ complete: () => resolve(), error: () => resolve() });
    });

    // A retry is in flight and stays open until we release it.
    const live = startControlled("t-bridge", "run-live", { abortReleases: true });
    await live.started;

    const connectEvents: BaseEvent[] = [];
    let connectDone = false;
    runWithUser(user1, () => runner.connect({ threadId: "t-bridge" })).subscribe({
      next: (e) => connectEvents.push(e),
      complete: () => {
        connectDone = true;
      },
      error: () => {
        connectDone = true;
      },
    });
    // The bridge streams the in-flight run; it completes only at teardown.
    await vi.waitFor(() =>
      expect(
        connectEvents.some(
          (e) =>
            e.type === EventType.RUN_STARTED &&
            (e as { runId?: string }).runId === "run-live",
        ),
      ).toBe(true),
    );
    live.release();
    await live.settled;
    await vi.waitFor(() => expect(connectDone).toBe(true));

    // The replay closed the failed run before the bridge's RUN_STARTED…
    const finishIdx = connectEvents.findIndex(
      (e) =>
        e.type === EventType.RUN_FINISHED &&
        (e as { runId?: string }).runId === "run-fail-1",
    );
    const liveStartIdx = connectEvents.findIndex(
      (e) =>
        e.type === EventType.RUN_STARTED &&
        (e as { runId?: string }).runId === "run-live",
    );
    expect(finishIdx).toBeGreaterThanOrEqual(0);
    expect(liveStartIdx).toBeGreaterThan(finishIdx);
    // …with the open sequences closed before the terminator…
    const msgEndIdx = connectEvents.findIndex(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_END &&
        (e as { messageId?: string }).messageId === "m1",
    );
    const toolEndIdx = connectEvents.findIndex(
      (e) =>
        e.type === EventType.TOOL_CALL_END &&
        (e as { toolCallId?: string }).toolCallId === "tc1",
    );
    for (const idx of [msgEndIdx, toolEndIdx]) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(finishIdx);
    }
    // …no RUN_ERROR anywhere, and the live run finished at the end.
    expect(connectEvents.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(
      connectEvents[connectEvents.length - 1]?.type,
    ).toBe(EventType.RUN_FINISHED);
  });

  it("stop() defers the lock release to the aborted run's own teardown", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // A: hangs; stop() does NOT end it (throwOnRelease → its catch path
    // persists the partial run, then tears down).
    const a = startControlled("t-race", "run-A", { throwOnRelease: true });
    await a.started;

    // Stop A: abort is requested, but the lock is NOT released here —
    // the aborted run keeps it through its persistence window. The old
    // behavior released the lock in stop(), letting a replacement run
    // race the aborted run's storeRun/captureThreadData (interleaved
    // snapshots, out-of-order history) and making the abort-failure
    // restore path able to overwrite a successor's lock with a stale
    // run id (stuck is_running forever).
    const stopped = await runWithUser(user1, () =>
      runner.stop({ threadId: "t-race" }),
    );
    expect(stopped).toBe(true);

    // A replacement run attempted while the aborted run still holds the
    // lock is refused — it can only start once A's teardown releases.
    const refused = await runAs(runner, user1, "t-race", "run-B");
    expect((refused.error as Error).message).toBe("Thread already running");

    // Release A: the catch path persists, then the teardown releases the
    // lock (current_run_id still matches run-A — no restore needed).
    a.release();
    await a.settled;

    const state = await query<{
      is_running: boolean;
      current_run_id: string | null;
    }>(`SELECT is_running, current_run_id FROM run_state WHERE thread_id = 't-race'`);
    expect(state.rows[0]?.is_running).toBe(false);

    // The thread is runnable again — and the owner can still stop a NEW
    // run (the map entry handling is intact for the replacement).
    const b = startControlled("t-race", "run-B2", { abortReleases: true });
    await b.started;
    const stopB = await runWithUser(user1, () => runner.stop({ threadId: "t-race" }));
    expect(stopB).toBe(true);
    expect(b.abortRun).toHaveBeenCalledTimes(1);
    await b.settled;
  });

  it("a connect() landing after storeRun but before teardown does not replay the run twice", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // Window: the success path persists the run (storeRun) and THEN
    // tears down (release + map cleanup). A connect() in between used to
    // bridge the in-flight subject on top of a replay that already
    // contained the persisted run — duplicating every non-message event
    // (the messageId dedup doesn't cover TOOL_CALL_START, which the
    // AG-UI verifier rejects outright). Now: when the replay snapshot
    // already contains the in-flight run id, the bridge is skipped.
    const gate: { open: boolean; waiting: (() => void)[] } = {
      open: false,
      waiting: [],
    };
    const original = (
      runner as unknown as {
        captureThreadData: (...args: unknown[]) => Promise<void>;
      }
    ).captureThreadData;
    const spy = vi
      .spyOn(
        runner as unknown as {
          captureThreadData: (...args: unknown[]) => Promise<void>;
        },
        "captureThreadData",
      )
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (!gate.open) {
          await new Promise<void>((resolve) => gate.waiting.push(resolve));
        }
        return original.apply(runner, args);
      });

    const toolCallAgent = {
      agentId: "agent-a",
      agentName: "A",
      abortRun: vi.fn(),
      runAgent: async (
        _input: unknown,
        hooks: { onEvent: (e: { event: BaseEvent }) => void },
      ) => {
        const ev = (type: EventType, extra: Record<string, unknown>) =>
          hooks.onEvent({ event: { type, ...extra } as unknown as BaseEvent });
        ev(EventType.RUN_STARTED, { threadId: "t-connect-dup", runId: "run-dup" });
        ev(EventType.TEXT_MESSAGE_START, { messageId: "m1", role: "assistant" });
        ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: "m1", delta: "hi" });
        ev(EventType.TEXT_MESSAGE_END, { messageId: "m1" });
        ev(EventType.TOOL_CALL_START, { toolCallId: "tc1", toolCallName: "ping" });
        ev(EventType.TOOL_CALL_ARGS, { toolCallId: "tc1", delta: "{}" });
        ev(EventType.TOOL_CALL_END, { toolCallId: "tc1" });
        ev(EventType.RUN_FINISHED, { threadId: "t-connect-dup", runId: "run-dup" });
      },
    } as unknown as AbstractAgent;

    const events: BaseEvent[] = [];
    let settledResolve!: () => void;
    const settled = new Promise<void>((r) => (settledResolve = r));
    const observable = runWithUser(user1, () =>
      runner.run({
        threadId: "t-connect-dup",
        agent: toolCallAgent,
        input: runInput("t-connect-dup", "run-dup"),
      }),
    );
    observable.subscribe({
      next: (e) => events.push(e),
      complete: () => settledResolve(),
      error: () => settledResolve(),
    });

    // Wait until the run is persisted but captureThreadData (and thus the
    // teardown) is still blocked.
    await vi.waitFor(async () => {
      const persisted = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agent_runs WHERE thread_id = 't-connect-dup' AND run_id = 'run-dup'`,
      );
      expect(persisted.rows[0]?.n).toBe("1");
    });

    // connect() while the run is in-flight-but-persisted.
    const connectEvents: BaseEvent[] = [];
    let connectDone = false;
    runWithUser(user1, () =>
      runner.connect({ threadId: "t-connect-dup" }),
    ).subscribe({
      next: (e) => connectEvents.push(e),
      complete: () => {
        connectDone = true;
      },
      error: () => {
        connectDone = true;
      },
    });
    await vi.waitFor(() => expect(connectDone).toBe(true));

    // The replay carried the run exactly once: one TOOL_CALL_START for tc1.
    const toolCallStarts = connectEvents.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolCallStarts).toHaveLength(1);

    // Un-block the run so its teardown completes cleanly.
    gate.open = true;
    for (const resolve of gate.waiting) resolve();
    await settled;
    spy.mockRestore();
  });

  it("a pre-run failure errors the stream and releases the lock", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    const spy = vi
      .spyOn(
        runner as unknown as { getLatestRunId: () => Promise<string | null> },
        "getLatestRunId",
      )
      .mockRejectedValue(new Error("db down"));

    const result = await runAs(runner, user1, "t-pretry", "run-P");
    expect((result.error as Error).message).toBe("db down");

    // The lock was released — the thread is runnable again (the old code
    // abandoned the run here: stuck is_running, client hung).
    const state = await query<{ is_running: boolean }>(
      `SELECT is_running FROM run_state WHERE thread_id = 't-pretry'`,
    );
    expect(state.rows[0]?.is_running).toBe(false);
    spy.mockRestore();
  });

  it("a mid-run persistence failure still completes the stream and releases the lock", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The agent fails mid-run (throw-on-release) AND storeRun fails in
    // the catch path — the teardown must survive both and finish.
    const spy = vi
      .spyOn(
        runner as unknown as {
          storeRun: (...args: unknown[]) => Promise<void>;
        },
        "storeRun",
      )
      .mockRejectedValue(new Error("persist down"));

    const a = startControlled("t-persist", "run-X", { throwOnRelease: true });
    await a.started;
    a.release();
    await a.settled;

    const state = await query<{ is_running: boolean }>(
      `SELECT is_running FROM run_state WHERE thread_id = 't-persist'`,
    );
    expect(state.rows[0]?.is_running).toBe(false);
    spy.mockRestore();
  });

  it("refreshes the events cache when a run persists (sync readers see the new run)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The audit's eventsCache staleness finding, verified REAL: the cache
    // was only ever populated by connect(), so after a run the sync
    // readers (CopilotKit's runtime /threads/:id/events and /state HTTP
    // endpoints) served the PRE-RUN history. storeRun now merges the
    // persisted events into the cache.
    expect(runner.getThreadEvents("t-cache")).toEqual([]);

    const outcome = await runAs(runner, user1, "t-cache", "run-cache-1");
    expect(outcome.completed).toBe(true);

    const events = runner.getThreadEvents("t-cache");
    expect(events.some((e) => e.type === EventType.RUN_STARTED)).toBe(true);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

    // A second run MERGES into the same stream — both runs' events are
    // visible (and the compacted stream stays stable across the merge).
    const second = await runAs(runner, user1, "t-cache", "run-cache-2");
    expect(second.completed).toBe(true);
    const after = runner.getThreadEvents("t-cache");
    const startedRunIds = after
      .filter((e) => e.type === EventType.RUN_STARTED)
      .map((e) => (e as { runId?: string }).runId);
    expect(startedRunIds).toContain("run-cache-1");
    expect(startedRunIds).toContain("run-cache-2");
  });

  it("a failed run's RUN_ERROR is persisted but never lands in the replay cache", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // Same filter connect() applies before replaying: the AG-UI verifier
    // locks on a replayed RUN_ERROR mid-stream, so the sync replay surface
    // must never carry one — even though the row itself is persisted.
    const failingAgent = {
      agentId: "agent-a",
      agentName: "A",
      abortRun: vi.fn(),
      runAgent: async (
        _input: unknown,
        hooks: { onEvent: (e: { event: BaseEvent }) => void },
      ) => {
        hooks.onEvent({
          event: { type: EventType.RUN_STARTED, threadId: "t-cache-err", runId: "run-err" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
        });
      },
    } as unknown as AbstractAgent;

    const outcome = await new Promise<{ completed: boolean; events: BaseEvent[] }>((resolve) => {
      const events: BaseEvent[] = [];
      runWithUser(user1, () =>
        runner.run({
          threadId: "t-cache-err",
          agent: failingAgent,
          input: runInput("t-cache-err", "run-err"),
        }),
      ).subscribe({
        next: (e) => events.push(e),
        error: () => resolve({ completed: false, events }),
        complete: () => resolve({ completed: true, events }),
      });
    });

    // The RUN_ERROR reached the live stream (the client contract)...
    expect(outcome.events.some((e) => e.type === EventType.RUN_ERROR)).toBe(true);
    // ...was persisted...
    const persisted = await query<{ events: BaseEvent[] }>(
      `SELECT events FROM agent_runs WHERE thread_id = 't-cache-err'`,
    );
    expect(JSON.stringify(persisted.rows[0]?.events)).toContain("RUN_ERROR");
    // ...but the replay cache filters it, keeping the rest.
    const cached = runner.getThreadEvents("t-cache-err");
    expect(cached.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(cached.some((e) => e.type === EventType.RUN_STARTED)).toBe(true);
  });

  it("a failed run followed by a retry: replay closes the open sequences, then terminates the failed run", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The spec requires a producer to close what a run opened BEFORE
    // RUN_FINISHED — and @copilotkit/shared's finalizeRunEvents skips
    // closure when a RUN_ERROR is present, so a persisted errored run
    // keeps its message/tool-call sequences open. The replay's synthetic
    // terminator must therefore close them first, or the reconnect
    // renders a permanently-spinning tool call under a finished run.
    const failingAgent = {
      agentId: "agent-a",
      agentName: "A",
      abortRun: vi.fn(),
      runAgent: async (
        _input: unknown,
        hooks: { onEvent: (e: { event: BaseEvent }) => void },
      ) => {
        hooks.onEvent({
          event: { type: EventType.RUN_STARTED, threadId: "t-close", runId: "run-fail-1" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "partial " } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: {
            type: EventType.TOOL_CALL_START,
            toolCallId: "tc1",
            toolCallName: "search",
            parentMessageId: "m1",
          } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
        });
      },
    } as unknown as AbstractAgent;

    await new Promise<void>((resolve) => {
      runWithUser(user1, () =>
        runner.run({
          threadId: "t-close",
          agent: failingAgent,
          input: runInput("t-close", "run-fail-1"),
        }),
      ).subscribe({ complete: () => resolve(), error: () => resolve() });
    });

    // A retry run follows in the same history — this is the case the
    // synthetic terminator exists for (the retry's RUN_STARTED must not
    // trip the verifier's "run still active" lock).
    const retry = await runAs(runner, user1, "t-close", "run-retry");
    expect(retry.completed).toBe(true);

    const cached = runner.getThreadEvents("t-close");
    const syntheticFinishIdx = cached.findIndex(
      (e) =>
        e.type === EventType.RUN_FINISHED &&
        (e as { runId?: string }).runId === "run-fail-1",
    );
    const retryStartIdx = cached.findIndex(
      (e) =>
        e.type === EventType.RUN_STARTED &&
        (e as { runId?: string }).runId === "run-retry",
    );
    expect(syntheticFinishIdx).toBeGreaterThanOrEqual(0);
    expect(retryStartIdx).toBeGreaterThan(syntheticFinishIdx);

    // The failed run's open sequences are closed BEFORE the terminator…
    const msgEndIdx = cached.findIndex(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_END &&
        (e as { messageId?: string }).messageId === "m1",
    );
    const toolEndIdx = cached.findIndex(
      (e) =>
        e.type === EventType.TOOL_CALL_END &&
        (e as { toolCallId?: string }).toolCallId === "tc1",
    );
    const toolResultIdx = cached.findIndex(
      (e) =>
        e.type === EventType.TOOL_CALL_RESULT &&
        (e as { toolCallId?: string }).toolCallId === "tc1",
    );
    for (const idx of [msgEndIdx, toolEndIdx, toolResultIdx]) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(syntheticFinishIdx);
    }
    // …and the synthesized tool result carries the failure flavor — the
    // replayed history must not read as a successful turn.
    const result = cached[toolResultIdx] as { content?: string };
    expect(JSON.parse(result.content ?? "{}")).toMatchObject({ status: "error" });
  });

  it("a failed run at the END of history stays unresolved (no synthetic success terminator)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // AG-UI makes resolving a truncated FINAL run the consumer's
    // business — synthesizing RUN_FINISHED for it would re-present the
    // failure the live client watched as a completed turn.
    const failingAgent = {
      agentId: "agent-a",
      agentName: "A",
      abortRun: vi.fn(),
      runAgent: async (
        _input: unknown,
        hooks: { onEvent: (e: { event: BaseEvent }) => void },
      ) => {
        hooks.onEvent({
          event: { type: EventType.RUN_STARTED, threadId: "t-unres", runId: "run-fail" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
        });
      },
    } as unknown as AbstractAgent;

    await new Promise<void>((resolve) => {
      runWithUser(user1, () =>
        runner.run({
          threadId: "t-unres",
          agent: failingAgent,
          input: runInput("t-unres", "run-fail"),
        }),
      ).subscribe({ complete: () => resolve(), error: () => resolve() });
    });

    const cached = runner.getThreadEvents("t-unres");
    expect(cached.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    // No terminator: the run stays visibly incomplete.
    expect(cached.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
    expect(cached.some((e) => e.type === EventType.RUN_STARTED)).toBe(true);
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

describe("PostgresAgentRunner — redaction chain integration (live ALS → stream → persisted)", () => {
  // The pure-function tests above pin redactReservedContext/Event in
  // isolation. This suite pins the WIRING — the part a unit test can't:
  // a real run inside a real runWithRunnerContext ALS scope (the way the
  // copilotkit route invokes it), whose reserved set flows through
  // getReservedDepKeys() into BOTH the live onEvent redaction and the
  // storeRun persistence redaction. Needs real Postgres (recursive CTE).
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

  it("drops the run's injected secrets from the live stream and the persisted row; client context survives", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");

    const reservedDepKeys = ["sk_test_model_key_12345", "tavily_api_key"];
    const contextItems = [
      { description: "sk_test_model_key_12345", value: "sk-secret-value" },
      { description: "tavily_api_key", value: "tvly-secret-value" },
      // A non-reserved item (the client's own context) must survive both
      // redaction passes.
      { description: "user_note", value: "not-a-secret" },
    ];

    // Emits RUN_STARTED withOUT an input — startRun fills it from
    // request.input (whose context here is the gate's injected set), the
    // exact path the live redaction must cover.
    const agent = {
      agentId: "agent-a",
      agentName: "A",
      abortRun: vi.fn(),
      runAgent: async (
        _input: unknown,
        hooks: { onEvent: (e: { event: BaseEvent }) => void },
      ) => {
        hooks.onEvent({
          event: { type: EventType.RUN_STARTED, threadId: "t-redact", runId: "run-redact" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as unknown as BaseEvent,
        });
        hooks.onEvent({
          event: { type: EventType.RUN_FINISHED, threadId: "t-redact", runId: "run-redact" } as unknown as BaseEvent,
        });
      },
    } as unknown as AbstractAgent;

    // The run must start INSIDE the runner-context ALS — the same way
    // the copilotkit route wraps builder runs (user + stashed deps +
    // reserved keys in one scope), and the WHOLE lifecycle is awaited
    // inside that scope: a fire-and-forget scope here would let the ALS
    // exit before the run finished, which is not how the route behaves.
    const events: BaseEvent[] = [];
    const outcome = await runWithRunnerContext(
      user1,
      contextItems,
      reservedDepKeys,
      async () => {
        const observable = runner.run({
          threadId: "t-redact",
          agent,
          input: {
            threadId: "t-redact",
            runId: "run-redact",
            messages: [{ id: "m1", role: "user", content: "hello" }],
            state: {},
            tools: [],
            context: contextItems,
            forwardedProps: {},
          },
        });
        return new Promise<{ completed: boolean; error: unknown }>((resolve) => {
          observable.subscribe({
            next: (e) => events.push(e),
            error: (err) => resolve({ completed: false, error: err }),
            complete: () => resolve({ completed: true, error: null }),
          });
        });
      },
    );
    expect(outcome.completed).toBe(true);

    // ── Live stream: the RUN_STARTED the browser would have seen ─────
    const liveStarted = events.find((e) => e.type === EventType.RUN_STARTED) as {
      input?: { context?: { description: string; value: string }[] };
    };
    expect(liveStarted.input?.context).toBeDefined();
    const liveDescriptions = liveStarted.input!.context!.map((c) => c.description);
    expect(liveDescriptions).toEqual(["user_note"]);
    const liveRaw = JSON.stringify(events);
    expect(liveRaw).not.toContain("sk-secret-value");
    expect(liveRaw).not.toContain("tvly-secret-value");

    // ── Persisted: the agent_runs row (events + input) is clean ──────
    const stored = await query<{ events: unknown; input: unknown }>(
      `SELECT events, input FROM agent_runs WHERE thread_id = 't-redact' AND run_id = 'run-redact'`,
    );
    expect(stored.rows).toHaveLength(1);
    const storedRaw = JSON.stringify(stored.rows[0]);
    expect(storedRaw).not.toContain("sk-secret-value");
    expect(storedRaw).not.toContain("tvly-secret-value");
    // The client's own context item survives in the persisted input.
    expect(storedRaw).toContain("not-a-secret");
  });
});

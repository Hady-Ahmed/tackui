import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import type { AbstractAgent } from "@ag-ui/client";
import { PostgresAgentRunner, redactReservedContext, redactReservedEvent } from "./pg-runner";
import { runWithUser, runWithRunnerContext, type RequestUser } from "@/lib/auth/request-context";
import { query, withTransaction } from "@/lib/db/pg";
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
  // Clear PG state for the next test. We do this directly via awaited
  // deletes — runner.clearThreads() is a deliberate no-op (#99) and won't
  // isolate state between tests — to ensure PG is clean before the test
  // starts.
  await query("DELETE FROM agent_runs");
  await query("DELETE FROM run_state");
  await query("DELETE FROM thread_messages");
  await query("DELETE FROM thread_metadata");
  await query("DELETE FROM deleted_threads");
});

describe("PostgresAgentRunner — thread scoping (cache-based listThreads)", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    // Wait for the constructor's fire-and-forget refreshCacheFromDB() to
    // finish. Without this, the refresh could fire AFTER test seeding and
    // overwrite the cache with stale (empty) data. No runner.clearThreads()
    // here — it's a deliberate no-op (#99) and won't isolate state between
    // tests, so fixtures wipe PG directly via awaited query() (see the
    // stop-first suite's beforeEach for the #97 flake history behind that
    // pattern).
    await runner.awaitRefreshed();
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
    // No runner.clearThreads() here — it's a deliberate no-op (#99) and
    // won't isolate state between tests, so fixtures wipe PG directly via
    // awaited query() (see the stop-first suite's beforeEach for the #97
    // flake history behind that pattern).
    await runner.awaitRefreshed();
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
    // No runner.clearThreads() here — it's a deliberate no-op (#99) and
    // won't isolate state between tests, so fixtures wipe PG directly via
    // awaited query() (see the stop-first suite's beforeEach for the #97
    // flake history behind that pattern).
    await runner.awaitRefreshed();
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

  it("never clobbers an events cache holding a run the DB snapshot lacks", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The capture-vs-connect invariant behind cacheHoldsRunOutsideSnapshot:
    // a run's storeRun merge can land in eventsCache AFTER a concurrent
    // connect() read its historic snapshot — the snapshot then cannot cover
    // that run. Overwriting the cache with the snapshot-shaped replay would
    // regress the sync readers (getThreadEvents/getThreadState) to pre-run
    // history until the next write on the thread. Simulated deterministically:
    // the cache is seeded the way storeRun's read-through merge leaves it
    // (run-1 from PG plus the freshly merged run-2), while PG itself holds
    // only run-1 — exactly the (cache, snapshot) pair the guard arbitrates.
    const run1Events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-cache-guard", runId: "run-1" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-cache-guard", runId: "run-1" } as unknown as BaseEvent,
    ];
    await query(
      `INSERT INTO agent_runs (thread_id, run_id, events, input, version)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 1)`,
      ["t-cache-guard", "run-1", JSON.stringify(run1Events), JSON.stringify({})],
    );
    caches(runner).eventsCache.set("t-cache-guard", [
      ...run1Events,
      { type: EventType.RUN_STARTED, threadId: "t-cache-guard", runId: "run-2" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-cache-guard", runId: "run-2" } as unknown as BaseEvent,
    ]);

    const received: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      runner.connect({ threadId: "t-cache-guard" }).subscribe({
        next: (e) => received.push(e),
        complete: () => resolve(),
        error: () => resolve(),
      });
    });

    // The replay covers the snapshot only — run-2 is not in PG.
    expect(
      received.some(
        (e) =>
          e.type === EventType.RUN_STARTED &&
          (e as { runId?: string }).runId === "run-2",
      ),
    ).toBe(false);
    // The cache keeps the fresher merge: run-2 must survive the connect.
    expect(
      caches(runner)
        .eventsCache.get("t-cache-guard")!
        .some(
          (e) =>
            e.type === EventType.RUN_STARTED &&
            (e as { runId?: string }).runId === "run-2",
        ),
    ).toBe(true);
  });

  // Collect the full replay of a connect() — the subscription pattern the
  // tests above inline, factored out for the replay-shaping suite below.
  function collectReplay(threadId: string): Promise<BaseEvent[]> {
    return new Promise((resolve) => {
      const received: BaseEvent[] = [];
      runner.connect({ threadId }).subscribe({
        next: (e) => received.push(e),
        complete: () => resolve(received),
        error: () => resolve(received),
      });
    });
  }

  function insertRun(
    threadId: string,
    runId: string,
    events: BaseEvent[],
    parentRunId: string | null = null,
  ): Promise<unknown> {
    return query(
      `INSERT INTO agent_runs (thread_id, run_id, parent_run_id, events, input, version)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 1)`,
      [threadId, runId, parentRunId, JSON.stringify(events), JSON.stringify({})],
    );
  }

  it("replay drops stray events recorded after a run's terminal event", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // A backend that keeps recording after its terminal (a duplicate
    // RUN_FINISHED, trailing message traffic) poisons the replay: the
    // verifier rejects every event except RUN_STARTED (and RUN_ERROR,
    // which replay filters) after a RUN_FINISHED ("The run has already
    // finished with 'RUN_FINISHED'"). The stray tail
    // must not be re-emitted on reconnect.
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-stray", runId: "run-stray" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-stray", runId: "run-stray" } as unknown as BaseEvent,
      // Stray bookkeeping recorded after the terminal:
      { type: EventType.TEXT_MESSAGE_START, messageId: "m-stray", role: "assistant" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m-stray" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-stray", runId: "run-stray" } as unknown as BaseEvent,
    ];
    await insertRun("t-stray", "run-stray", events);

    const received = await collectReplay("t-stray");

    expect(received.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(
      received.some((e) => (e as { messageId?: string }).messageId === "m-stray"),
    ).toBe(false);
    // The legitimate message survived, and the stream ends at the terminal.
    expect(
      received.some(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CONTENT &&
          (e as { delta?: string }).delta === "hello",
      ),
    ).toBe(true);
    expect(received[received.length - 1]?.type).toBe(EventType.RUN_FINISHED);
  });

  it("replay preserves a run that legitimately starts after a finished one", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // RUN_FINISHED → RUN_STARTED is the NORMAL multi-run shape — the
    // stop-at-terminal cut is scoped to the run that ended, never to the
    // whole history. A naive "truncate at the first terminal event" would
    // drop run-b entirely.
    const runA: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-two-runs", runId: "run-a" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m-a", role: "assistant" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m-a", delta: "first" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m-a" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-two-runs", runId: "run-a" } as unknown as BaseEvent,
    ];
    const runB: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-two-runs", runId: "run-b" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m-b", role: "assistant" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m-b", delta: "second" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m-b" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-two-runs", runId: "run-b" } as unknown as BaseEvent,
    ];
    await insertRun("t-two-runs", "run-a", runA);
    // The two awaited inserts run in separate transactions, so each gets
    // a distinct created_at — that's what pins run-b after run-a under
    // getHistoricRuns' ORDER BY created_at.
    await insertRun("t-two-runs", "run-b", runB, "run-a");

    const received = await collectReplay("t-two-runs");
    const runIdOf = (e: BaseEvent) => (e as { runId?: string }).runId;
    const idxOf = (type: EventType, runId: string) =>
      received.findIndex((e) => e.type === type && runIdOf(e) === runId);

    expect(received.filter((e) => e.type === EventType.RUN_STARTED).map(runIdOf)).toEqual([
      "run-a",
      "run-b",
    ]);
    expect(received.filter((e) => e.type === EventType.RUN_FINISHED).map(runIdOf)).toEqual([
      "run-a",
      "run-b",
    ]);
    expect(received.some((e) => (e as { delta?: string }).delta === "first")).toBe(true);
    expect(received.some((e) => (e as { delta?: string }).delta === "second")).toBe(true);
    expect(idxOf(EventType.RUN_STARTED, "run-a")).toBeLessThan(idxOf(EventType.RUN_FINISHED, "run-a"));
    expect(idxOf(EventType.RUN_FINISHED, "run-a")).toBeLessThan(idxOf(EventType.RUN_STARTED, "run-b"));
    expect(idxOf(EventType.RUN_STARTED, "run-b")).toBeLessThan(idxOf(EventType.RUN_FINISHED, "run-b"));
  });

  it("replay closes a REASONING_* sequence an errored run left open, before the next run", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // agno backends can leave a reasoning block open on exception paths —
    // finalizeRunEvents only tracks TEXT_MESSAGE_*/TOOL_CALL_*, so nothing
    // else closes REASONING_*. The replay's synthetic terminator must close
    // the open block (message end, then block end) before the retry's
    // RUN_STARTED, or the reconnect shows a dangling reasoning sequence.
    const runErr: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-reason", runId: "run-err" } as unknown as BaseEvent,
      { type: EventType.REASONING_START, messageId: "block-1" } as unknown as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "msg-1", role: "reasoning" } as unknown as BaseEvent,
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "msg-1", delta: "thinking…" } as unknown as BaseEvent,
      { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
    ];
    const runOk: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-reason", runId: "run-ok" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m-ok", role: "assistant" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m-ok", delta: "answer" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m-ok" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-reason", runId: "run-ok" } as unknown as BaseEvent,
    ];
    await insertRun("t-reason", "run-err", runErr);
    await insertRun("t-reason", "run-ok", runOk, "run-err");

    const received = await collectReplay("t-reason");
    const idxOf = (predicate: (e: BaseEvent) => boolean) => received.findIndex(predicate);
    const withId = (type: EventType, id: string) => (e: BaseEvent) =>
      e.type === type &&
      ((e as { messageId?: string }).messageId === id ||
        (e as { runId?: string }).runId === id);

    const msgEndIdx = idxOf(withId(EventType.REASONING_MESSAGE_END, "msg-1"));
    const blockEndIdx = idxOf(withId(EventType.REASONING_END, "block-1"));
    const synthFinishIdx = idxOf(withId(EventType.RUN_FINISHED, "run-err"));
    const retryStartIdx = idxOf(withId(EventType.RUN_STARTED, "run-ok"));

    expect(received.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    // The open reasoning sequence is closed — message end, then block end —
    // and both closures precede the synthetic terminator and the retry.
    expect(msgEndIdx).toBeGreaterThanOrEqual(0);
    expect(blockEndIdx).toBeGreaterThan(msgEndIdx);
    expect(synthFinishIdx).toBeGreaterThan(blockEndIdx);
    expect(retryStartIdx).toBeGreaterThan(synthFinishIdx);
    // Exactly one terminal for the errored run — the synthetic one.
    expect(
      received.filter(
        (e) =>
          e.type === EventType.RUN_FINISHED &&
          (e as { runId?: string }).runId === "run-err",
      ),
    ).toHaveLength(1);
    // The retry's own history is intact.
    expect(received.some((e) => (e as { delta?: string }).delta === "answer")).toBe(true);
  });

  it("replay leaves a trailing open REASONING_* sequence unresolved when no bridge follows", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // The terminateTrailing contract extends to reasoning: a run left
    // unterminated at the END of the history with no live bridge following
    // stays unresolved — no synthetic RUN_FINISHED, no synthesized
    // closures (re-presenting the failure as a completed turn would erase
    // what the live client actually watched).
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-tail", runId: "run-tail" } as unknown as BaseEvent,
      { type: EventType.REASONING_START, messageId: "block-9" } as unknown as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "msg-9", role: "reasoning" } as unknown as BaseEvent,
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "msg-9", delta: "thinking…" } as unknown as BaseEvent,
      { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
    ];
    await insertRun("t-tail", "run-tail", events);

    const received = await collectReplay("t-tail");

    expect(received.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
    ]);
  });

  it("replay preserves an errored run's traffic the record places after its RUN_ERROR", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // compactEvents persists an errored run's buffered message/tool-call
    // traffic AFTER the RUN_ERROR (it flushes unclosed sequences at stream
    // end), so events following a RUN_ERROR in the record were emitted
    // BEFORE it in real time. The replay keeps them — the run stays open
    // (trailing, no bridge), so no terminal is synthesized either.
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-err-stray", runId: "run-e" } as unknown as BaseEvent,
      { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        parentMessageId: "m1",
      } as unknown as BaseEvent,
    ];
    await insertRun("t-err-stray", "run-e", events);

    const received = await collectReplay("t-err-stray");

    expect(received.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(received.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
    expect(
      received.some(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_START &&
          (e as { messageId?: string }).messageId === "m1",
      ),
    ).toBe(true);
    expect(
      received.some(
        (e) =>
          e.type === EventType.TOOL_CALL_START &&
          (e as { toolCallId?: string }).toolCallId === "tc1",
      ),
    ).toBe(true);
  });

  it("replay closes an errored run's open message before a RUN_FINISHED recorded after the RUN_ERROR", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // A producer must close what it opened before RUN_FINISHED. When the
    // record places open traffic before a terminator (hand-seeded or
    // uncompacted histories), the replay closes the sequence first instead
    // of replaying a dangling TEXT_MESSAGE_START ahead of RUN_FINISHED.
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-err-finish", runId: "run-ef" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
      { type: EventType.RUN_ERROR, message: "boom" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t-err-finish", runId: "run-ef" } as unknown as BaseEvent,
    ];
    await insertRun("t-err-finish", "run-ef", events);

    const received = await collectReplay("t-err-finish");
    const types = received.map((e) => e.type);

    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });
});

describe("PostgresAgentRunner — isRunning / stop", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    // No runner.clearThreads() here — it's a deliberate no-op (#99) and
    // won't isolate state between tests, so fixtures wipe PG directly via
    // awaited query() (see the stop-first suite's beforeEach for the #97
    // flake history behind that pattern).
    await runner.awaitRefreshed();
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
    // No runner.clearThreads() here — it's a deliberate no-op (#99) and
    // won't isolate state between tests, so fixtures wipe PG directly via
    // awaited query(). Incident that settled the awaited-delete rule
    // (#97, CI run 42444771100): the since-removed fire-and-forget
    // clearThreadsAsync() deleted EVERY table unconditionally, and under
    // CI load it landed after this suite's run had claimed the run_state
    // lock — wiping the fresh row mid-test, so stop() read not-running
    // and denied the owner. The file-level beforeEach already clears
    // every table with awaited deletes, and the fresh runner's refresh
    // sees an empty DB — the async delete was pure overhead plus hazard,
    // which is why #99 removed it outright.
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
    // No runner.clearThreads() here — it's a deliberate no-op (#99) and
    // won't isolate state between tests. The file-level beforeEach already
    // clears every table with awaited deletes, and the fresh runner's
    // refresh sees an empty DB.
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
    // No runner.clearThreads() here — it's a deliberate no-op (#99), same
    // reasoning as the cross-tenant guards suite above.
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

describe("PostgresAgentRunner — run_id uniqueness scoped per thread", () => {
  // Issue #65 item 1: agent_runs.run_id carried a GLOBAL unique constraint
  // (0001's inline UNIQUE), so a client reusing its own run_id on a second
  // run — on another thread — hit 23505 at storeRun and the run was
  // silently dropped from history. Migration 0016 replaced the global
  // constraint with a composite unique (thread_id, run_id). Uniqueness
  // semantics can only be pinned on REAL Postgres — pg-mem does not
  // enforce CREATE UNIQUE INDEX — so the same skip discipline as the
  // suites above applies.
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
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

  // storeRun is private; the file's established cast pattern reaches it
  // directly. It is the only INSERT into agent_runs in the runner.
  function storeRun(threadId: string, runId: string): Promise<void> {
    return runWithUser(user1, () =>
      (
        runner as unknown as {
          storeRun: (
            t: string,
            r: string,
            e: BaseEvent[],
            i: ReturnType<typeof runInput>,
            p: string | null,
          ) => Promise<void>;
        }
      ).storeRun(threadId, runId, [], runInput(threadId, runId), null),
    );
  }

  it("rejects a duplicate run_id within the same thread with 23505 (intended duplicate detection)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await storeRun("t-uniq", "run-x");
    // Within ONE thread the (thread_id, run_id) pair is still unique — a
    // second persist of the same run is a hard duplicate, exactly as the
    // old global constraint treated it. The semantics that changed are
    // cross-thread only.
    await expect(storeRun("t-uniq", "run-x")).rejects.toMatchObject({
      code: "23505",
    });
    const rows = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM agent_runs WHERE thread_id = 't-uniq' AND run_id = 'run-x'`,
    );
    expect(rows.rows[0]?.c).toBe(1);
  });

  it("persists the same run_id on a different thread — the case the global constraint dropped", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // Pre-migration this second INSERT raised 23505 (the global UNIQUE on
    // run_id ignores thread_id) and the run was lost from history.
    await storeRun("t-uniq-a", "run-shared");
    await storeRun("t-uniq-b", "run-shared");
    const rows = await query<{ thread_id: string }>(
      `SELECT thread_id FROM agent_runs WHERE run_id = 'run-shared' ORDER BY thread_id`,
    );
    expect(rows.rows.map((r) => r.thread_id)).toEqual(["t-uniq-a", "t-uniq-b"]);
    // The second thread's run merged into the sync readers' cache (the
    // rowCount gate only skips merge for tombstoned threads).
    expect(caches(runner).eventsCache.has("t-uniq-b")).toBe(true);
  });

  it("the schema carries the composite unique index and no global run_id unique index", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    const indexes = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_runs'`,
    );
    // The old global constraint (agent_runs_run_id_key) is gone; the only
    // unique indexes left are the primary key and the composite.
    const uniqueNames = indexes.rows
      .filter((r) => r.indexdef.includes("UNIQUE"))
      .map((r) => r.indexname)
      .sort();
    expect(uniqueNames).toEqual(["agent_runs_pkey", "agent_runs_thread_run_uniq"]);
    const composite = indexes.rows.find(
      (r) => r.indexname === "agent_runs_thread_run_uniq",
    );
    expect(composite?.indexdef).toContain("(thread_id, run_id)");
  });
});

describe("PostgresAgentRunner — deleted-thread tombstones (delete vs run)", () => {
  // Issue #65 item 2. deleteThread deletes the four tables in one
  // transaction and marks the live connection (ACTIVE_CONNECTIONS) — but
  // the marker only reaches runs whose connection was registered BEFORE
  // the delete's map read. Two windows remained: a run that registers
  // after that read (its acquire can wait out the delete transaction's
  // run_state row lock), and a run that starts after the commit (the
  // ownership gate reads a deleted thread as a "creatable" brand-new
  // thread). deleteThread now writes a deleted_threads tombstone in the
  // same transaction; startRun refuses a tombstoned id and the
  // persistence window (storeRun + captureThreadData) skips writing.
  // Real Postgres: row locks, upserts and the recursive-CTE historic read.
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
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

  interface RunRequestShaped {
    threadId: string;
    agent: AbstractAgent;
    input: ReturnType<typeof runInput>;
  }

  it("a run started after the delete commits is refused and persists nothing (delete-then-start)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    await seedThread(runner, "t-dts", "agent-a", "Doomed chat", user1.id);

    const deleted = await runWithUser(user1, () =>
      runner.deleteThread("t-dts", user1.id, user1.orgId),
    );
    expect(deleted).toBe(true);
    // The tombstone committed atomically with the row deletes.
    const tomb = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM deleted_threads WHERE thread_id = 't-dts'`,
    );
    expect(tomb.rows[0]?.c).toBe(1);

    // A run on the now-deleted id: the ownership gate reads it as
    // non-existent ("creatable"), the lock is claimed, then the tombstone
    // gate releases the lock and refuses.
    const result = await runAs(runner, user1, "t-dts", "run-after");
    expect((result.error as Error).message).toBe("Thread not found");

    // Nothing was written: no history, no snapshot, no lock row, no
    // sidebar cache entry — the deletion stands.
    const runs = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM agent_runs WHERE thread_id = 't-dts'`,
    );
    const meta = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM thread_metadata WHERE thread_id = 't-dts'`,
    );
    const state = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM run_state WHERE thread_id = 't-dts'`,
    );
    expect(runs.rows[0]?.c).toBe(0);
    expect(meta.rows[0]?.c).toBe(0);
    expect(state.rows[0]?.c).toBe(0);
    expect(runner.getThreadMessages("t-dts")).toEqual([]);
    expect(runner.getThreadEvents("t-dts")).toEqual([]);
  });

  it("a run whose acquire was in flight when the delete committed is refused cleanly (start-then-delete)", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // Holder-transaction interleaving (the credentials-route pattern): the
    // holder replicates deleteThread's transaction but stays OPEN, holding
    // the run_state row's lock. The run fires into that state — its
    // ownership check reads pre-delete data, then acquireRunState's
    // conditional upsert BLOCKS on the locked row. The holder commits, the
    // delete wins, and the acquire returns having claimed a fresh lock row
    // on a thread that no longer exists — the registration-late state the
    // in-memory marker cannot reach. The tombstone gate must refuse it.
    // No sleeps: the row lock, not timing, forces the interleaving.
    await seedThread(runner, "t-race", "agent-a", "Race chat", user1.id);
    await query(
      `INSERT INTO run_state (thread_id, is_running, current_run_id)
       VALUES ('t-race', false, NULL)`,
    );

    // Plain spy — call-through with call tracking only.
    const ownershipSpy = vi.spyOn(
      runner as unknown as {
        getThreadOwnership: (t: string) => Promise<unknown>;
      },
      "getThreadOwnership",
    );

    let outcome: Promise<{
      events: BaseEvent[];
      error: unknown;
      completed: boolean;
    }> | null = null;
    await withTransaction(async (holder) => {
      // deleteThread's transaction, held open.
      await holder.query(`DELETE FROM agent_runs WHERE thread_id = $1`, ["t-race"]);
      await holder.query(`DELETE FROM run_state WHERE thread_id = $1`, ["t-race"]);
      await holder.query(`DELETE FROM thread_messages WHERE thread_id = $1`, ["t-race"]);
      await holder.query(`DELETE FROM thread_metadata WHERE thread_id = $1`, ["t-race"]);
      await holder.query(
        `INSERT INTO deleted_threads (thread_id) VALUES ($1) ON CONFLICT (thread_id) DO NOTHING`,
        ["t-race"],
      );
      // The run starts INSIDE the held-delete window; the spy confirms it
      // passed the ownership check (and is now blocked at the lock).
      outcome = runAs(runner, user1, "t-race", "run-late");
      await vi.waitFor(() => expect(ownershipSpy).toHaveBeenCalled());
    });
    ownershipSpy.mockRestore();

    const result = await outcome!;
    expect((result.error as Error).message).toBe("Thread not found");

    // The holder replicates only deleteThread's SQL; its post-commit cache
    // clears are replicated here so the assertion below checks what the
    // real interleaving leaves: the run must not have re-seeded anything.
    caches(runner).threadCache.delete("t-race");
    caches(runner).messageCache.delete("t-race");
    caches(runner).eventsCache.delete("t-race");

    // The gate released the just-claimed lock row (no orphan) and nothing
    // was persisted — the delete's cleanup stands.
    const runs = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM agent_runs WHERE thread_id = 't-race'`,
    );
    const meta = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM thread_metadata WHERE thread_id = 't-race'`,
    );
    const state = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM run_state WHERE thread_id = 't-race'`,
    );
    expect(runs.rows[0]?.c).toBe(0);
    expect(meta.rows[0]?.c).toBe(0);
    expect(state.rows[0]?.c).toBe(0);
    expect(runner.listThreads().some((t) => t.id === "t-race")).toBe(false);
  });

  it("the persistence window skips writes for a tombstoned thread even without the connection marker", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // Deterministic seam for the marker-miss interleaving: the tombstone
    // is committed and NO connection marker exists — precisely the state
    // a run lands in when it registers its ACTIVE_CONNECTIONS entry after
    // deleteThread's map read. storeRun + captureThreadData are driven
    // directly (the file's established private-method pattern); a true
    // concurrent replay of that registration race would only re-derive
    // this same state.
    await query(`INSERT INTO deleted_threads (thread_id) VALUES ($1)`, ["t-tomb"]);

    const request = {
      threadId: "t-tomb",
      agent: {
        agentId: "agent-a",
        messages: [{ id: "m1", role: "user", content: "hello" }],
      },
      input: runInput("t-tomb", "run-tomb"),
    } as unknown as RunRequestShaped;

    await runWithUser(user1, () =>
      (
        runner as unknown as {
          storeRun: (
            t: string,
            r: string,
            e: BaseEvent[],
            i: ReturnType<typeof runInput>,
            p: string | null,
          ) => Promise<void>;
        }
      ).storeRun("t-tomb", "run-tomb", [], runInput("t-tomb", "run-tomb"), null),
    );
    await runWithUser(user1, () =>
      (
        runner as unknown as {
          captureThreadData: (r: RunRequestShaped) => Promise<void>;
        }
      ).captureThreadData(request),
    );

    // No rows resurrected, no caches re-seeded.
    const runs = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM agent_runs WHERE thread_id = 't-tomb'`,
    );
    const msgs = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM thread_messages WHERE thread_id = 't-tomb'`,
    );
    const meta = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM thread_metadata WHERE thread_id = 't-tomb'`,
    );
    expect(runs.rows[0]?.c).toBe(0);
    expect(msgs.rows[0]?.c).toBe(0);
    expect(meta.rows[0]?.c).toBe(0);
    expect(caches(runner).eventsCache.has("t-tomb")).toBe(false);
    expect(caches(runner).threadCache.has("t-tomb")).toBe(false);

    // Positive control: the same writes on a NON-tombstoned thread land —
    // the skip is tombstone-driven, not a broken write path.
    await runWithUser(user1, () =>
      (
        runner as unknown as {
          storeRun: (
            t: string,
            r: string,
            e: BaseEvent[],
            i: ReturnType<typeof runInput>,
            p: string | null,
          ) => Promise<void>;
        }
      ).storeRun("t-live", "run-live", [], runInput("t-live", "run-live"), null),
    );
    const live = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM agent_runs WHERE thread_id = 't-live' AND run_id = 'run-live'`,
    );
    expect(live.rows[0]?.c).toBe(1);
    // The merge into the sync readers' cache ran (rowCount 1 path).
    expect(caches(runner).eventsCache.has("t-live")).toBe(true);
  });

  it("deleteThread prunes tombstones past the retention window", async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // A tombstone older than the retention is swept by the delete
    // transaction's opportunistic prune; recent ones survive.
    await query(
      `INSERT INTO deleted_threads (thread_id, deleted_at)
       VALUES ('t-ancient', now() - interval '40 days')`,
    );
    await seedThread(runner, "t-sweep", "agent-a", "Sweep chat", user1.id);
    const deleted = await runWithUser(user1, () =>
      runner.deleteThread("t-sweep", user1.id, user1.orgId),
    );
    expect(deleted).toBe(true);

    const rows = await query<{ thread_id: string }>(
      `SELECT thread_id FROM deleted_threads`,
    );
    expect(rows.rows.map((r) => r.thread_id)).toEqual(["t-sweep"]);
  });
});

describe("PostgresAgentRunner — sync cache reads (getThreadMessages / getThreadState)", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    // No runner.clearThreads() here — it's a deliberate no-op (#99) and
    // won't isolate state between tests, so fixtures wipe PG directly via
    // awaited query() (see the stop-first suite's beforeEach for the #97
    // flake history behind that pattern).
    await runner.awaitRefreshed();
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

  it("clearThreads is a deliberate no-op — nothing deleted, nothing mutated", async () => {
    // #99: the old body cleared all 3 caches and fire-and-forget an
    // unscoped DELETE-all (clearThreadsAsync()); landing mid-run it erased
    // the live run's run_state lock row — enabling concurrent-run history
    // interleaving and wedging stop(). The interface method must now do
    // NOTHING: a global wipe has no legitimate owner in a multi-tenant DB,
    // and the only HTTP path is 403'd at the copilotkit route. Seeding a
    // thread + live lock row and asserting every row and cache entry
    // survives makes this the anti-regression guard — restore any delete
    // or cache-clear body and it fails.
    await seedThread(runner, "t-noop", "agent-a", "Keeper", user1.id);
    await query(
      `INSERT INTO run_state (thread_id, is_running, current_run_id)
       VALUES ('t-noop', true, 'run-t-noop')`,
    );
    await query(
      `INSERT INTO thread_messages (thread_id, messages)
       VALUES ($1, $2::jsonb)`,
      ["t-noop", JSON.stringify([{ id: "m1", role: "user", content: "hi" }])],
    );
    caches(runner).messageCache.set("t-noop", [
      { id: "m1", role: "user", content: "hi" } as Message,
    ]);
    caches(runner).eventsCache.set("t-noop", [
      { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1 } } as unknown as BaseEvent,
    ]);

    runner.clearThreads();

    // No cache mutation either — a cache-only clear would be equally
    // wrong: the caches are read-through from PG, so the "clear"
    // un-clears itself on the next refreshCacheFromDB().
    expect(runner.listThreads()).toHaveLength(1);
    expect(runner.getThreadMessages("t-noop")).toHaveLength(1);
    expect(runner.getThreadEvents("t-noop")).toHaveLength(1);
    expect(runner.getThreadState("t-noop")).toEqual({ step: 1 });

    // Every row of every table survives — above all the live run's lock
    // row in run_state.
    const runs = await query<{ c: number }>("SELECT count(*)::int as c FROM agent_runs");
    // The lock row verbatim — a bare-column select, not an aggregate (the
    // count(*) forms below can't carry it; pg-mem nulls bare columns).
    const lockRow = await query<{
      thread_id: string;
      is_running: boolean;
      current_run_id: string | null;
    }>("SELECT thread_id, is_running, current_run_id FROM run_state");
    const msgs = await query<{ c: number }>("SELECT count(*)::int as c FROM thread_messages");
    const meta = await query<{ c: number }>("SELECT count(*)::int as c FROM thread_metadata");
    expect(runs.rows[0]?.c).toBe(1);
    expect(lockRow.rows).toHaveLength(1);
    expect(lockRow.rows[0]).toMatchObject({
      thread_id: "t-noop",
      is_running: true,
      current_run_id: "run-t-noop",
    });
    expect(msgs.rows[0]?.c).toBe(1);
    expect(meta.rows[0]?.c).toBe(1);
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
    // No runner.clearThreads() here — it's a deliberate no-op (#99) and
    // won't isolate state between tests, so fixtures wipe PG directly via
    // awaited query() (see the stop-first suite's beforeEach for the #97
    // flake history behind that pattern).
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

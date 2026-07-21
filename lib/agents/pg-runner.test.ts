import { describe, it, expect, beforeEach } from "vitest";
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import { PostgresAgentRunner } from "./pg-runner";
import { runWithUser, type RequestUser } from "@/lib/auth/request-context";
import { query } from "@/lib/db/pg";
import { runMigrations } from "@/lib/db/migrate";

const user1: RequestUser = {
  id: "user-1",
  role: "user",
  name: "Alice",
  email: "a@test.com",
};
const user2: RequestUser = {
  id: "user-2",
  role: "user",
  name: "Bob",
  email: "b@test.com",
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
) {
  const nowIso = new Date().toISOString();
  caches(runner).threadCache.set(threadId, {
    id: threadId,
    name: title,
    agentId,
    organizationId: "",
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
    `INSERT INTO thread_metadata (thread_id, agent_id, title, user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thread_id) DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       title = EXCLUDED.title,
       user_id = EXCLUDED.user_id`,
    [threadId, agentId, title, userId],
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

    it("returns threads with empty createdById for any user (legacy threads)", () => {
      // Legacy threads have createdById === "" (null user_id in PG).
      seedThreadCache(runner, "t1", "agent-a", "Legacy chat", null);
      seedThreadCache(runner, "t2", "agent-a", "Alice's chat", user1.id);

      const threads = runWithUser(user1, () => runner.listThreads());
      expect(threads).toHaveLength(2);
    });

    it("isolates users from each other", () => {
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

      const ok = await runner.deleteThread("t1", user2.id);
      expect(ok).toBe(false);
    });

    it("allows deletion of legacy threads (null user_id → createdById=''", async () => {
      await seedThread(runner, "t1", "agent-a", "Legacy chat", null);

      const ok = await runner.deleteThread("t1", user1.id);
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

      const ok = await runner.deleteThread("t1", user1.id);
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
        `INSERT INTO thread_metadata (thread_id, agent_id, title, user_id)
         VALUES ($1, $2, $3, $4)`,
        ["t-ghost", "agent-a", "Ghost", user1.id],
      );

      const ok = await runner.deleteThread("t-ghost", user1.id);
      expect(ok).toBe(false);
    });
  });

  describe("renameThread", () => {
    it("allows owner to rename their thread", async () => {
      await seedThread(runner, "t1", "agent-a", "Old title", user1.id);

      const ok = await runner.renameThread("t1", "New title", user1.id);
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

      const ok = await runner.renameThread("t1", "Hacked", user2.id);
      expect(ok).toBe(false);
      expect(runner.listThreads()[0].name).toBe("Alice's chat");
    });

    it("allows renaming legacy threads (null user_id)", async () => {
      await seedThread(runner, "t1", "agent-a", "Legacy", null);

      const ok = await runner.renameThread("t1", "Renamed", user1.id);
      expect(ok).toBe(true);
    });

    it("allows renaming without user context (backwards compat)", async () => {
      await seedThread(runner, "t1", "agent-a", "Old title", user1.id);

      const ok = await runner.renameThread("t1", "New title");
      expect(ok).toBe(true);
    });
  });
});

describe("PostgresAgentRunner — connect() smart replay", () => {
  let runner: PostgresAgentRunner;

  beforeEach(async () => {
    runner = makeRunner();
    await runner.awaitRefreshed();
    runner.clearThreads();
  });

  // connect() calls getHistoricRuns() — a `WITH RECURSIVE` CTE walking
  // the parent_run_id chain. pg-mem's parser doesn't support
  // `WITH RECURSIVE`, so these can only run against real Postgres (via
  // testcontainers — planned integration suite, see AGENTS.md). The
  // connect() smart-replay logic (RUN_ERROR filtering, STATE_*
  // preservation, live-bridging) is exercised end-to-end by the manual
  // smoke test in AGENTS.md.

  it.skip("replays events from agent_runs, filtering out RUN_ERROR", async () => {
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

  it.skip("preserves STATE_* events (intermediate events not lost)", async () => {
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

  it.skip("completes immediately (no live-bridging) when no run is in flight", async () => {
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

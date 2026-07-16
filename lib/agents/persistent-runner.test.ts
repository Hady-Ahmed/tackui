import { describe, it, expect, beforeEach } from "vitest";
import { PersistentAgentRunner } from "./persistent-runner";
import { runWithUser, type RequestUser } from "@/lib/auth/request-context";

const user1: RequestUser = { id: "user-1", role: "user", name: "Alice", email: "a@test.com" };
const user2: RequestUser = { id: "user-2", role: "user", name: "Bob", email: "b@test.com" };

function makeRunner() {
  return new PersistentAgentRunner({ dbPath: ":memory:" });
}

function seedThread(
  runner: PersistentAgentRunner,
  threadId: string,
  agentId: string,
  title: string,
  userId: string | null,
) {
  const db = (runner as unknown as { database: import("better-sqlite3").Database }).database;
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO thread_metadata (thread_id, agent_id, title, updated_at, user_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(threadId, agentId, title, now, userId);
  db.prepare(
    `INSERT OR REPLACE INTO agent_runs (thread_id, run_id, parent_run_id, events, input, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(threadId, `run-${threadId}`, null, "[]", "{}", now, 1);
}

describe("PersistentAgentRunner — thread scoping", () => {
  let runner: PersistentAgentRunner;

  beforeEach(() => {
    runner = makeRunner();
    runner.clearThreads();
  });

  describe("listThreads", () => {
    it("returns only threads belonging to the current user via ALS", () => {
      seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);
      seedThread(runner, "t2", "agent-a", "Bob's chat", user2.id);

      const threads = runWithUser(user1, () => runner.listThreads());
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe("t1");
      expect(threads[0].createdById).toBe(user1.id);
    });

    it("returns all threads when no ALS context is set", () => {
      seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);
      seedThread(runner, "t2", "agent-a", "Bob's chat", user2.id);

      const threads = runner.listThreads();
      expect(threads).toHaveLength(2);
    });

    it("returns threads with null user_id for any user (legacy threads)", () => {
      seedThread(runner, "t1", "agent-a", "Legacy chat", null);
      seedThread(runner, "t2", "agent-a", "Alice's chat", user1.id);

      const threads = runWithUser(user1, () => runner.listThreads());
      expect(threads).toHaveLength(2);
    });

    it("isolates users from each other", () => {
      seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);
      seedThread(runner, "t2", "agent-a", "Bob's chat", user2.id);

      const aliceThreads = runWithUser(user1, () => runner.listThreads());
      const bobThreads = runWithUser(user2, () => runner.listThreads());

      expect(aliceThreads).toHaveLength(1);
      expect(aliceThreads[0].id).toBe("t1");
      expect(bobThreads).toHaveLength(1);
      expect(bobThreads[0].id).toBe("t2");
    });
  });

  describe("deleteThread", () => {
    it("allows owner to delete their thread", () => {
      seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = runWithUser(user1, () => runner.deleteThread("t1"));
      expect(ok).toBe(true);
    });

    it("prevents non-owner from deleting via ALS", () => {
      seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = runWithUser(user2, () => runner.deleteThread("t1"));
      expect(ok).toBe(false);
    });

    it("prevents non-owner from deleting via explicit userId param", () => {
      seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = runner.deleteThread("t1", user2.id);
      expect(ok).toBe(false);
    });

    it("allows deletion of legacy threads (null user_id)", () => {
      seedThread(runner, "t1", "agent-a", "Legacy chat", null);

      const ok = runner.deleteThread("t1", user1.id);
      expect(ok).toBe(true);
    });

    it("allows deletion without user context (backwards compat)", () => {
      seedThread(runner, "t1", "agent-a", "Chat", user1.id);

      const ok = runner.deleteThread("t1");
      expect(ok).toBe(true);
    });
  });

  describe("renameThread", () => {
    it("allows owner to rename their thread", () => {
      seedThread(runner, "t1", "agent-a", "Old title", user1.id);

      const ok = runner.renameThread("t1", "New title", user1.id);
      expect(ok).toBe(true);
    });

    it("prevents non-owner from renaming", () => {
      seedThread(runner, "t1", "agent-a", "Alice's chat", user1.id);

      const ok = runner.renameThread("t1", "Hacked", user2.id);
      expect(ok).toBe(false);
    });

    it("allows renaming legacy threads (null user_id)", () => {
      seedThread(runner, "t1", "agent-a", "Legacy", null);

      const ok = runner.renameThread("t1", "Renamed", user1.id);
      expect(ok).toBe(true);
    });

    it("allows renaming without user context (backwards compat)", () => {
      seedThread(runner, "t1", "agent-a", "Old title", user1.id);

      const ok = runner.renameThread("t1", "New title");
      expect(ok).toBe(true);
    });
  });
});

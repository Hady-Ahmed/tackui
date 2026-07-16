import { SqliteAgentRunner } from "@copilotkit/sqlite-runner";
import { compactEvents, EventType } from "@ag-ui/client";
import type { BaseEvent, Message } from "@ag-ui/core";
import type { Observable } from "rxjs";
import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { addColumnIfMissing } from "@/lib/db/migrations";
import { getRunnerUser } from "@/lib/auth/request-context";

interface ThreadSummary {
  id: string;
  name: string | null;
  agentId: string;
  organizationId: string;
  createdById: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RunRequest {
  threadId: string;
  agent: {
    agentId?: string;
    messages: Message[];
  };
  input: {
    runId: string;
    messages: Message[];
  };
}

export class PersistentAgentRunner extends SqliteAgentRunner {
  ɵsupportsLocalThreadEndpoints = true as const;

  private get database(): Database.Database {
    return (this as unknown as { db: Database.Database }).db;
  }

  constructor(options?: { dbPath?: string }) {
    const dbPath = options?.dbPath;
    if (dbPath && dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    super(options);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS thread_messages (
        thread_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS thread_metadata (
        thread_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        title TEXT,
        updated_at INTEGER NOT NULL,
        user_id TEXT,
        org_id TEXT
      )
    `);
    addColumnIfMissing(this.database, "thread_metadata", "user_id", "TEXT");
    addColumnIfMissing(this.database, "thread_metadata", "org_id", "TEXT");
  }

  override run(request: RunRequest): Observable<BaseEvent> {
    const observable = super.run(request as Parameters<SqliteAgentRunner["run"]>[0]);

    observable.subscribe({
      complete: () => this.captureThreadData(request),
      error: () => this.captureThreadData(request),
    });

    return observable;
  }

  private captureThreadData(request: RunRequest): void {
    const agentId = request.agent.agentId ?? "default";
    const messages = request.agent.messages;
    const userId = getRunnerUser()?.id ?? null;

    if (messages && messages.length > 0) {
      this.database
        .prepare(
          `INSERT OR REPLACE INTO thread_messages (thread_id, messages, created_at) VALUES (?, ?, ?)`,
        )
        .run(request.threadId, JSON.stringify(messages), Date.now());
    }

    const existing = this.database
      .prepare(`SELECT title, user_id FROM thread_metadata WHERE thread_id = ?`)
      .get(request.threadId) as { title: string | null; user_id: string | null } | undefined;

    const title = existing?.title ?? this.deriveTitle(messages);
    const effectiveUserId = existing?.user_id ?? userId;

    this.database
      .prepare(
        `INSERT OR REPLACE INTO thread_metadata (thread_id, agent_id, title, updated_at, user_id) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(request.threadId, agentId, title, Date.now(), effectiveUserId);
  }

  private deriveTitle(messages: Message[]): string | null {
    const firstUser = messages.find((m) => m.role === "user");
    const content =
      typeof firstUser?.content === "string" ? firstUser.content : null;
    if (!content) return null;
    return content.length > 50 ? content.slice(0, 50) + "..." : content;
  }

  listThreads(): ThreadSummary[] {
    const user = getRunnerUser();
    const userId = user?.id;

    const rows = userId
      ? (this.database
          .prepare(
            `SELECT
               ar.thread_id,
               MIN(ar.created_at) as first_created,
               MAX(ar.created_at) as last_created,
               tm.agent_id,
               tm.title,
               tm.user_id
             FROM agent_runs ar
             LEFT JOIN thread_metadata tm ON ar.thread_id = tm.thread_id
             WHERE tm.user_id = ? OR tm.user_id IS NULL
             GROUP BY ar.thread_id
             ORDER BY last_created DESC`,
          )
          .all(userId) as {
          thread_id: string;
          first_created: number;
          last_created: number;
          agent_id: string | null;
          title: string | null;
          user_id: string | null;
        }[])
      : (this.database
          .prepare(
            `SELECT
               ar.thread_id,
               MIN(ar.created_at) as first_created,
               MAX(ar.created_at) as last_created,
               tm.agent_id,
               tm.title,
               tm.user_id
             FROM agent_runs ar
             LEFT JOIN thread_metadata tm ON ar.thread_id = tm.thread_id
             GROUP BY ar.thread_id
             ORDER BY last_created DESC`,
          )
          .all() as {
          thread_id: string;
          first_created: number;
          last_created: number;
          agent_id: string | null;
          title: string | null;
          user_id: string | null;
        }[]);

    return rows
      .filter((row) => !userId || row.user_id === userId || row.user_id === null)
      .map((row) => ({
        id: row.thread_id,
        name: row.title,
        agentId: row.agent_id ?? "default",
        organizationId: "",
        createdById: row.user_id ?? "",
        archived: false,
        createdAt: new Date(row.first_created).toISOString(),
        updatedAt: new Date(row.last_created).toISOString(),
      }));
  }

  getThreadMessages(threadId: string): Message[] {
    const row = this.database
      .prepare(`SELECT messages FROM thread_messages WHERE thread_id = ?`)
      .get(threadId) as { messages: string } | undefined;

    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    const historicRuns = (
      this as unknown as {
        getHistoricRuns: (threadId: string) => { events: BaseEvent[] }[];
      }
    ).getHistoricRuns(threadId);

    const all: BaseEvent[] = [];
    for (const run of historicRuns) all.push(...run.events);
    return compactEvents(all);
  }

  getThreadState(threadId: string): unknown {
    const events = this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === EventType.STATE_SNAPSHOT) {
        const snapshot = (event as { snapshot?: unknown }).snapshot;
        if (snapshot && typeof snapshot === "object") return snapshot;
        return null;
      }
    }
    return null;
  }

  clearThreads(): void {
    this.database.prepare("DELETE FROM agent_runs").run();
    this.database.prepare("DELETE FROM run_state").run();
    this.database.prepare("DELETE FROM thread_messages").run();
    this.database.prepare("DELETE FROM thread_metadata").run();
  }

  deleteThread(threadId: string, userId?: string): boolean {
    const uid = userId ?? getRunnerUser()?.id;
    if (uid) {
      const owned = this.database
        .prepare(
          `SELECT thread_id FROM thread_metadata WHERE thread_id = ? AND (user_id = ? OR user_id IS NULL)`,
        )
        .get(threadId, uid);
      if (!owned) return false;
    }

    const r1 = this.database
      .prepare("DELETE FROM agent_runs WHERE thread_id = ?")
      .run(threadId);
    this.database
      .prepare("DELETE FROM run_state WHERE thread_id = ?")
      .run(threadId);
    this.database
      .prepare("DELETE FROM thread_messages WHERE thread_id = ?")
      .run(threadId);
    const r4 = this.database
      .prepare("DELETE FROM thread_metadata WHERE thread_id = ?")
      .run(threadId);
    return r1.changes > 0 || r4.changes > 0;
  }

  renameThread(threadId: string, title: string, userId?: string): boolean {
    const uid = userId ?? getRunnerUser()?.id;
    if (uid) {
      const owned = this.database
        .prepare(
          `SELECT thread_id FROM thread_metadata WHERE thread_id = ? AND (user_id = ? OR user_id IS NULL)`,
        )
        .get(threadId, uid);
      if (!owned) return false;
    }

    const result = this.database
      .prepare(
        `UPDATE thread_metadata SET title = ?, updated_at = ? WHERE thread_id = ?`,
      )
      .run(title, Date.now(), threadId);
    return result.changes > 0;
  }
}

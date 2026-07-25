import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject } from "rxjs";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  RunStartedEvent,
  compactEvents,
} from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { query, withTransaction } from "@/lib/db/pg";
import { getRunnerUser } from "@/lib/auth/request-context";

interface AgentRunRecord {
  id: number;
  thread_id: string;
  run_id: string;
  parent_run_id: string | null;
  events: BaseEvent[];
  input: RunAgentInput;
  created_at: Date;
  version: number;
}

interface ActiveConnectionContext {
  subject: ReplaySubject<BaseEvent>;
  agent?: AbstractAgent;
  runSubject?: ReplaySubject<BaseEvent>;
  currentEvents?: BaseEvent[];
  stopRequested?: boolean;
}

// Active connections for streaming events and stop support. Owned by this
// module (replaces the module-private ACTIVE_CONNECTIONS that was inaccessible
// in @copilotkit/sqlite-runner, which forced the old PersistentAgentRunner to
// reach into the parent's private `db` field via a TS escape hatch).
const ACTIVE_CONNECTIONS = new Map<string, ActiveConnectionContext>();

const SCHEMA_VERSION = 1;

/**
 * Postgres-backed AgentRunner. Replaces @copilotkit/sqlite-runner's
 * SqliteAgentRunner for this app — speaks to the same `pg.Pool` that
 * Better Auth and the agent store use (see lib/db/pg.ts).
 *
 * Schema lives in lib/db/migrations/0001_init.sql (tables: agent_runs,
 * run_state, thread_messages, thread_metadata). Tables are created by
 * `npm run migrate` — the runner does not own schema creation.
 *
 * `connect()` uses smart replay: filters RUN_ERROR events from the raw
 * event stream before compacting. This sidesteps the AG-UI verifier lock
 * bug documented in AGENTS.md ("Thread history recovery on revisit")
 * while preserving all other event types (messages, tool calls,
 * STATE_*, REASONING_*, STEP_*). Live-bridging to an in-flight run via
 * ACTIVE_CONNECTIONS is preserved.
 *
 * ─── In-memory cache (sync interface bridge) ──────────────────────────
 * CopilotKit's `LocalThreadEndpointRunner` interface requires the 5
 * thread methods (`listThreads`, `getThreadMessages`, `getThreadEvents`,
 * `getThreadState`, `clearThreads`) to be SYNCHRONOUS — they return
 * concrete values, not Promises. But `pg` is async-only.
 *
 * We bridge this with 3 in-memory Maps (`threadCache`, `messageCache`,
 * `eventsCache`) that act as a read-through cache. PG is always the
 * source of truth:
 *   1. Write paths update PG FIRST, then the cache (write-through).
 *   2. Async paths (`connect`, `run`) fetch from PG INTO the cache
 *      before completing (read-through on async paths).
 *   3. Sync methods read cache ONLY — no DB I/O.
 *
 * Single-instance deployments (OSS self-hosters, solo mode) have no
 * staleness — every write updates the local cache synchronously after
 * the DB write.
 *
 * ╳  MULTI-INSTANCE SAAS CAVEAT  ╳
 * For multi-instance SaaS deployments (horizontal scaling), each
 * instance has its OWN in-memory cache. A thread created on instance A
 * won't appear in instance B's cache until B refreshes from PG (on the
 * next `connect()`/`run()` for that thread, or on restart).
 *
 * FUTURE: when multi-instance SaaS is real, replace the in-memory `Map`s
 * with a shared cache (Redis is the natural choice). The interface stays
 * the same — `threadCache.get(id)` becomes `await redis.get(id)` wrapped
 * in a sync wrapper, or (better) CopilotKit v2.x may ship an async
 * `LocalThreadEndpointRunner` variant by then. Alternatives:
 *   - PG LISTEN/NOTIFY for cross-instance invalidation
 *   - Polling refresh on a timer (e.g. every 5s)
 *   - Sticky sessions at the load balancer (user always hits same instance)
 *
 * See AGENTS.md "In-memory cache" section for the full design notes.
 */
export class PostgresAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;

  // ─── In-memory caches (see class doc for design) ──────────────────────
  //
  // Read by the sync LocalThreadEndpointRunner methods. Written by the
  // async helpers below. PG remains the source of truth.
  private threadCache = new Map<string, LocalThreadEndpointRecord>();
  private messageCache = new Map<string, Message[]>();
  private eventsCache = new Map<string, BaseEvent[]>();

  // Promise from the constructor's fire-and-forget refreshCacheFromDB().
  // Tests await this to avoid a race where the refresh overwrites cache
  // state seeded by the test. Production code never needs to await this —
  // the first connect()/run() repopulates the cache from PG anyway.
  private refreshPromise: Promise<void>;

  constructor() {
    super();
    // Fire-and-forget — first request after boot may see empty caches,
    // but useThreads refetches on window focus and on run completion.
    // The sidebar already shows "Loading..." while waiting.
    this.refreshPromise = this.refreshCacheFromDB().catch((err) => {
      console.error("[runner] initial cache load failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Wait for the constructor's fire-and-forget cache refresh to complete.
   * Only needed in tests to avoid races between the async refresh and
   * direct cache seeding. Production code never needs to call this —
   * the first connect()/run() repopulates the cache from PG.
   */
  async awaitRefreshed(): Promise<void> {
    await this.refreshPromise;
  }

  // ─── AgentRunner: 4 abstract methods ──────────────────────────────────

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    // We need to do async setup before returning the Observable. The cleanest
    // pattern: create the runSubject up front, kick off the async work
    // fire-and-forget, return the subject asObservable().
    const runSubject = new ReplaySubject<BaseEvent>(Infinity);
    this.startRun(request, runSubject).catch((err) => {
      runSubject.error(err);
    });
    return runSubject.asObservable();
  }

  private async startRun(
    request: AgentRunnerRunRequest,
    runSubject: ReplaySubject<BaseEvent>,
  ): Promise<void> {
    // Check + mark running atomically (avoids race where two concurrent runs
    // both see "not running" and both proceed).
    const runState = await this.getRunState(request.threadId);
    if (runState.isRunning) {
      throw new Error("Thread already running");
    }
    await this.setRunState(request.threadId, true, request.input.runId);

    const seenMessageIds = new Set<string>();
    const currentRunEvents: BaseEvent[] = [];

    const historicRuns = await this.getHistoricRuns(request.threadId);
    const historicMessageIds = new Set<string>();
    for (const run of historicRuns) {
      for (const event of run.events) {
        if ("messageId" in event && typeof event.messageId === "string") {
          historicMessageIds.add(event.messageId);
        }
        if (event.type === EventType.RUN_STARTED) {
          const runStarted = event as RunStartedEvent;
          const messages = runStarted.input?.messages ?? [];
          for (const message of messages) {
            historicMessageIds.add(message.id);
          }
        }
      }
    }

    const nextSubject = new ReplaySubject<BaseEvent>(Infinity);
    const prevConnection = ACTIVE_CONNECTIONS.get(request.threadId);
    const prevSubject = prevConnection?.subject;

    ACTIVE_CONNECTIONS.set(request.threadId, {
      subject: nextSubject,
      agent: request.agent,
      runSubject,
      currentEvents: currentRunEvents,
      stopRequested: false,
    });

    const runAgent = async () => {
      const parentRunId = await this.getLatestRunId(request.threadId);
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            let processedEvent: BaseEvent = event;
            if (event.type === EventType.RUN_STARTED) {
              const runStartedEvent = event as RunStartedEvent;
              if (!runStartedEvent.input) {
                const sanitizedMessages = request.input.messages
                  ? request.input.messages.filter(
                      (message) => !historicMessageIds.has(message.id),
                    )
                  : undefined;
                const updatedInput = {
                  ...request.input,
                  ...(sanitizedMessages !== undefined
                    ? { messages: sanitizedMessages }
                    : {}),
                };
                processedEvent = {
                  ...runStartedEvent,
                  input: updatedInput,
                } as RunStartedEvent;
              }
            }

            runSubject.next(processedEvent);
            nextSubject.next(processedEvent);
            currentRunEvents.push(processedEvent);
          },
          onNewMessage: ({ message }) => {
            if (!seenMessageIds.has(message.id)) {
              seenMessageIds.add(message.id);
            }
          },
          onRunStartedEvent: () => {
            if (request.input.messages) {
              for (const message of request.input.messages) {
                if (!seenMessageIds.has(message.id)) {
                  seenMessageIds.add(message.id);
                }
              }
            }
          },
        });

        const connection = ACTIVE_CONNECTIONS.get(request.threadId);
        const appendedEvents = finalizeRunEvents(currentRunEvents, {
          stopRequested: connection?.stopRequested ?? false,
        });
        for (const event of appendedEvents) {
          runSubject.next(event);
          nextSubject.next(event);
        }

        await this.storeRun(
          request.threadId,
          request.input.runId,
          currentRunEvents,
          request.input,
          parentRunId,
        );
        await this.setRunState(request.threadId, false);

        await this.captureThreadData(request);

        if (connection) {
          connection.agent = undefined;
          connection.runSubject = undefined;
          connection.currentEvents = undefined;
          connection.stopRequested = false;
        }

        runSubject.complete();
        nextSubject.complete();
        ACTIVE_CONNECTIONS.delete(request.threadId);
      } catch (err) {
        console.error("[runner] run failed", {
          agentId: request.agent.agentId ?? "default",
          threadId: request.threadId,
          runId: request.input?.runId,
          error: err instanceof Error ? err.message : String(err),
        });

        const connection = ACTIVE_CONNECTIONS.get(request.threadId);
        const appendedEvents = finalizeRunEvents(currentRunEvents, {
          stopRequested: connection?.stopRequested ?? false,
        });
        for (const event of appendedEvents) {
          runSubject.next(event);
          nextSubject.next(event);
        }

        if (currentRunEvents.length > 0) {
          await this.storeRun(
            request.threadId,
            request.input.runId,
            currentRunEvents,
            request.input,
            parentRunId,
          );
        }
        await this.setRunState(request.threadId, false);

        // Even on failure, capture the thread snapshot so the conversation
        // is still readable on reconnect (the connect() smart replay filters
        // out RUN_ERROR events before replaying).
        await this.captureThreadData(request);

        if (connection) {
          connection.agent = undefined;
          connection.runSubject = undefined;
          connection.currentEvents = undefined;
          connection.stopRequested = false;
        }

        runSubject.complete();
        nextSubject.complete();
        ACTIVE_CONNECTIONS.delete(request.threadId);
      }
    };

    // Bridge previous events if a prior subject exists (e.g. reconnect
    // during an in-flight run on the same thread).
    if (prevSubject) {
      prevSubject.subscribe({
        next: (e) => nextSubject.next(e),
        error: (err) => nextSubject.error(err),
        complete: () => {
          // Don't complete nextSubject here — it stays open for new events.
        },
      });
    }

    // Fire-and-forget. Errors are caught internally and logged.
    runAgent().catch((err) => {
      console.error("[runner] runAgent unexpected error", {
        threadId: request.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    // The AgentRunner contract expects a sync Observable return. We do
    // async DB work inside startConnect(), fired fire-and-forget — same
    // pattern as run(). The subject receives events once the async work
    // resolves.
    const connectionSubject = new ReplaySubject<BaseEvent>(Infinity);
    this.startConnect(request, connectionSubject).catch((err) => {
      connectionSubject.error(err);
    });
    return connectionSubject.asObservable();
  }

  private async startConnect(
    request: AgentRunnerConnectRequest,
    connectionSubject: ReplaySubject<BaseEvent>,
  ): Promise<void> {
    // ─── Smart replay: filter RUN_ERROR events before compacting ─────
    // AG-UI's verifier locks when it sees a RUN_ERROR mid-stream, which
    // makes failed-run threads permanently unreadable on reconnect (the
    // bug documented in AGENTS.md "Thread history recovery on revisit").
    // Filtering RUN_ERROR out before compactEvents sidesteps the lock
    // while preserving all other event types (messages, tool calls,
    // STATE_*, REASONING_*, STEP_*).
    const historicRuns = await this.getHistoricRuns(request.threadId);
    const allHistoricEvents: BaseEvent[] = [];
    for (const run of historicRuns) {
      for (const event of run.events) {
        if (event.type === EventType.RUN_ERROR) continue;
        allHistoricEvents.push(event);
      }
    }
    const compactedEvents = compactEvents(allHistoricEvents);

    // ─── Read-through: populate caches from the PG fetch ──────────────
    // The sync LocalThreadEndpointRunner methods (getThreadEvents,
    // getThreadState) read from these caches. Future calls within the
    // same process get sync access to the historic event stream.
    this.eventsCache.set(request.threadId, compactedEvents);
    const messages = await this.fetchThreadMessages(request.threadId);
    if (messages.length > 0) this.messageCache.set(request.threadId, messages);

    const emittedMessageIds = new Set<string>();
    for (const event of compactedEvents) {
      connectionSubject.next(event);
      if ("messageId" in event && typeof event.messageId === "string") {
        emittedMessageIds.add(event.messageId);
      }
    }

    // ─── Live-bridging: if a run is in flight, stream new events ──────
    const activeConnection = ACTIVE_CONNECTIONS.get(request.threadId);
    const runState = await this.getRunState(request.threadId);

    if (
      activeConnection &&
      (runState.isRunning || activeConnection.stopRequested)
    ) {
      activeConnection.subject.subscribe({
        next: (event) => {
          // Skip message events we already emitted from historic replay.
          if (
            "messageId" in event &&
            typeof event.messageId === "string" &&
            emittedMessageIds.has(event.messageId)
          ) {
            return;
          }
          connectionSubject.next(event);
        },
        complete: () => connectionSubject.complete(),
        error: (err) => connectionSubject.error(err),
      });
    } else {
      connectionSubject.complete();
    }
  }

  async isRunning(
    request: AgentRunnerIsRunningRequest,
  ): Promise<boolean> {
    const runState = await this.getRunState(request.threadId);
    return runState.isRunning;
  }

  async stop(
    request: AgentRunnerStopRequest,
  ): Promise<boolean | undefined> {
    const runState = await this.getRunState(request.threadId);
    if (!runState.isRunning) return false;

    const connection = ACTIVE_CONNECTIONS.get(request.threadId);
    const agent = connection?.agent;
    if (!connection || !agent) return false;
    if (connection.stopRequested) return false;

    connection.stopRequested = true;
    await this.setRunState(request.threadId, false);

    try {
      agent.abortRun();
      return true;
    } catch (error) {
      console.error("Failed to abort agent run", error);
      connection.stopRequested = false;
      await this.setRunState(request.threadId, true, runState.currentRunId ?? undefined);
      return false;
    }
  }

  // ─── LocalThreadEndpointRunner: 5 SYNC methods ────────────────────────
  //
  // These methods are called WITHOUT await by CopilotKit's runtime (see
  // node_modules/@copilotkit/runtime/.../handlers/intelligence/threads.mjs).
  // They MUST return synchronously. They read from the in-memory caches
  // populated by the async helpers below + captureThreadData + startConnect.

  listThreads(): LocalThreadEndpointRecord[] {
    const user = getRunnerUser();
    const userId = user?.id;
    const orgId = user?.orgId;
    const all = Array.from(this.threadCache.values());
    if (!userId) return all;
    // Filter at read time — the cache contains threads across orgs.
    // Scope by orgId (required, never null) + allow ownership of own
    // threads. Platform admins do NOT bypass this filter — they see only
    // their own threads in their active org, same as everyone else. Admin
    // powers are limited to agent/user management, not thread browsing.
    return all.filter(
      (t) =>
        (t.organizationId === orgId || t.organizationId === "") &&
        (t.createdById === userId || t.createdById === ""),
    );
  }

  getThreadMessages(threadId: string): Message[] {
    return this.messageCache.get(threadId) ?? [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    return this.eventsCache.get(threadId) ?? [];
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.eventsCache.get(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === EventType.STATE_SNAPSHOT) {
        const snapshot = (event as { snapshot?: unknown }).snapshot;
        if (snapshot && typeof snapshot === "object") {
          return snapshot as Record<string, unknown>;
        }
        return null;
      }
    }
    return null;
  }

  clearThreads(): void {
    // Sync cache clear — the user sees an empty sidebar immediately.
    this.threadCache.clear();
    this.messageCache.clear();
    this.eventsCache.clear();
    // Fire-and-forget the DB delete. If it fails, PG still has the rows
    // and they'll reappear on the next refreshCacheFromDB() (e.g. on
    // server restart). Trade-off: brief cache/DB inconsistency is
    // acceptable for a clearThreads() call (admin-only operation).
    this.clearThreadsAsync().catch((err) => {
      console.error("[runner] clearThreads DB delete failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ─── Async cache helpers (called from async paths) ────────────────────

  private async refreshCacheFromDB(): Promise<void> {
    // Load all threads + messages from PG into caches. Used on construction
    // and could be called on a timer for multi-instance refresh (future).
    const result = await query<{
      thread_id: string;
      first_created: Date;
      last_created: Date;
      agent_id: string | null;
      title: string | null;
      user_id: string | null;
      org_id: string | null;
    }>(`SELECT
           ar.thread_id,
           ar.first_created,
           ar.last_created,
           tm.agent_id,
           tm.title,
           tm.user_id,
           tm.org_id
         FROM (
           SELECT thread_id, MIN(created_at) AS first_created, MAX(created_at) AS last_created
           FROM agent_runs
           GROUP BY thread_id
         ) ar
         LEFT JOIN thread_metadata tm ON ar.thread_id = tm.thread_id
         ORDER BY ar.last_created DESC`);

    this.threadCache.clear();
    this.messageCache.clear();
    for (const row of result.rows) {
      this.threadCache.set(row.thread_id, {
        id: row.thread_id,
        name: row.title,
        agentId: row.agent_id ?? "default",
        organizationId: row.org_id ?? "",
        createdById: row.user_id ?? "",
        archived: false,
        createdAt: new Date(row.first_created).toISOString(),
        updatedAt: new Date(row.last_created).toISOString(),
      });
      // Messages are loaded lazily by startConnect() — only fetch them
      // here if they're cheap. For now, leave messageCache empty until
      // a connect() or captureThreadData() populates it.
    }
  }

  private async fetchThreadMessages(threadId: string): Promise<Message[]> {
    const result = await query<{ messages: Message[] }>(
      `SELECT messages FROM thread_messages WHERE thread_id = $1`,
      [threadId],
    );
    return result.rows[0]?.messages ?? [];
  }

  private async clearThreadsAsync(): Promise<void> {
    await withTransaction(async (client) => {
      await client.query("DELETE FROM agent_runs");
      await client.query("DELETE FROM run_state");
      await client.query("DELETE FROM thread_messages");
      await client.query("DELETE FROM thread_metadata");
    });
  }

  // ─── Thread mutations (used by /api/threads/[id] route) ───────────────

  async deleteThread(threadId: string, userId?: string, orgId?: string): Promise<boolean> {
    const uid = userId ?? getRunnerUser()?.id;
    const oid = orgId ?? getRunnerUser()?.orgId;
    if (uid) {
      // Ownership check reads from cache (sync) — the cache is the
      // source of truth for what this process can see. If a thread
      // exists in PG but not in this process's cache (e.g. created on
      // another instance), the ownership check fails. For single-instance
      // OSS deploys, this is fine. For multi-instance SaaS, see the
      // class doc on the future Redis migration.
      //
      // Platform admins do NOT bypass this check — they can only delete
      // their own threads, same as everyone else. Admin powers are
      // limited to agent/user management, not thread management.
      const cached = this.threadCache.get(threadId);
      if (!cached) return false;
      // Owner OR org-mate (same org can manage each other's threads).
      if (cached.createdById !== uid && cached.createdById !== "" && cached.organizationId !== oid) return false;
    }

    let deleted = false;
    await withTransaction(async (client) => {
      const r1 = await client.query(
        `DELETE FROM agent_runs WHERE thread_id = $1`,
        [threadId],
      );
      await client.query(`DELETE FROM run_state WHERE thread_id = $1`, [threadId]);
      await client.query(
        `DELETE FROM thread_messages WHERE thread_id = $1`,
        [threadId],
      );
      const r4 = await client.query(
        `DELETE FROM thread_metadata WHERE thread_id = $1`,
        [threadId],
      );
      deleted = (r1.rowCount ?? 0) > 0 || (r4.rowCount ?? 0) > 0;
    });

    // Write-through: PG delete succeeded, now update the cache.
    if (deleted) {
      this.threadCache.delete(threadId);
      this.messageCache.delete(threadId);
      this.eventsCache.delete(threadId);
    }
    return deleted;
  }

  async renameThread(
    threadId: string,
    title: string,
    userId?: string,
    orgId?: string,
  ): Promise<boolean> {
    const uid = userId ?? getRunnerUser()?.id;
    const oid = orgId ?? getRunnerUser()?.orgId;
    if (uid) {
      const cached = this.threadCache.get(threadId);
      if (!cached) return false;
      if (cached.createdById !== uid && cached.createdById !== "" && cached.organizationId !== oid) return false;
    }

    const result = await query(
      `UPDATE thread_metadata SET title = $1, updated_at = now() WHERE thread_id = $2`,
      [title, threadId],
    );
    const updated = (result.rowCount ?? 0) > 0;

    // Write-through: update the cache entry's name + updatedAt.
    if (updated) {
      const cached = this.threadCache.get(threadId);
      if (cached) {
        this.threadCache.set(threadId, {
          ...cached,
          name: title,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return updated;
  }

  // ─── Private DB helpers (mirror SqliteAgentRunner internals) ──────────

  private async storeRun(
    threadId: string,
    runId: string,
    events: BaseEvent[],
    input: RunAgentInput,
    parentRunId?: string | null,
  ): Promise<void> {
    const compactedEvents = compactEvents(events);
    await query(
      `INSERT INTO agent_runs (thread_id, run_id, parent_run_id, events, input, version)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        threadId,
        runId,
        parentRunId ?? null,
        JSON.stringify(compactedEvents),
        JSON.stringify(input),
        SCHEMA_VERSION,
      ],
    );
  }

  private async getHistoricRuns(threadId: string): Promise<AgentRunRecord[]> {
    // Recursive CTE walks the parent_run_id chain — portable SQL, works
    // unchanged on PG (originally from SqliteAgentRunner).
    const result = await query<{
      id: number;
      thread_id: string;
      run_id: string;
      parent_run_id: string | null;
      events: BaseEvent[];
      input: RunAgentInput;
      created_at: Date;
      version: number;
    }>(
      `WITH RECURSIVE run_chain AS (
         SELECT * FROM agent_runs
         WHERE thread_id = $1 AND parent_run_id IS NULL
         UNION ALL
         SELECT ar.* FROM agent_runs ar
         INNER JOIN run_chain rc ON ar.parent_run_id = rc.run_id
         WHERE ar.thread_id = $1
       )
       SELECT * FROM run_chain ORDER BY created_at ASC`,
      [threadId],
    );
    return result.rows;
  }

  private async getLatestRunId(threadId: string): Promise<string | null> {
    const result = await query<{ run_id: string }>(
      `SELECT run_id FROM agent_runs
       WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [threadId],
    );
    return result.rows[0]?.run_id ?? null;
  }

  private async setRunState(
    threadId: string,
    isRunning: boolean,
    runId?: string,
  ): Promise<void> {
    await query(
      `INSERT INTO run_state (thread_id, is_running, current_run_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (thread_id) DO UPDATE SET
         is_running = EXCLUDED.is_running,
         current_run_id = EXCLUDED.current_run_id,
         updated_at = EXCLUDED.updated_at`,
      [threadId, isRunning, runId ?? null],
    );
  }

  private async getRunState(threadId: string): Promise<{
    isRunning: boolean;
    currentRunId: string | null;
  }> {
    const result = await query<{ is_running: boolean; current_run_id: string | null }>(
      `SELECT is_running, current_run_id FROM run_state WHERE thread_id = $1`,
      [threadId],
    );
    return {
      isRunning: result.rows[0]?.is_running ?? false,
      currentRunId: result.rows[0]?.current_run_id ?? null,
    };
  }

  // ─── Thread snapshot capture (preserved from PersistentAgentRunner) ────

  private async captureThreadData(request: AgentRunnerRunRequest): Promise<void> {
    const agentId = request.agent.agentId ?? "default";
    const messages = (request.agent as unknown as { messages?: Message[] }).messages;
    const userId = getRunnerUser()?.id ?? null;
    const orgId = getRunnerUser()?.orgId ?? null;

    if (messages && messages.length > 0) {
      await query(
        `INSERT INTO thread_messages (thread_id, messages, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (thread_id) DO UPDATE SET
           messages = EXCLUDED.messages,
           updated_at = EXCLUDED.updated_at`,
        [request.threadId, JSON.stringify(messages)],
      );
    }

    const existing = await query<{ title: string | null; user_id: string | null }>(
      `SELECT title, user_id FROM thread_metadata WHERE thread_id = $1`,
      [request.threadId],
    );

    const title = existing.rows[0]?.title ?? this.deriveTitle(messages ?? []);
    const effectiveUserId = existing.rows[0]?.user_id ?? userId;

    await query(
      `INSERT INTO thread_metadata (thread_id, agent_id, title, updated_at, user_id, org_id)
       VALUES ($1, $2, $3, now(), $4, $5)
       ON CONFLICT (thread_id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         title = COALESCE(thread_metadata.title, EXCLUDED.title),
         updated_at = EXCLUDED.updated_at`,
      [request.threadId, agentId, title, effectiveUserId ?? null, orgId],
    );

    // ─── Write-through cache update ───────────────────────────────────
    // PG writes succeeded — now update the in-memory caches so the sync
    // LocalThreadEndpointRunner methods (called by useThreads immediately
    // after onRunFinalized) see the fresh data.
    const nowIso = new Date().toISOString();
    const prev = this.threadCache.get(request.threadId);
    this.threadCache.set(request.threadId, {
      id: request.threadId,
      name: title,
      agentId,
      organizationId: orgId ?? "",
      createdById: effectiveUserId ?? "",
      archived: false,
      createdAt: prev?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    if (messages && messages.length > 0) {
      this.messageCache.set(request.threadId, messages);
    }
  }

  private deriveTitle(messages: Message[]): string | null {
    const firstUser = messages.find((m) => m.role === "user");
    const content =
      typeof firstUser?.content === "string" ? firstUser.content : null;
    if (!content) return null;
    return content.length > 50 ? content.slice(0, 50) + "..." : content;
  }
}

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
import { getReservedDepKeys, getRunnerUser } from "@/lib/auth/request-context";

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
  /** This run's id — lets connect() detect "replay already covers this run". */
  runId?: string;
  /**
   * Set by deleteThread when the thread was deleted while this run was
   * still in flight. The run's persistence window (storeRun +
   * captureThreadData) checks this and skips writing: without it, the
   * finishing run would resurrect the deleted thread — fresh agent_runs,
   * thread_messages and thread_metadata rows (plus a re-seeded sidebar
   * cache) containing only the in-flight run's data, silently undoing
   * the deletion. The flag dies with the connection object at teardown,
   * so a later run on a re-created thread (same id) persists normally.
   *
   * First line of defense only: it covers runs whose connection was
   * already registered when deleteThread read the map. A run that
   * registers after that read never sees the flag — the deleted_threads
   * tombstone (committed atomically with the delete) is the DB-level
   * backstop those runs hit at their persistence window and at the
   * startRun gate.
   */
  threadDeleted?: boolean;
}

// Active connections for streaming events and stop support. Owned by this
// module (replaces the module-private ACTIVE_CONNECTIONS that was inaccessible
// in @copilotkit/sqlite-runner, which forced the old PersistentAgentRunner to
// reach into the parent's private `db` field via a TS escape hatch).
const ACTIVE_CONNECTIONS = new Map<string, ActiveConnectionContext>();

const SCHEMA_VERSION = 1;

/**
 * How long a run_state row whose current_run_id has NO live
 * ACTIVE_CONNECTIONS entry must age before acquireRunState treats it as a
 * stale lock and steals it. A genuine holder registers its map entry
 * synchronously right after the acquire returns (no await in between), so
 * any map-absent row younger than this is a winner still mid-registration
 * in a concurrent race — not an orphan. The value only bounds how long a
 * transient release failure wedges the thread (teardownRun's release is
 * best-effort); it is not a run timeout.
 */
const STALE_LOCK_GRACE_MS = 10_000;

/**
 * How long a deleted_threads tombstone is kept. The tombstone gates runs
 * (startRun refuses the id; the persistence window skips writing), and a
 * run's persistence lands at most minutes after its thread was deleted —
 * the retention exists to bound the table, not to re-enable ids (thread
 * ids are client-generated UUIDs, so no legitimate flow re-creates a
 * deleted one). Pruned opportunistically inside deleteThread's
 * transaction: every delete sweeps rows older than this — no background
 * timer.
 */
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Defense in depth against secret persistence: the AG-UI schema allows
 * events (and the stored run input) to carry the full request input,
 * whose `context` array is where the run gate INJECTS this run's
 * secrets (the model key, every tool dep key, mcp_connectors with org
 * connector URLs+tokens). Today the dispatcher persists an empty
 * context (verified against production-shaped data: zero reserved keys
 * across all stored runs) — but an upstream change could start echoing
 * it, and connect() replays stored events to browsers. Redact any
 * context item whose description/name is a reserved dep key before
 * persisting, so server-injected secrets can never reach `agent_runs`.
 * Non-reserved client context is the client's own data and survives.
 */
export function redactReservedContext<T extends object>(
  holder: T | undefined,
  reserved: ReadonlySet<string>,
): T | undefined {
  const context = (holder as { context?: unknown } | undefined)?.context;
  if (!holder || !Array.isArray(context)) return holder;
  const kept = context.filter((item) => {
    if (typeof item !== "object" || item === null) return true;
    const { description, name } = item as { description?: unknown; name?: unknown };
    return !reserved.has(String(description ?? "")) && !reserved.has(String(name ?? ""));
  });
  if (kept.length === context.length) return holder;
  return { ...holder, context: kept };
}

/**
 * Event-shaped variant: AG-UI events that carry an input embed it under
 * `input` (RUN_STARTED), so the holder is `event.input`. Returns the
 * original event object when there is nothing to redact.
 */
export function redactReservedEvent<E extends object>(
  event: E,
  reserved: ReadonlySet<string>,
): E {
  const input = (event as { input?: { context?: unknown } }).input;
  if (!input) return event;
  const safeInput = redactReservedContext(input, reserved);
  return safeInput === input ? event : { ...event, input: safeInput };
}

/**
 * Build a verifier-safe replay stream from raw persisted events:
 *
 * - RUN_ERROR events are removed (the documented replay filter — AG-UI's
 *   verifier locks on a replayed RUN_ERROR mid-stream, making failed-run
 *   threads permanently unreadable on reconnect). A RUN_ERROR is NOT a
 *   stray-drop boundary: `compactEvents` persists an errored run's
 *   buffered message/tool-call traffic AFTER the RUN_ERROR (it flushes
 *   unclosed sequences at stream end), so events following a RUN_ERROR in
 *   the record were, in real time, emitted BEFORE it — dropping
 *   "post-terminal" events there would erase the run's real partial
 *   history. The run simply stays open; the next RUN_STARTED (or a
 *   trailing terminator) closes its sequences and synthesizes the
 *   RUN_FINISHED.
 * - A run's history stops at its first surviving terminal event
 *   (RUN_FINISHED). Events the backend recorded after it (stray
 *   bookkeeping: a duplicate RUN_FINISHED, message/tool-call traffic
 *   trailing the terminator) are dropped, while the NEXT run's own
 *   RUN_STARTED is kept — multi-run histories (RUN_FINISHED → RUN_STARTED)
 *   are the normal shape, so the cut is scoped to the run that ended, not
 *   to the whole history. The verifier rejects every event except
 *   RUN_STARTED after a RUN_FINISHED ("The run has already finished with
 *   'RUN_FINISHED'. Start a new run with 'RUN_STARTED'."), so replaying
 *   strays would make the reconnect replay un-consumable.
 * - An unterminated run is closed with a synthetic RUN_FINISHED **only
 *   when a later RUN_STARTED follows it in the same history** — the next
 *   run's RUN_STARTED would otherwise trip the verifier ("Cannot send
 *   'RUN_STARTED' while a run is still active") and the whole connect
 *   replay would be rejected. Before the terminator, any message,
 *   tool-call, or REASONING sequence the errored run left open is CLOSED
 *   first: AG-UI requires a producer to close what it opened before
 *   RUN_FINISHED, and @copilotkit/shared's finalizeRunEvents deliberately
 *   skips closure when a RUN_ERROR is present (and tracks only
 *   TEXT_MESSAGE_* and TOOL_CALL_* — a REASONING_* sequence is never
 *   closed by it) — so persisted errored runs keep open sequences that a bare
 *   synthetic terminator would leave dangling (permanently-spinning tool
 *   calls on reconnect).
 * - A run left unterminated at the END of the history is left
 *   unresolved — UNLESS the caller is about to append a live bridge to
 *   the same verified stream (`opts.terminateTrailing`, set by
 *   startConnect when it will subscribe an in-flight run's subject after
 *   the replay): the bridge's first event is the new run's RUN_STARTED,
 *   and a producer must close what it opened before a new RUN_STARTED in
 *   the same stream. The bridge supplies the "later RUN_STARTED" the
 *   synthesis exists for — it just isn't in the persisted history list.
 *
 * The failure flavor is preserved in the synthesized tool-call results
 * (status "error") so replayed history reads as failed, not completed.
 */
function buildReplayEvents(
  events: BaseEvent[],
  opts: { terminateTrailing?: boolean } = {},
): BaseEvent[] {
  const out: BaseEvent[] = [];
  let openRun: { threadId: string; runId: string } | null = null;
  // A RUN_STARTED has been seen — the history is inside/at a run. Events
  // before the first RUN_STARTED are pre-run bookkeeping (hand-seeded
  // history) and are never treated as strays.
  let runOpened = false;
  // The current run segment emitted its RUN_FINISHED. Everything recorded
  // after it is stray bookkeeping and is dropped until the next RUN_STARTED
  // (see the doc comment's terminal rule).
  let runFinished = false;
  const openMessageIds = new Set<string>();
  const openToolCalls = new Map<string, { hasEnd: boolean; hasResult: boolean }>();
  // Open REASONING_* sequences. REASONING_START opens a reasoning block
  // identified by its messageId; REASONING_MESSAGE_START opens a reasoning
  // message INSIDE the block under its own messageId (the runtime's
  // THINKING_* → REASONING_* transformer gives the block and the message
  // different ids), so both ids must be tracked separately. Closure mirrors
  // the nesting: REASONING_MESSAGE_END for each open message, then
  // REASONING_END for each open block.
  const openReasoningMessages = new Set<string>();
  const openReasoningBlocks = new Set<string>();

  const closeOpenSequences = (): void => {
    for (const messageId of openReasoningMessages) {
      out.push({ type: EventType.REASONING_MESSAGE_END, messageId } as unknown as BaseEvent);
    }
    for (const messageId of openReasoningBlocks) {
      out.push({ type: EventType.REASONING_END, messageId } as unknown as BaseEvent);
    }
    for (const messageId of openMessageIds) {
      out.push({ type: EventType.TEXT_MESSAGE_END, messageId } as unknown as BaseEvent);
    }
    for (const [toolCallId, info] of openToolCalls) {
      if (!info.hasEnd) {
        out.push({ type: EventType.TOOL_CALL_END, toolCallId } as unknown as BaseEvent);
      }
      if (!info.hasResult) {
        out.push({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: `${toolCallId}-result`,
          role: "tool",
          content: JSON.stringify({
            status: "error",
            reason: "run_error",
            message: "The agent run failed. Please try again.",
          }),
        } as unknown as BaseEvent);
      }
    }
    openReasoningMessages.clear();
    openReasoningBlocks.clear();
    openMessageIds.clear();
    openToolCalls.clear();
  };

  for (const event of events) {
    if (event.type === EventType.RUN_ERROR) {
      // Filtered from the replay stream — and deliberately NOT a
      // stray-drop boundary: compactEvents persists an errored run's
      // buffered message/tool-call traffic AFTER the RUN_ERROR (it
      // flushes unclosed sequences at stream end), so those events were
      // emitted BEFORE the error in real time. The run stays open: the
      // next RUN_STARTED (or a trailing terminator) closes its open
      // sequences and synthesizes the RUN_FINISHED the verifier requires.
      continue;
    }
    if (event.type === EventType.RUN_STARTED) {
      if (openRun) {
        closeOpenSequences();
        out.push(syntheticRunFinished(openRun));
      }
      runOpened = true;
      runFinished = false;
      const started = event as { threadId?: string; runId?: string };
      openRun =
        started.threadId && started.runId
          ? { threadId: started.threadId, runId: started.runId }
          : null;
      out.push(event);
      continue;
    }
    if (event.type === EventType.RUN_FINISHED) {
      if (openRun) {
        // Close anything the run left open before its terminator — a
        // no-op for well-formed runs (their sequences are already closed)
        // and a repair for records where open traffic precedes the
        // terminator.
        closeOpenSequences();
        out.push(event);
        openRun = null;
        openMessageIds.clear();
        openToolCalls.clear();
        openReasoningMessages.clear();
        openReasoningBlocks.clear();
        runFinished = true;
        continue;
      }
      // No open run: pre-run bookkeeping (history seeded before any
      // RUN_STARTED) and the terminal of a run whose RUN_STARTED carried
      // no ids are kept — both preserve prior behavior. A RUN_FINISHED
      // trailing an already-finished run is stray bookkeeping — dropped.
      if (!runFinished) out.push(event);
      continue;
    }
    if (!runOpened) {
      // Pre-run bookkeeping — preserved as before.
      out.push(event);
      continue;
    }
    if (runFinished) continue; // stray post-terminal bookkeeping — dropped

    if (event.type === EventType.REASONING_START) {
      const id = (event as { messageId?: unknown }).messageId;
      if (typeof id === "string") openReasoningBlocks.add(id);
    } else if (event.type === EventType.REASONING_MESSAGE_START) {
      const id = (event as { messageId?: unknown }).messageId;
      if (typeof id === "string") openReasoningMessages.add(id);
    } else if (event.type === EventType.REASONING_MESSAGE_END) {
      const id = (event as { messageId?: unknown }).messageId;
      if (typeof id === "string") openReasoningMessages.delete(id);
    } else if (event.type === EventType.REASONING_END) {
      const id = (event as { messageId?: unknown }).messageId;
      if (typeof id === "string") openReasoningBlocks.delete(id);
    } else if (event.type === EventType.TEXT_MESSAGE_START) {
      const id = (event as { messageId?: unknown }).messageId;
      if (typeof id === "string") openMessageIds.add(id);
    } else if (event.type === EventType.TEXT_MESSAGE_END) {
      const id = (event as { messageId?: unknown }).messageId;
      if (typeof id === "string") openMessageIds.delete(id);
    } else if (event.type === EventType.TOOL_CALL_START) {
      const id = (event as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") openToolCalls.set(id, { hasEnd: false, hasResult: false });
    } else if (event.type === EventType.TOOL_CALL_END) {
      const id = (event as { toolCallId?: unknown }).toolCallId;
      const info = typeof id === "string" ? openToolCalls.get(id) : undefined;
      if (info) info.hasEnd = true;
    } else if (event.type === EventType.TOOL_CALL_RESULT) {
      const id = (event as { toolCallId?: unknown }).toolCallId;
      const info = typeof id === "string" ? openToolCalls.get(id) : undefined;
      if (info) info.hasResult = true;
    }
    out.push(event);
  }
  // End of history with an open run: unresolved by default — but a
  // caller appending a live bridge to this same stream must close the
  // run first (the bridge's RUN_STARTED would otherwise trip the
  // verifier's "run still active" lock).
  if (opts.terminateTrailing && openRun) {
    closeOpenSequences();
    out.push(syntheticRunFinished(openRun));
  }
  return out;
}

function syntheticRunFinished(run: { threadId: string; runId: string }): BaseEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: run.threadId,
    runId: run.runId,
  } as unknown as BaseEvent;
}

/**
 * Postgres-backed AgentRunner. Replaces @copilotkit/sqlite-runner's
 * SqliteAgentRunner for this app — speaks to the same `pg.Pool` that
 * Better Auth and the agent store use (see lib/db/pg.ts).
 *
 * Schema lives in lib/db/migrations/ (tables: agent_runs, run_state,
 * thread_messages, thread_metadata, deleted_threads). Tables are created by
 * `npm run migrate` — the runner does not own schema creation.
 *
 * `connect()` uses smart replay: filters RUN_ERROR events from the raw
 * event stream before compacting. This sidesteps the AG-UI verifier lock
 * bug documented in docs/architecture.md ("Thread persistence")
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
 * See docs/architecture.md ("In-memory cache") for the full design notes.
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
    // ─── Cross-tenant write guard ────────────────────────────────────────
    // A caller who knows (or guesses) another tenant's thread id must not
    // be able to write into it: without this check a foreign run marked
    // the victim thread "running" (denying the owner's real runs with
    // "Thread already running") and appended the attacker's messages and
    // events to the victim's persisted history. The thread cache can't
    // arbitrate this — a NEW chat is a cache miss by design — so existence
    // is resolved from PG, the cross-process source of truth. A thread
    // that exists and is foreign is denied before ANY state changes
    // (run_state write, history read, cache seed); a thread that doesn't
    // exist anywhere is creatable — its owner becomes the first runner
    // (captureThreadData records user_id/org_id on first run).
    const runnerUser = getRunnerUser();
    if (runnerUser) {
      const ownership = await this.getThreadOwnership(request.threadId);
      if (ownership && !this.threadVisible(ownership, runnerUser)) {
        throw new Error("Thread not found");
      }
    }

    // Claim the run lock ATOMICALLY: the conditional upsert only takes the
    // lock when the stored state says not-running, and RETURNING tells
    // whether THIS call won it. The old check-then-act pair (getRunState →
    // setRunState) let two concurrent runs on the same thread both observe
    // "not running" and both proceed — interleaving both runs' events into
    // one persisted history.
    const acquired = await this.acquireRunState(
      request.threadId,
      request.input.runId,
    );
    if (!acquired) {
      throw new Error("Thread already running");
    }

    // Deleted-mid-start gate. The thread may have been deleted while this
    // run was starting: the ownership check above read pre-delete state,
    // and acquireRunState's INSERT can wait out the delete transaction's
    // row lock (its ON CONFLICT targets the run_state row the delete is
    // removing) and claim a FRESH lock row on a thread that no longer
    // exists. A tombstoned thread id is dead — release the just-claimed
    // row and refuse. Without this the run streams to completion into a
    // thread the user deleted and its persistence window silently drops
    // it (the tombstone checks below), leaving the user watching a run
    // whose history will never exist. "Thread not found" is honest in
    // both orderings: the id no longer resolves to a live thread.
    if (await this.isThreadTombstoned(request.threadId)) {
      await query(
        `DELETE FROM run_state WHERE thread_id = $1 AND current_run_id = $2`,
        [request.threadId, request.input.runId],
      );
      throw new Error("Thread not found");
    }

    const currentRunEvents: BaseEvent[] = [];

    const nextSubject = new ReplaySubject<BaseEvent>(Infinity);
    const prevConnection = ACTIVE_CONNECTIONS.get(request.threadId);
    const prevSubject = prevConnection?.subject;

    // THIS run's connection object — captured by identity so the teardown
    // below can tell "still mine" from "a replacement run overwrote the
    // map entry" (an aborted run's teardown must not touch the
    // replacement's entry: its stop button and event routing depend on
    // the agent/subject references this teardown used to clear).
    const myConnection: ActiveConnectionContext = {
      subject: nextSubject,
      agent: request.agent,
      runSubject,
      currentEvents: currentRunEvents,
      stopRequested: false,
      runId: request.input.runId,
    };

    ACTIVE_CONNECTIONS.set(request.threadId, myConnection);

    // Seed the thread cache NOW, not at run end. The ownership gate in
    // stop() (and every sync runner read) consults this cache, and it was
    // otherwise only populated by captureThreadData() AFTER the run
    // finishes — so stop() on a thread's FIRST in-flight run hit a cache
    // miss and denied the owner: the stop button silently did nothing on
    // the first message of every new chat, for every signed-in user.
    // Seed only when absent: a cached thread keeps its real title and
    // createdAt (captureThreadData reconciles the row at run end).
    if (!this.threadCache.has(request.threadId)) {
      const nowIso = new Date().toISOString();
      this.threadCache.set(request.threadId, {
        id: request.threadId,
        name: this.deriveTitle(request.input.messages ?? []),
        agentId: request.agent.agentId ?? "default",
        organizationId: runnerUser?.orgId ?? "",
        createdById: runnerUser?.id ?? "",
        archived: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    const runAgent = async () => {
      // The live stream is redacted with the SAME rule as persistence
      // (storeRun below). Captured here — inside the runner ALS scope,
      // which spans this whole async chain — so the redaction never
      // depends on where a callback happens to run.
      const liveReserved = new Set([...getReservedDepKeys(), "mcp_connectors"]);
      // OUTER safety net: everything after the lock claim runs inside this
      // try. A throw from the historic read or the pre-run parent
      // resolution previously escaped the fire-and-forget wrapper entirely
      // (logged and abandoned): is_running stayed true forever — the
      // thread became unrunnable — and the SSE subjects never completed,
      // hanging the client. The `preRun` flag splits the two failure
      // contracts: a pre-run failure releases the lock + map entry and
      // RETHROWS (the run stream errors, as it always did); a mid-run
      // failure persists what it has, releases, and completes (as it
      // always did). Either way the thread never stays locked.
      let preRun = true;
      // Declared outside the try so the mid-run failure path can persist
      // the partial run with the correct parent linkage.
      let parentRunId: string | null = null;
      try {
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

        const parentRunIdResolved = await this.getLatestRunId(request.threadId);
        parentRunId = parentRunIdResolved;
        preRun = false;

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
            // Live redaction, BEFORE any subscriber sees the event: the
            // RUN_STARTED fill above copies request.input — whose context
            // carries the gate-injected secrets (model keys + MCP
            // connector tokens) — into the event. Without this, those
            // secrets stream to the browser on every run; storeRun
            // redacted only the persisted copy.
            processedEvent = redactReservedEvent(
              processedEvent as { input?: { context?: unknown } },
              liveReserved,
            ) as BaseEvent;

            runSubject.next(processedEvent);
            nextSubject.next(processedEvent);
            currentRunEvents.push(processedEvent);
          },
        });

        const appendedEvents = finalizeRunEvents(currentRunEvents, {
          stopRequested: myConnection.stopRequested ?? false,
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

        // Snapshot capture BEFORE releasing the lock: a replacement run
        // can only start once the lock is gone, so this ordering
        // guarantees the thread_messages/metadata write this run performs
        // can't clobber — or be clobbered by — the next run's snapshot.
        await this.captureThreadData(request);

        await this.teardownRun(request.threadId, myConnection, request.input.runId);

        runSubject.complete();
        nextSubject.complete();
      } catch (err) {
        if (preRun) {
          // Pre-run failure (historic read / parent resolution): nothing
          // was persisted — release the lock + map entry, then rethrow so
          // the run stream ERRORS (the pre-run client contract) instead
          // of completing silently. nextSubject must also be terminated:
          // a connect() that bridged to it during the acquire→read window
          // (is_running was already true) would otherwise never receive a
          // terminal event and hang forever.
          await this.teardownRun(request.threadId, myConnection, request.input.runId);
          nextSubject.error(err);
          throw err;
        }
        console.error("[runner] run failed", {
          agentId: request.agent.agentId ?? "default",
          threadId: request.threadId,
          runId: request.input?.runId,
          error: err instanceof Error ? err.message : String(err),
        });

        // Finalize, persist, and snapshot — ALL inside one guarded block.
        // finalizeRunEvents + the subject emits previously ran OUTSIDE the
        // guard: a throw there skipped the teardown below, wedging the
        // run lock (the thread became unrunnable until a boot reset) and
        // leaving the SSE subjects open. Every fallible step of the
        // mid-run unwind is inside the try; the teardown ALWAYS runs.
        try {
          const appendedEvents = finalizeRunEvents(currentRunEvents, {
            stopRequested: myConnection.stopRequested ?? false,
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
          // Even on failure, capture the thread snapshot so the
          // conversation is still readable on reconnect (the connect()
          // smart replay filters out RUN_ERROR events before replaying).
          // BEFORE the lock release — same clobber argument as the
          // success path.
          await this.captureThreadData(request);
        } catch (persistErr) {
          console.error("[runner] run-failure persistence failed", {
            threadId: request.threadId,
            runId: request.input?.runId,
            error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
        }

        await this.teardownRun(request.threadId, myConnection, request.input.runId);

        runSubject.complete();
        nextSubject.complete();
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

    // Fire-and-forget. The catch logs AND errors the subject: a rethrow
    // from runAgent (e.g. a pre-run DB failure the inner handling didn't
    // cover) must reach the client as a failed run — a log-only catch
    // left the SSE stream open forever with the lock held.
    runAgent().catch((err) => {
      console.error("[runner] runAgent unexpected error", {
        threadId: request.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      runSubject.error(err);
      // Mirror to nextSubject so a bridged connect() stream terminates too
      // (a no-op when the subject already completed).
      nextSubject.error(err);
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
    // ─── Cross-tenant read guard ─────────────────────────────────────────
    // Same visibility rule as the sync readers (getThreadEvents et al):
    // an authenticated caller is denied for a thread unknown to this
    // process or foreign to their org — fail-closed on cache miss, and
    // the denial reads identically to an unknown thread (empty replay,
    // immediate complete; the sync contract's indistinguishable-empty
    // pattern). Without this, knowing a thread id was enough to replay
    // its FULL event history: every sync read path gates on
    // threadVisible, but this async replay path didn't. The guard must
    // run before getHistoricRuns — the PG read itself is the leak.
    const runnerUser = getRunnerUser();
    if (runnerUser) {
      const cached = this.threadCache.get(request.threadId);
      if (!cached || !this.threadVisible(cached, runnerUser)) {
        connectionSubject.complete();
        return;
      }
    }

    // ─── Smart replay: filter RUN_ERROR events before compacting ─────
    // AG-UI's verifier locks when it sees a RUN_ERROR mid-stream, which
    // makes failed-run threads permanently unreadable on reconnect (the
    // bug documented in docs/architecture.md "Thread persistence").
    // Filtering RUN_ERROR out before compactEvents sidesteps the lock
    // while preserving all other event types (messages, tool calls,
    // STATE_*, REASONING_*, STEP_*).
    const historicRuns = await this.getHistoricRuns(request.threadId);
    const allHistoricEvents: BaseEvent[] = [];
    for (const run of historicRuns) {
      for (const event of run.events) {
        allHistoricEvents.push(event);
      }
    }
    const snapshotRunIds = new Set(historicRuns.map((run) => run.run_id));

    // Bridge-decision inputs are gathered BEFORE the replay is built:
    // the trailing-run terminator and the live-bridge decision must
    // agree on the SAME map/runState reads. If they didn't, a run
    // registering between the two reads would be bridged onto a replay
    // left unresolved (the verifier sees RUN_STARTED while a run is
    // still active) or a replay terminated with no bridge to justify
    // it. All awaits happen up front; from here to the bridge
    // subscription every decision is synchronous off these values.
    const activeConnection = ACTIVE_CONNECTIONS.get(request.threadId);
    const runState = await this.getRunState(request.threadId);
    const messages = await this.fetchThreadMessages(request.threadId);

    // willBridge: an in-flight run exists and the snapshot does NOT
    // cover it — the bridge will append its buffered events (first: its
    // RUN_STARTED) to this same stream, so a trailing unresolved run in
    // the replay must be closed first (see buildReplayEvents).
    const willBridge =
      activeConnection?.runId != null && !snapshotRunIds.has(activeConnection.runId);
    // Filter RUN_ERROR + verifier-safe replay shaping (conditional
    // synthetic terminator, closure of sequences the errored run left
    // open — see buildReplayEvents) BEFORE compacting.
    const compactedEvents = compactEvents(
      buildReplayEvents(allHistoricEvents, { terminateTrailing: willBridge }),
    );

    // ─── Read-through: populate caches from the PG fetch ──────────────
    // The sync LocalThreadEndpointRunner methods (getThreadEvents,
    // getThreadState) read from these caches. Future calls within the
    // same process get sync access to the historic event stream.
    // NEVER clobber a fresher storeRun merge: a run committing between
    // our getHistoricRuns snapshot (a PG statement snapshot) and this
    // synchronous write has already merged its events into the cache —
    // overwriting with the older snapshot would regress the sync
    // readers to pre-run history (and getThreadState to the pre-run
    // STATE_SNAPSHOT) until the next write on the thread. A cache
    // holding a runId absent from the snapshot proves a newer write
    // landed: skip and let the newer value stand.
    if (!this.cacheHoldsRunOutsideSnapshot(request.threadId, snapshotRunIds)) {
      this.eventsCache.set(request.threadId, compactedEvents);
    }
    if (messages.length > 0) this.messageCache.set(request.threadId, messages);

    const emittedMessageIds = new Set<string>();
    for (const event of compactedEvents) {
      connectionSubject.next(event);
      if ("messageId" in event && typeof event.messageId === "string") {
        emittedMessageIds.add(event.messageId);
      }
    }

    // ─── Live-bridging: if a run is in flight, stream new events ──────
    // `activeConnection` and `runState` were read up front (see above)
    // so this decision matches the terminator that shaped the replay.

    // A connect() landing between a run's storeRun and its teardown would
    // otherwise replay the just-persisted run TWICE: once from the
    // historic replay above, once from the subject's replay buffer. The
    // messageId dedup below only covers TEXT_MESSAGE_* — duplicated
    // TOOL_CALL_START / STATE_* events would pass it and the AG-UI
    // verifier rejects a duplicate TOOL_CALL_START outright. The decisive
    // fact: every event a run ever emits is emitted BEFORE storeRun
    // persists it — so when the replay snapshot already contains the
    // in-flight run, the bridge can only add duplicates. Skip it and
    // complete: the client got the full history in the replay. (If
    // storeRun commits AFTER our snapshot, the replay lacks the run, the
    // bridge supplies it exactly once, and no duplication is possible —
    // both orderings are covered by checking the SAME snapshot we
    // replayed from.)
    const replayCoversActiveRun =
      activeConnection != null &&
      activeConnection.runId != null &&
      snapshotRunIds.has(activeConnection.runId);

    if (
      activeConnection &&
      !replayCoversActiveRun &&
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
    // Same visibility rule as every other thread path: without this,
    // knowing a foreign thread id yields a free "exists and is mid-run"
    // oracle (the sync readers deny unknown/foreign threads with an
    // indistinguishable empty/false response — this path must match).
    const user = getRunnerUser();
    if (user) {
      const cached = this.threadCache.get(request.threadId);
      if (!cached || !this.threadVisible(cached, user)) return false;
    }
    const runState = await this.getRunState(request.threadId);
    return runState.isRunning;
  }

  async stop(
    request: AgentRunnerStopRequest,
  ): Promise<boolean | undefined> {
    // Ownership gate BEFORE anything is aborted: a member who learns
    // another org's thread id must not be able to kill their in-flight
    // run (trace interference / DoS). Fail closed — deny when the thread
    // is unknown to this process or foreign; the caller learns nothing
    // either way (false reads identically for "not running").
    const user = getRunnerUser();
    if (user) {
      const cached = this.threadCache.get(request.threadId);
      if (!cached || !this.threadVisible(cached, user)) return false;
    }

    const runState = await this.getRunState(request.threadId);
    if (!runState.isRunning) return false;

    const connection = ACTIVE_CONNECTIONS.get(request.threadId);
    const agent = connection?.agent;
    if (!connection || !agent) return false;
    if (connection.stopRequested) return false;

    connection.stopRequested = true;

    // The run lock is NOT released here. The aborted run still has to
    // persist its partial history (storeRun + captureThreadData) after
    // the abort lands — releasing the lock first let a replacement run
    // acquire it and race the aborted run's persistence (interleaved
    // snapshots, history out of order). Instead the lock stays with the
    // aborted run until its own teardownRun releases it — that release is
    // guarded by the current_run_id match, so it can never clobber a
    // successor. Trade-off (documented in docs/architecture.md): between
    // stop() and the aborted run's teardown, is_running still reads true,
    // so an immediate replacement run gets "Thread already running" for
    // the abort+persistence window (sub-second in practice).

    try {
      agent.abortRun();
      return true;
    } catch (error) {
      console.error("Failed to abort agent run", error);
      // The abort failed and the run CONTINUES — it still owns the lock
      // (never released above), so there is nothing to restore: the run's
      // own teardown releases it when it settles.
      connection.stopRequested = false;
      return false;
    }
  }

  // ─── Thread visibility ────────────────────────────────────────────────
  //
  // The single rule every thread path applies (list, messages, events,
  // state, stop, delete, rename, and — via getThreadOwnership / the
  // cache — the async run and connect paths): the thread must belong to
  // the caller's org AND be owned by them — or carry no recorded owner
  // (legacy rows written when the runner ALS was absent are org-shared,
  // matching the deleteThread org-mate semantics). Solo mode (no runner
  // user) sees everything: one tenant, one operator.
  //
  // Without this, a signed-in member of any org could read another
  // tenant's conversation messages/events/state — or kill another
  // tenant's in-flight run — by knowing a thread id (leaked via logs,
  // Sentry breadcrumbs, screenshots). The runtime's thread endpoints
  // dispatch on threadId alone; the runner is where identity is available
  // (getRunnerUser), so the runner is where the check lives.
  //
  // A thread that is not in THIS process's cache is denied for
  // authenticated callers — fail-closed, same tradeoff deleteThread
  // documented (the caches are the source of truth for what this process
  // can serve; multi-instance SaaS needs the Redis migration).
  private threadVisible(
    t: Pick<LocalThreadEndpointRecord, "organizationId" | "createdById">,
    user: { id: string; orgId: string } | null,
  ): boolean {
    if (!user) return true;
    if (t.organizationId !== user.orgId) return false;
    return t.createdById === user.id || t.createdById === "";
  }

  // ─── LocalThreadEndpointRunner: 5 SYNC methods ────────────────────────
  //
  // These methods are called WITHOUT await by CopilotKit's runtime (see
  // node_modules/@copilotkit/runtime/.../handlers/intelligence/threads.mjs).
  // They MUST return synchronously. They read from the in-memory caches
  // populated by the async helpers below + captureThreadData + startConnect.

  listThreads(): LocalThreadEndpointRecord[] {
    const user = getRunnerUser();
    const all = Array.from(this.threadCache.values());
    if (!user) return all;
    // Filter at read time — the cache contains threads across orgs. The
    // org match is EXACT: the old `organizationId === ""` tolerance made
    // metadata rows with no recorded org visible to every org. Platform
    // admins do NOT bypass this filter — they see only their own threads
    // in their active org, same as everyone else.
    return all.filter((t) => this.threadVisible(t, user));
  }

  getThreadMessages(threadId: string): Message[] {
    const user = getRunnerUser();
    if (!user) return this.messageCache.get(threadId) ?? [];
    const cached = this.threadCache.get(threadId);
    // Cache-miss or foreign thread → indistinguishable empty response
    // (the sync contract can't return errors; empty is what an unknown
    // threadId already returned, so nothing new leaks).
    if (!cached || !this.threadVisible(cached, user)) return [];
    return this.messageCache.get(threadId) ?? [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    const user = getRunnerUser();
    if (!user) return this.eventsCache.get(threadId) ?? [];
    const cached = this.threadCache.get(threadId);
    if (!cached || !this.threadVisible(cached, user)) return [];
    return this.eventsCache.get(threadId) ?? [];
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const user = getRunnerUser();
    if (user) {
      const cached = this.threadCache.get(threadId);
      // Same visibility rule as the other sync readers — the state
      // snapshot is agent state, which can carry org-sensitive shapes.
      if (!cached || !this.threadVisible(cached, user)) return null;
    }
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
    // Deliberate no-op.
    //
    // CopilotKit's LocalThreadEndpointRunner interface requires this
    // method (it powers the demo's POST /threads/clear "Clear button"),
    // but a global wipe is not a meaningful operation for this runner:
    // PG is multi-tenant, the runner has no caller identity to scope a
    // delete by, and wiping run_state would delete live runs' lock rows
    // (concurrent-run corruption + unstoppable runs — see #97/#99). The
    // library itself documents that real-DB history "must not be wiped
    // this way". The HTTP path is refused at the copilotkit route (403,
    // test-pinned). If a real "clear everything" product need ever
    // appears, design it deliberately — scoping, auth, live-run handling
    // — rather than restoring this body.
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
      // The org match is EXACT (threadVisible): the old three-way deny
      // condition let a metadata row with empty org_id AND empty owner
      // be deleted by ANY user of ANY org — the empty tolerance must not
      // widen the org boundary, only the owner half. Platform admins do
      // NOT bypass this check — they can only delete their own threads,
      // same as everyone else. Admin powers are limited to agent/user
      // management, not thread management.
      const cached = this.threadCache.get(threadId);
      if (!cached || !this.threadVisible(cached, { id: uid, orgId: oid ?? "" })) return false;
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
      // Tombstone in the SAME transaction: from this commit on, the
      // deleted id is dead at the DB level — startRun refuses it and the
      // persistence window (storeRun + captureThreadData) skips writing —
      // closing the windows the in-memory marker below cannot see (a run
      // that registers after this method's map read, and a run that
      // starts after this commit and would otherwise pass the ownership
      // gate as a "creatable" brand-new thread). Opportunistic retention
      // sweep: every delete prunes tombstones past the retention window —
      // no background timer. The cutoff is computed in JS and passed as a
      // parameter (clock arithmetic in one place; pg-mem-compatible).
      await client.query(
        `INSERT INTO deleted_threads (thread_id) VALUES ($1)
         ON CONFLICT (thread_id) DO NOTHING`,
        [threadId],
      );
      await client.query(
        `DELETE FROM deleted_threads WHERE deleted_at < $1`,
        [new Date(Date.now() - TOMBSTONE_RETENTION_MS)],
      );
      deleted = (r1.rowCount ?? 0) > 0 || (r4.rowCount ?? 0) > 0;
    });

    // Write-through: PG delete succeeded, now update the cache. The cache
    // clears and the resurrection marker happen REGARDLESS of the row
    // counts: a thread whose only existence is an in-flight FIRST run has
    // no persisted rows yet (the seed is in-memory; DB rows are written
    // by captureThreadData at run end), but it is still user-visible in
    // the sidebar and must not be resurrected by that run's final write.
    this.threadCache.delete(threadId);
    this.messageCache.delete(threadId);
    this.eventsCache.delete(threadId);
    // A run still streaming on this thread would otherwise resurrect it:
    // its final storeRun + captureThreadData re-insert the rows and
    // re-seed the sidebar cache (the run started before the delete, so
    // nothing else distinguishes its writes from a live thread's).
    // Mark the live connection — the run's persistence window checks
    // the flag and skips writing; the flag dies with the connection at
    // teardown, so a later run on a re-created thread id persists
    // normally. (In-process signal: on a multi-instance deploy a run
    // streaming on another instance would still resurrect — the same
    // single-instance assumption as the run-state boot reset.) The
    // tombstone committed above is the DB-level backstop for the runs
    // this marker cannot reach: one that registers its connection after
    // this map read, and one that starts after this commit.
    const active = ACTIVE_CONNECTIONS.get(threadId);
    if (active) active.threadDeleted = true;
    return deleted || active != null;
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
      // Same exact-org visibility rule as deleteThread (the empty-org
      // tolerance must not widen the org boundary).
      const cached = this.threadCache.get(threadId);
      if (!cached || !this.threadVisible(cached, { id: uid, orgId: oid ?? "" })) return false;
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
    // Deleted-mid-run guard: the thread was deleted while this run was
    // streaming (deleteThread marks the live connection). Persisting now
    // would resurrect it — fresh agent_runs rows (and, via
    // captureThreadData, messages/metadata/cache) holding only this
    // run's data, silently undoing the user's deletion.
    if (ACTIVE_CONNECTIONS.get(threadId)?.threadDeleted) return;

    // Reserved dep keys (this run's injected secrets) come from the
    // runner ALS — storeRun only ever runs inside that scope. The
    // non-contract key is added unconditionally so the redaction never
    // depends on ALS presence alone. See redactReservedContext.
    const reserved = new Set([...getReservedDepKeys(), "mcp_connectors"]);
    const compactedEvents = compactEvents(events).map((event) =>
      redactReservedEvent(event as { input?: { context?: unknown } }, reserved) as BaseEvent,
    );
    const safeInput = redactReservedContext(input as { context?: unknown }, reserved) as RunAgentInput;
    // The INSERT is conditional on the deleted_threads tombstone's
    // absence — one atomic statement, so a delete that committed before
    // this statement starts is honored even when the in-memory marker
    // above missed the run (a run that registered its connection after
    // deleteThread's map read). rowCount 0 = tombstoned: skip the
    // persistence AND the cache merge below (merging would re-seed the
    // sidebar with a thread that no longer exists in PG).
    const result = await query(
      `INSERT INTO agent_runs (thread_id, run_id, parent_run_id, events, input, version)
       SELECT $1, $2, $3, $4::jsonb, $5::jsonb, $6::int
       WHERE NOT EXISTS (SELECT 1 FROM deleted_threads WHERE thread_id = $1)`,
      [
        threadId,
        runId,
        parentRunId ?? null,
        JSON.stringify(compactedEvents),
        JSON.stringify(safeInput),
        SCHEMA_VERSION,
      ],
    );
    if ((result.rowCount ?? 0) === 0) return;
    // Read-through refresh: the sync readers (CopilotKit's runtime exposes
    // /threads/:id/events and /threads/:id/state backed by the caches) used
    // to serve the PRE-RUN history after a run — eventsCache was only ever
    // populated by connect(). Merge this run's persisted events into the
    // cache with the same verifier-safe treatment connect() applies before
    // replaying: RUN_ERROR filtered out, and any run left unterminated by
    // that filter closed with a synthetic RUN_FINISHED (AG-UI's verifier
    // locks on a replayed RUN_ERROR mid-stream AND on a RUN_STARTED that
    // follows an unterminated run).
    const priorEvents = this.eventsCache.get(threadId) ?? [];
    this.eventsCache.set(
      threadId,
      compactEvents(
        buildReplayEvents([...priorEvents, ...compactedEvents]),
      ),
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

  /**
   * Whether the events cache contains a runId the given snapshot lacks —
   * i.e. a storeRun merged a run committed AFTER the snapshot was read,
   * so the snapshot is stale and must not overwrite the cache (see the
   * startConnect read-through comment).
   */
  private cacheHoldsRunOutsideSnapshot(
    threadId: string,
    snapshotRunIds: Set<string>,
  ): boolean {
    const cached = this.eventsCache.get(threadId);
    if (!cached) return false;
    for (const event of cached) {
      const runId = (event as { runId?: unknown }).runId;
      if (typeof runId === "string" && runId !== "" && !snapshotRunIds.has(runId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Atomically claim the run lock for a thread. The conditional upsert
   * only takes the lock when the stored state says not-running (the
   * ON CONFLICT ... WHERE guard), and RETURNING tells whether THIS call
   * won it — false means another run holds the lock (or won the race).
   */
  private async acquireRunState(
    threadId: string,
    runId: string,
  ): Promise<boolean> {
    const result = await query<{ is_running: boolean }>(
      `INSERT INTO run_state (thread_id, is_running, current_run_id, updated_at)
       VALUES ($1, true, $2, now())
       ON CONFLICT (thread_id) DO UPDATE SET
         is_running = true,
         current_run_id = EXCLUDED.current_run_id,
         updated_at = now()
       WHERE run_state.is_running = false
       RETURNING is_running`,
      [threadId, runId],
    );
    if (result.rows.length > 0) return true;

    // The lock is held. Distinguish a LIVE holder from a STALE row: this
    // process knows exactly which runs are actually active
    // (ACTIVE_CONNECTIONS — registered synchronously right after a
    // successful acquire, so no await can interleave between the two).
    // A row whose current_run_id has no live map entry was left behind by
    // a teardown whose release hit a transient DB failure (teardownRun is
    // best-effort) — without this recovery the thread stays wedged with
    // "Thread already running" until the next process restart. Steal it,
    // conditional on the SAME row we inspected so a concurrent legitimate
    // release/re-acquire between the read and the write can't be
    // clobbered (0 rows updated → someone else changed the state → not
    // ours to take).
    //
    // The liveness check is in-process by design: run_state is shared PG,
    // but a multi-instance deploy would need shared state for this (see
    // the class doc on the future Redis migration) — today the app is
    // single-instance, the same assumption the boot-time run-state reset
    // already makes.
    //
    // Grace window: any genuine holder registers its connection
    // synchronously after acquiring, so a map-absent row YOUNGER than the
    // grace cannot be stale — only a row that has been map-orphaned for
    // at least this long is stolen.
    const held = await query<{ current_run_id: string | null; updated_at: Date }>(
      `SELECT current_run_id, updated_at FROM run_state WHERE thread_id = $1`,
      [threadId],
    );
    const heldRow = held.rows[0];
    const heldRunId = heldRow?.current_run_id ?? null;
    const connection = ACTIVE_CONNECTIONS.get(threadId);
    if (connection && connection.runId != null && connection.runId === heldRunId) {
      return false; // genuinely running in this process
    }
    // Grace: a just-acquired lock registers its map entry SYNCHRONOUSLY
    // after the acquire returns (no await in between), so a map-absent
    // row younger than the grace is a winner still mid-registration in a
    // concurrent race — refuse it normally instead of stealing.
    const updatedAt = heldRow?.updated_at ? new Date(heldRow.updated_at).getTime() : NaN;
    const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Infinity;
    if (ageMs < STALE_LOCK_GRACE_MS) return false;
    const steal = await query<{ is_running: boolean }>(
      `UPDATE run_state SET is_running = true, current_run_id = $2, updated_at = now()
       WHERE thread_id = $1 AND is_running = true
         AND current_run_id IS NOT DISTINCT FROM $3
       RETURNING is_running`,
      [threadId, runId, heldRunId],
    );
    if (steal.rows.length > 0) {
      console.warn("[runner] stole a stale run lock (previous release failed)", {
        threadId,
        staleRunId: heldRunId,
        newRunId: runId,
      });
      return true;
    }
    return false;
  }

  /**
   * Shared end-of-run cleanup — called on EVERY exit path (success,
   * mid-run failure, pre-run failure). Two guarded steps:
   *
   * 1. Release the run lock only when THIS run still owns it: the
   *    `current_run_id` match fails when a successor run re-claimed the
   *    state after a boot reset — this run's teardown must not release
   *    the SUCCESSOR's lock (that would let a third run interleave with
   *    it). Note stop() no longer releases the lock itself: the aborted
   *    run keeps it through persistence and releases it HERE (see stop()).
   * 2. Remove the map entry only while it is still this run's OBJECT
   *    (identity check against the captured connection): a replacement
   *    run's entry keeps its agent/subject references — its stop button
   *    and event routing depend on them.
   *
   * Best-effort: the state step is individually guarded so a transient
   * DB failure can't skip the map cleanup (and vice versa). A release
   * that fails on a transient DB error does NOT wedge the thread
   * permanently: acquireRunState detects the stale row (current_run_id
   * with no live ACTIVE_CONNECTIONS entry) and steals it on the next
   * run attempt.
   */
  private async teardownRun(
    threadId: string,
    connection: ActiveConnectionContext,
    runId: string,
  ): Promise<void> {
    try {
      const state = await this.getRunState(threadId);
      if (state.currentRunId === runId) {
        await this.setRunState(threadId, false);
      }
    } catch (err) {
      console.error("[runner] run-state release failed", {
        threadId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (ACTIVE_CONNECTIONS.get(threadId) === connection) {
      connection.agent = undefined;
      connection.runSubject = undefined;
      connection.currentEvents = undefined;
      ACTIVE_CONNECTIONS.delete(threadId);
    }
  }

  /**
   * Resolve a thread's ownership row from PG — the cross-process source of
   * truth for whether a threadId exists and who owns it. thread_metadata
   * carries the owner (null user/org on legacy rows → ""); a thread with
   * runs but no metadata row is treated as ownerless (the same shape the
   * cache refresh derives). Returns null when the thread doesn't exist at
   * all — the caller decides what "absent" means (startRun: creatable;
   * startConnect: nothing to replay). The thread cache deliberately isn't
   * consulted here: it's per-process and empty right after boot, so a
   * cache-missed EXISTING thread must still resolve its real owner.
   */
  private async getThreadOwnership(
    threadId: string,
  ): Promise<
    Pick<LocalThreadEndpointRecord, "organizationId" | "createdById"> | null
  > {
    const meta = await query<{ user_id: string | null; org_id: string | null }>(
      `SELECT user_id, org_id FROM thread_metadata WHERE thread_id = $1`,
      [threadId],
    );
    if (meta.rows[0]) {
      return {
        organizationId: meta.rows[0].org_id ?? "",
        createdById: meta.rows[0].user_id ?? "",
      };
    }
    const runs = await query<{ has_runs: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id = $1) AS has_runs`,
      [threadId],
    );
    if (runs.rows[0]?.has_runs) {
      return { organizationId: "", createdById: "" };
    }
    return null;
  }

  // ─── Thread snapshot capture (preserved from PersistentAgentRunner) ────

  private async captureThreadData(request: AgentRunnerRunRequest): Promise<void> {
    // Deleted-mid-run guard (see storeRun): a thread deleted while this
    // run streamed must not be resurrected by the run's final write.
    if (ACTIVE_CONNECTIONS.get(request.threadId)?.threadDeleted) return;
    // DB-level backstop for the runs the in-memory marker cannot reach
    // (a connection registered after deleteThread's map read): a
    // tombstoned thread id is dead — no snapshot writes, no cache re-seed.
    if (await this.isThreadTombstoned(request.threadId)) return;

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

  /**
   * Whether the thread id carries a deleted_threads tombstone — the
   * DB-level fact (committed atomically with deleteThread's row deletes)
   * that the id is dead. Gates the run start (startRun refuses the id)
   * and the persistence window (storeRun's conditional INSERT,
   * captureThreadData's skip) so a delete vs. run race can neither
   * resurrect the thread nor leave orphan rows behind it.
   */
  private async isThreadTombstoned(threadId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM deleted_threads WHERE thread_id = $1`,
      [threadId],
    );
    return result.rows.length > 0;
  }
}

# Architecture

How tackui works end-to-end: request flow, the CopilotKit runtime, the agent
registry, thread persistence, and the AG-UI backend contract. For agent CRUD /
auth specifics see [agent-registry.md](./agent-registry.md); for the security model see
[security.md](./security.md); for org/auth see [auth-and-orgs.md](./auth-and-orgs.md).

## Request flow

```
Browser → proxy.ts (cookie gate) → Next.js App → /api/copilotkit (CopilotRuntime)
                                                    ↓ auth + ALS wrapping
                              ↓ AG-UI event stream (SSE)
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
              LangGraph   Agno     any AG-UI server
```

The CopilotKit runtime is a thin server-side proxy that holds the `agents` map.
Each agent speaks AG-UI to its backend. The frontend never talks to backends
directly — it talks to the runtime, making agents pluggable. The runtime
handler resolves the user from the session cookie and wraps the entire request
in `AsyncLocalStorage` so the runner can scope threads per user.

Auth/API routing:

```
Browser → proxy.ts (cookie gate) → Next.js App
                                       ↓
                          /api/auth/*     → Better Auth (signup, signin, callback)
                          /api/copilotkit → CopilotRuntime (auth + ALS wrapping)
                          /api/agents*    → REST (getCurrentUser checks)
                          /api/threads*   → REST (getCurrentUser + userId + orgId scoping)
```

`proxy.ts` also applies per-IP flood protection (see
[security.md](./security.md#rate-limiting)) and open-redirect-safe redirects.

Server-side logging convention: `console.error` with a bracketed prefix and
JSON context — `[copilotkit] handler error` in the runtime route's try/catch
around `innerHandler`, `[runner] run failed` in `PostgresAgentRunner.run()`'s
error callback. No logging library.

## Agent registry (runtime side)

Agents are stored in a Postgres table (`agents`, shared with the thread runner
+ Better Auth via the same `pg.Pool` — see `lib/db/pg.ts`) and managed at
runtime via the `/agents` admin page (sidebar + icon or `/agents?add=1`) or
the `/api/agents` REST API. No restart is needed when adding, editing, or
removing agents — `CopilotRuntime` receives `getAgents` as a factory function,
called per-request, so DB changes reflect immediately on the next `/run`.
An org with zero agents resolves to an EMPTY registry, not an error: `/info`
answers 200 with no agents (the client shows its "No agents yet" empty state
with a clean console), and any run/stop/connect against an unknown agent id
fails closed with the runtime's 404 "Agent not found". Only genuinely broken
conditions throw — chiefly an unauthenticated caller, for which no org exists
to scope the registry by.

CRUD, REST smoke tests, per-agent auth, and identity forwarding are documented
in [agent-registry.md](./agent-registry.md).

## Conversation History Contract

Per the [AG-UI protocol](https://docs.ag-ui.com/concepts/events#runstarted),
this frontend sends the **full conversation history** (`input.messages`) on
every `/run` request. This is the source of truth for message history — the
frontend (CopilotKit's `agent.messages` + `PostgresAgentRunner`) stores and
manages all messages.

**Thread ids are per agent** — a `threadId` is only meaningful within the
agent that created it. The frontend never reuses a thread id across two
agents (CopilotKit keys threads by agent), and the platform-side session
store matches on `(user_id, thread_id)` — it deliberately does NOT check
that a run's component matches the session's component (parity with the
stock AG-UI router). So two different agents writing into the same
`thread_id` for the same user would interleave history; the frontend's
keying is what prevents that, and any new backend consuming these threads
must keep the same per-agent keying.

Agent backends have two valid options for handling `input.messages`:

1. **Stateless (read history):** Read `input.messages` from the request body
   and pass them to the LLM as conversation context. No server-side storage
   needed. This is the simplest approach and works for any AG-UI-compliant
   backend.

2. **Stateful (self-managed history):** Maintain their own conversation
   storage (e.g. Agno's session DB, LangGraph checkpoints) and ignore the
   frontend history. The frontend sending full history is redundant but
   harmless — the backend reads only what it needs (typically the last user
   message).

Either approach works. The frontend does not assume which one a backend uses,
so contributors can connect any AG-UI-compatible backend without frontend
changes.

**When adding a new agent backend**, document in that backend's own repo which
strategy it uses so users know whether server-side session storage is required.

## Thread persistence (PostgresAgentRunner)

`lib/agents/pg-runner.ts` — `PostgresAgentRunner` extends `AgentRunner` from
`@copilotkit/runtime/v2`, owns its `ACTIVE_CONNECTIONS` Map for live-bridging,
and shapes replay through `buildReplayEvents`: persisted `RUN_ERROR` events
are filtered out (the AG-UI verifier locks on them mid-stream, making
failed-run threads permanently unreadable on reconnect), and an unterminated
run is closed with a synthetic `RUN_FINISHED` — closing any message,
tool-call, or `REASONING_*` sequences the errored run left open first — when
a later `RUN_STARTED` would otherwise follow in the same verified stream:
either a later run's `RUN_STARTED` already in the history (the next run's
start would otherwise trip the verifier's "run still active" lock and reject
the whole replay), or a live bridge about to append an in-flight run's
buffered events (whose first event is that run's `RUN_STARTED`) to the same
stream. A run left unterminated at the END of the history with no bridge
following stays unresolved: the spec makes resolving a truncated final run
the consumer's business, and re-presenting the failure as a completed turn
would erase what the live client actually watched. Replay history also stops
at each run's first surviving terminal event: stray bookkeeping recorded
after a `RUN_FINISHED` (duplicate terminators, trailing traffic) is dropped —
the verifier rejects everything but `RUN_STARTED` after a `RUN_FINISHED` —
while the next run's own `RUN_STARTED` is kept. A `RUN_ERROR` is deliberately
NOT such a cut point: `compactEvents` persists an errored run's buffered
message/tool-call traffic after the `RUN_ERROR` (unclosed sequences are
flushed at stream end), so events following it in the record were emitted
before it in real time, and dropping them would erase the run's real partial
history. The same shaping applies when a run is merged into
the events cache, so sync reads (`/threads/:id/events`) get identical
history. It exposes
`renameThread`/`deleteThread`, used by `PATCH/DELETE /api/threads/[id]` — the
local SSE runner doesn't support CopilotKit's Intelligence-platform-only
`useThreads` mutations.

Persisted history is keyed by thread: each run's raw event stream lives in
`agent_runs` under `(thread_id, run_id)`, unique **per thread** since
migration 0016. The original global unique constraint on `run_id` alone
dropped a run whose client-supplied id was reused on a different thread (the
persist raised a uniqueness violation and the stream completed without a
persisted row); the composite scopes the guarantee to what history is keyed
by. A duplicate run id within one thread is still rejected — duplicate
detection is unchanged, only the cross-thread case was relaxed.

### Run lock lifecycle

The per-thread run lock lives in the `run_state` table
(`is_running`, `current_run_id`). `startRun` claims it with an **atomic
conditional upsert** (`acquireRunState`: `INSERT … ON CONFLICT … WHERE
is_running = false RETURNING`) — the check-then-act pair it replaced let two
concurrent runs on the same thread both pass the "not running" check.

Every exit path goes through `teardownRun`, which releases the lock **only
while `current_run_id` still matches this run** and removes the
`ACTIVE_CONNECTIONS` entry **only while it's still this run's object**.

`stop()` deliberately does NOT release the lock — it only flags the
connection (`stopRequested`) and calls `abortRun()`. The aborted run keeps
the lock through its persistence window (partial `storeRun` +
`captureThreadData` happen after the abort lands) and releases it in its own
teardown, which the `current_run_id` guard makes safe. The earlier design
released the lock inside `stop()`, which opened two races: a replacement run
could acquire the freed lock and interleave with the aborted run's
persistence (clobbered snapshots, out-of-order history), and the
abort-failure "restore" could overwrite a successor's `current_run_id` with
the stale id — wedging `is_running = true` until the next boot. Trade-off:
between `stop()` and the aborted run's teardown, `is_running` still reads
true, so an *immediate* replacement run gets "Thread already running" for
the abort+persistence window (sub-second in practice; a hung backend that
ignores the abort holds the lock until the boot reset, the same failure mode
a hung non-stopped run always had).

A third recovery covers the failure mode between those two: `teardownRun`'s
release is best-effort, so a **transient DB failure during release** used to
leave `is_running = true` with no runtime path back — every subsequent run
refused with "Thread already running" until the next restart. `acquireRunState`
now detects the orphan: a `current_run_id` with **no live `ACTIVE_CONNECTIONS`
entry in this process** is stale (a genuine holder registers its map entry
synchronously right after the acquire — no await in between — so a fresh
map-absent row is a winner still mid-registration in a concurrent race, not
an orphan), and after a grace window (`STALE_LOCK_GRACE_MS`, 10s) the next
run attempt steals the lock with a loud log line. The grace is what makes
the steal safe; the liveness check is in-process by design (single-instance,
the same assumption as the boot-time reset).

Failure handling is split by a `preRun` flag: **pre-run failures** (historic
read, parent-run resolution) release the lock and rethrow — the run stream
*errors*, matching the old contract; **mid-run failures** persist
best-effort, release, and complete the stream. The ENTIRE mid-run unwind
(finalize events, persistence, snapshot capture) is one guarded block so a
throw from any step — including `finalizeRunEvents` — can't skip the
teardown. `instrumentation.ts` also resets stale
`is_running = true` rows at boot (single-instance constraint: no run can be
in flight in a process that is still starting), so a crash no longer leaves
threads permanently "already running".

`connect()` never replays a run twice: when a run is in flight, live
events are bridged from its subject — but if the historic replay snapshot
already contains that run's id (the connect landed between `storeRun` and
teardown), the bridge is skipped entirely. Every event a run emits is
emitted *before* `storeRun` persists it, so a covered replay means the
subject can only add duplicates (the messageId dedup doesn't cover
`TOOL_CALL_*`/`STATE_*`, and a duplicate `TOOL_CALL_START` trips the AG-UI
verifier).

### In-memory cache (sync interface bridge)

CopilotKit's `LocalThreadEndpointRunner` interface requires the 5 thread
methods (`listThreads`, `getThreadMessages`, `getThreadEvents`,
`getThreadState`, `clearThreads`) to be **synchronous** — they return concrete
values, not Promises. But `pg` (node-postgres) is async-only. There is no
maintained sync Postgres driver for Node.js.

`PostgresAgentRunner` bridges this with 3 in-memory `Map`s (`threadCache`,
`messageCache`, `eventsCache`) that act as a read-through cache. **PG is
always the source of truth:**

1. **Write-through:** write paths (`captureThreadData`, `deleteThread`,
   `renameThread`) update PG FIRST, then the cache. If the cache update fails,
   PG is still correct. `deleteThread` clears all three caches **regardless
   of deleted row counts** (a first in-flight run has no persisted rows yet,
   but the thread is already user-visible) and marks the live connection
   `threadDeleted` when a run is still streaming: the run's persistence
   window (`storeRun` + `captureThreadData`) checks the marker and skips
   writing, so a delete racing a run cannot resurrect the thread — the
   marker dies with the connection at teardown. The marker is only the
   first line of defense: it cannot reach a run that registers its
   connection after the delete's map read, or one that starts after the
   delete commits (to the ownership gate a deleted thread reads as a
   "creatable" brand-new thread). The same transaction therefore writes a
   `deleted_threads` tombstone: `startRun` refuses a tombstoned thread id
   right after its lock claim, `storeRun`'s INSERT is conditional on the
   tombstone's absence, and `captureThreadData` skips entirely — a deleted
   thread stays deleted. Tombstones older than 30 days are pruned inside
   each delete's transaction (no background timer; thread ids are
   client-generated UUIDs, so no legitimate flow re-creates a deleted id).
2. **Read-through on async paths:** `connect()` and `run()` (both async via
   fire-and-forget Observable pattern) fetch from PG INTO the cache before
   completing, and `storeRun` merges each run's persisted events into
   `eventsCache` when it persists them — so the sync readers (CopilotKit's
   runtime `/threads/:id/events` and `/threads/:id/state` endpoints) reflect
   completed runs immediately, not just after the next `connect()`.
   `connect()`'s read-through write is **skipped when the cache already
   holds a runId absent from its snapshot** — a run committing between the
   history read and the write merged itself into the cache, and the older
   snapshot would regress the sync readers to pre-run history until the
   next write on the thread.
3. **Sync methods read cache ONLY** — no DB I/O, no Promises.

Single-instance deployments (OSS self-hosters, solo mode) have no staleness —
every write updates the local cache synchronously after the DB write.
`useThreads` refetches on run completion and on window focus, so the sidebar
always reflects the latest cache state.

**Multi-instance SaaS caveat:** each instance has its OWN in-memory cache. A
thread created on instance A won't appear in instance B's cache until B
refreshes from PG (on the next `connect()`/`run()` for that thread, or on
restart). The `deleteThread`/`renameThread` ownership check reads cache first
— if a thread exists in PG but not in this process's cache (created on another
instance), the check fails. This is acceptable for single-instance OSS deploys;
see [Future](#future--extension-points) for the scaling path.

## Postgres (auth + agent store)

Auth and agent storage share a single `pg.Pool` (see `lib/db/pg.ts`),
constructed from `DATABASE_URL`. Better Auth receives the pool via
`betterAuth({ database: getPool(), ... })` and wraps it in Kysely's
`PostgresDialect` internally. The `databaseHooks.user.create.after` hook
(first-user-is-admin bootstrap) runs raw `query()` calls against the same pool
— note `"user"` is a reserved word in Postgres and must be double-quoted in
all raw SQL.

Better Auth's tables (`user`, `session`, `account`, `verification`,
`organization`, `member`, `invitation`) are created automatically on boot via
`ensureAuthTables()` in `instrumentation.ts` (or manually via
`npx @better-auth/cli migrate --config lib/auth/auth.ts`). The app's own tables
(`agents`, `agent_runs`, `run_state`, `thread_messages`, `thread_metadata`) are
created automatically on boot via `runMigrations()` in `instrumentation.ts`
(or manually via `npm run migrate`, see `lib/db/migrations/`). Boot runs both —
no manual step is required for a normal deploy.

## Supported agent kinds

There are no agent kinds — agents were reduced to a single AG-UI adapter.
The runtime connects via `HttpAgent` (from `@ag-ui/client`) to any
AG-UI-speaking endpoint — Agno, CrewAI, Pydantic AI, Mastra, LangGraph (via
ag-ui-langgraph), or custom — at a full URL (e.g. `http://localhost:8000/agent`).

> If a second kind is ever genuinely demanded, re-add the column + adapter in
> the same migration as its config fields.

## Chat UI

### Tool-result rendering

Tool-call rendering uses the `useRenderTool` wildcard in
`components/tools/tool-renders.tsx` → inline ChatGPT/Claude-style activity
rows: status icon (spinner → ✓/✗), humanized tool name, inline arg preview;
the expanded panel renders args as key-value rows and results as rendered
markdown (`react-markdown` + `remark-gfm` — no raw HTML, safe by default
against backend-supplied content), HTML tables (array-of-objects), pretty
JSON, or plain text. String results that arrive JSON-escaped (literal `\n` /
`\"` / `\uXXXX` — e.g. Agno/Tavily) are decoded first via
`normalizeResultString` (conservative gate: zero real newlines + escape
artifacts present). No size caps anywhere — only a visual height clip with
Show all/Show less; `useMemo` + `React.memo` keep big results parsing once.
Pure helpers live in `lib/tools/format.ts` (tested).

### Multi-agent switching

`chat-shell.tsx` keys `CopilotChat` by `agentId + threadId` and clears the
agent's in-memory messages on unmount — this prevents duplicate messages on
switch, since CopilotKit's `/connect` replays all historic events and
`AbstractAgent.apply()` appends content to existing messages.

### Human-in-the-loop interrupts

`useInterrupt` (CopilotKit v2) with the handlers in
`components/hitl/approval-card.tsx` render agent interrupts as approval
cards in the chat.

### Chat markdown tables + the Streamdown attribute bug

Assistant/user messages render through Streamdown (transitive via CopilotKit,
which pins `streamdown: ^1.3.0` → resolves 1.6.x). Streamdown 1.6.x's table
component stamps the inner `<table>` with its wrapper's
`data-streamdown="table-wrapper"` attribute (prop-spread bug; fixed upstream in
streamdown 2.x). CopilotKit's stylesheet styles
`[data-streamdown="table-wrapper"]` with `display: flex`, so that rule lands on
the table itself and destroys the table's column grid — header and body columns
sized independently (misaligned), rows shrink-wrapped inside the full-width box
(dead right space), black gap between header band and first row.
`app/globals.css` carries a deliberate CSS shim
(`[data-copilotkit] [data-streamdown="table-wrapper"] table { display: table }`
+ hug-content/band/hairline polish): don't "clean it up" without first
confirming the installed streamdown is past the bug — the selector only matches
the buggy DOM (once the attribute is fixed upstream it stops matching and the
rule can be deleted). Upgrading CopilotKit alone does NOT fix it (verified
through 1.79.0 — every release, canary included, still pins `^1.3.0`); the
root-cause path is an npm override to streamdown 2.7.0 with its own regression
pass (2.x restructured code-block rendering).

Two related traps:

1. The utility classes Streamdown emits are partially inert — the app's
   Tailwind build doesn't scan node_modules, so `bg-muted/80`, `bg-muted/40`,
   `divide-border`, `border-border` have no rules in the built CSS; the
   effective chat-table styling comes from CopilotKit's
   `[data-streamdown=…]` attribute selectors (inside `@layer components`,
   which unlayered `globals.css` rules beat on cascade + specificity).
2. Customizing the renderer (`CopilotChat`'s `chatView → messageView →
   assistantMessage` slot chain, e.g. `markdownRenderer`) is available if
   Streamdown misbehaves further — the markdown renderer slot receives
   `{ content }` and defaults to `<Streamdown>`.

### Error boundaries

`app/error.tsx` + `app/global-error.tsx` — render-crash recovery UI;
`error.tsx` handles child-segment errors inside the layout,
`global-error.tsx` catches root layout failures (replaces `<html>`/`<body>`).
Both call `Sentry.captureException` before rendering the fallback UI.

## Error tracking

Sentry integration via `@sentry/nextjs` — automatically captures uncaught
exceptions on both server and client. No-op when `SENTRY_DSN` (server) /
`NEXT_PUBLIC_SENTRY_DSN` (client) is not set, so self-hosters can opt out
entirely by simply not setting the env vars.

- `instrumentation-client.ts` / `sentry.server.config.ts` /
  `sentry.edge.config.ts` — SDK init (reads DSN from env). The client init
  lives in `instrumentation-client.ts` (Next.js 16 file convention) because
  Turbopack no longer auto-injects `sentry.client.config.ts` into the client
  bundle. The server/edge configs are imported from `instrumentation.ts`
  (runtime-guarded: nodejs imports `sentry.server.config`, edge imports
  `sentry.edge.config`). `instrumentation.ts` also exports
  `onRequestError = Sentry.captureRequestError` so route-handler / Server
  Component / middleware errors reach Sentry — without it, Next.js logs them
  but they never arrive. `instrumentation-client.ts` exports
  `onRouterTransitionStart = Sentry.captureRouterTransitionStart` (required
  by the SDK for client-side route instrumentation).
- `next.config.ts` — wrapped in `withSentryConfig()` (source map upload,
  tree-shaking) + `tunnelRoute: "/sentry-tunnel"` (proxies client envelopes
  through a same-origin endpoint so ad blockers — which filter-list Sentry's
  ingest domain — don't block them).
- `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` —
  transaction trace sampling (default: 0.1 = 10%). Set to 0 to disable
  performance traces.

## Static assets & branding

- All icons use the `app/` file convention: `icon.svg` (theme-aware static
  SVG favicon), `apple-icon.tsx` (generated 180×180 PNG via `next/og`),
  `opengraph-image.tsx` + `twitter-image.tsx` (generated 1200×630
  social-share cards via `next/og`, reusing `OgCard` from
  `lib/brand/pin.tsx`). Next.js auto-wires these into `<head>` with
  content-hashing. `public/` is empty and only needed for static
  URL-referenced assets like `robots.txt` — if any are added later, re-add
  the `COPY --from=builder /app/public ./public` line to the Dockerfile.
- `app/layout.tsx` sets `metadataBase` from `BETTER_AUTH_URL` so OG/Twitter
  image URLs resolve to absolute production URLs.

## Future / extension points

- **PG LISTEN/NOTIFY cache invalidation for multi-instance:** the in-memory
  `Map`s in `PostgresAgentRunner` are per-process. For horizontal scaling
  (multiple Next.js instances), add a dedicated LISTEN connection that evicts
  cache entries on NOTIFY from other instances. Keeps self-host at one
  dependency (PG). Redis only needed if you go multi-region or add it for
  another reason (rate limiting, jobs). Not needed for single-instance OSS
  deploys.
- **Generative UI / shared state (`useCoAgent`)** — requires backends to emit
  `STATE_SNAPSHOT`/`STATE_DELTA` events; no backend currently does.
- **Additional backends** — CrewAI, Mastra, Pydantic AI, Google ADK, AWS
  Strands, etc.
- **Integration test suite (testcontainers + real Postgres):** pg-mem doesn't
  support `WITH RECURSIVE` CTEs (used by `PostgresAgentRunner.getHistoricRuns`),
  cross-statement `ROLLBACK`, or pg_catalog index metadata. DONE: the tests
  that need those run against a real Postgres via `@testcontainers/postgresql`
  (`lib/db/test-postgres.ts` — per-file container, skip-with-note when Docker
  is down). What remains here is broader integration coverage: multi-connection
  consistency tests would need the same harness extended beyond the current
  suites.

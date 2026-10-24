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

CRUD, REST smoke tests, per-agent auth, and identity forwarding are documented
in [agent-registry.md](./agent-registry.md).

## Conversation History Contract

Per the [AG-UI protocol](https://docs.ag-ui.com/concepts/events#runstarted),
this frontend sends the **full conversation history** (`input.messages`) on
every `/run` request. This is the source of truth for message history — the
frontend (CopilotKit's `agent.messages` + `PostgresAgentRunner`) stores and
manages all messages.

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
and its smart-replay `connect()` filters `RUN_ERROR` events before
`compactEvents` to avoid the AG-UI verifier lock bug. It exposes
`renameThread`/`deleteThread`, used by `PATCH/DELETE /api/threads/[id]` — the
local SSE runner doesn't support CopilotKit's Intelligence-platform-only
`useThreads` mutations.

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
   PG is still correct.
2. **Read-through on async paths:** `connect()` and `run()` (both async via
   fire-and-forget Observable pattern) fetch from PG INTO the cache before
   completing.
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
  support `WITH RECURSIVE` CTEs (used by `PostgresAgentRunner.getHistoricRuns`)
  or cross-statement `ROLLBACK`. The 3 skipped tests in
  `lib/agents/pg-runner.test.ts` cover these paths. A testcontainers-based
  integration suite would run them against a real PG container in CI.

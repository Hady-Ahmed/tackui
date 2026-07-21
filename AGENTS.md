# AGENTS.md

## Project Overview

Unified AG-UI frontend — a ChatGPT/Gemini-style chat application for custom agents
speaking the AG-UI protocol. Built on CopilotKit (the 1st-party AG-UI client) with
a pluggable agent registry so any AG-UI-compatible backend can be added with zero
UI code changes.

## Tech Stack

- **Framework:** Next.js 16 (App Router, TypeScript, Tailwind CSS v4)
- **AI Protocol:** AG-UI (Agent-User Interaction Protocol)
- **Client:** CopilotKit v1.62+ (`@copilotkit/react-core`, `@copilotkit/react-ui`)
- **Runtime:** CopilotKit Runtime v2 (`@copilotkit/runtime/v2`)
- **AG-UI Client SDK:** `@ag-ui/client` (for generic AG-UI HTTP agents)
- **Auth:** Better Auth (`better-auth`) — email/password, OAuth (Google/GitHub),
  OIDC SSO (`genericOAuth` plugin), admin roles (`admin` plugin)

## Commands

```bash
npm run dev          # Start dev server (http://localhost:3000)
npm run build        # Production build
npm run start        # Start production server
npm run lint         # ESLint
npm run test         # Run tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run create-admin # Create/promote an admin user (npm run create-admin <email> <password> [name])
```

Type checking: `npx tsc --noEmit`

Tests use [vitest](https://vitest.dev) with an in-memory Postgres emulator
(`pg-mem`) — no Docker required, no cleanup needed between runs. See
`vitest.config.ts` and `vitest.setup.ts` for configuration.

### Testing conventions

When adding new functionality, add tests alongside it:

- **API routes** — test each exported handler (`GET`, `POST`, `PATCH`,
  `DELETE`) for success, not-found, and validation-failure cases. Construct
  `Request` objects directly and assert on `res.status` + `await res.json()`.
  Use `beforeEach` to clear the DB via the store's public API.
- **Store / library functions** — unit-test each exported function. Cover
  happy paths, edge cases (missing records, duplicates), and zod validation
  rejections.
- **Test files** — place `*.test.ts` next to the file under test (e.g.
  `lib/agents/agent-store.test.ts`, `app/api/agents/route.test.ts`).
- **External calls** — mock with `vi.stubGlobal` (e.g. `fetch` in
  `/api/agents/reachability-probe` tests). Restore in `afterEach`.
- **No production code changes for testability** — the in-memory pg-mem
  emulator + vitest's `isolate: true` handle DB isolation without needing
  test-only exports. pg-mem doesn't support `WITH RECURSIVE` CTEs or
  cross-statement `ROLLBACK` — those paths have skipped tests, to be
  covered by a future testcontainers integration suite.

## Project Structure

```
app/
  api/copilotkit/[[...path]]/route.ts  # CopilotKit runtime (catch-all — matches /api/copilotkit and all sub-paths)
  api/agents/route.ts          # REST: GET/POST /api/agents (list, create)
  api/agents/[id]/route.ts     # REST: GET/PATCH/DELETE /api/agents/[id]
  api/agents/reachability-probe/route.ts  # REST: POST /api/agents/reachability-probe (reachability probe)
  api/auth/[...all]/route.ts   # Better Auth handler (signup, signin, callback)
  api/auth/config/route.ts     # GET enabled providers (for self-configuring login UI)
  api/threads/[id]/route.ts    # REST: PATCH/DELETE /api/threads/[id] (rename, delete conversations)
  agents/page.tsx              # Admin UI — add/edit/delete agents + test connection + user management
  error.tsx                    # Route error boundary — render-crash recovery (centered card + Reload)
  global-error.tsx             # Root error boundary — catches layout-level failures (renders own <html>)
  login/page.tsx               # Login (email/password + social + SSO)
  signup/page.tsx              # Sign up (email/password + social + SSO)
  layout.tsx                   # Root layout — wraps app in CopilotKitProvider + FOUC-free theme init script
  page.tsx                     # Main chat page (client component)
  globals.css                  # Global styles + Tailwind (class-based dark mode via @custom-variant)

lib/
  agents/
    agents.config.ts           # AgentEntry / AgentKind types (no runtime config)
    agent-store.ts             # Async CRUD for agents table (zod-validated, pg.Pool-backed)
    registry.ts                # getAgents() factory — reads DB, builds agents map (async)
    pg-runner.ts               # PostgresAgentRunner — AgentRunner impl with thread endpoints + smart-replay connect() (RUN_ERROR filtering) + in-memory cache bridging sync interface to async PG
    runner-instance.ts         # Shared runner singleton (used by runtime + thread API)
  auth/
    auth.ts                    # Better Auth instance (Postgres Pool adapter, plugins, first-user-is-admin)
    auth-client.ts             # Better Auth React client (signIn, signUp, useSession)
    context.ts                 # getCurrentUser / getRequestUser (session → RequestUser)
    request-context.ts         # AsyncLocalStorage for per-request user (read by runner)
    use-auth-config.ts         # useAuthConfig() hook — fetches /api/auth/config once per page load
  db/
    pg.ts                       # Shared pg.Pool singleton (DATABASE_URL) + query/withTransaction helpers
    migrate.ts                  # Versioned SQL migration runner (lib/db/migrations/*.sql)
    migrations/                 # Versioned .sql files tracked in schema_migrations
      0001_init.sql             # Initial schema: agents, agent_runs, run_state, thread_messages, thread_metadata
  theme.ts                     # useTheme() hook — class-based light/dark, persists to localStorage (useSyncExternalStore)

components/
  agent-sidebar.tsx            # Agent picker + conversation list + status dots + rename/delete + collapsible (useThreads)
  account-menu.tsx             # User avatar, name, email, sign out (useSession)
  theme-toggle.tsx             # Light/dark toggle button (sidebar footer, icon + label)
  chat-shell.tsx               # Chat layout with agent switching + empty-state CTA + collapsible sidebar state + AgentChat wrapper
  users-admin.tsx              # Admin user management (list, set role, ban/unban)
  hitl/
    approval-card.tsx          # Human-in-the-loop interrupt handlers
  tools/
    tool-renders.tsx           # Tool-call visualization (useRenderTool)

proxy.ts                       # Next.js proxy (cookie gate + AUTH_DISABLED bypass)
scripts/
  create-admin.ts              # CLI: create/promote an admin user
```

## Agent Registry

Agents are stored in a Postgres table (`agents`, shared with the thread
runner + Better Auth via the same `pg.Pool` — see `lib/db/pg.ts`) and managed
at runtime via the `/agents` admin page or the `/api/agents` REST API. No
restart is needed when adding, editing, or removing agents — `CopilotRuntime`
receives `getAgents` as a factory function, called per-request, so DB changes
reflect immediately on the next `/run`.

`lib/agents/agents.config.ts` exports only the `AgentEntry` / `AgentKind` types
— it no longer holds runtime configuration.

### Adding an agent

Via the admin UI (`/agents` page → "Add agent" form) or `POST /api/agents` with:

```json
{
  "id": "research",
  "name": "Research Agent",
  "description": "LangGraph-powered web research assistant",
  "kind": "agui",
  "endpoint": "http://localhost:8001/agent"
}
```

Optional fields: `graphId` (langgraph only), `langsmithApiKey` (langgraph only).

### Test connection

Both the admin form and the agents table have a "Test connection" button that
hits `POST /api/agents/reachability-probe`. This performs a server-side `GET` to the endpoint
with a 5s timeout and reports reachability. It catches URL typos and down
servers — it does **not** validate auth, AG-UI protocol compliance, or that the
agent will actually run. The sidebar also shows a status dot per agent (gray =
untested, green = reachable, red = unreachable), re-tested on window focus.

### Supported agent kinds

| Kind       | Adapter                        | Endpoint format                          |
| ---------- | ------------------------------ | ---------------------------------------- |
| `langgraph`| `LangGraphAgent`               | LangGraph Platform API URL (e.g. `:8123`)|
| `agno`     | `HttpAgent` (from @ag-ui/client) | AG-UI endpoint (e.g. `:8000/agui`)     |
| `agui`     | `HttpAgent` (from @ag-ui/client) | Any AG-UI-speaking endpoint             |

> **Note:** If your LangGraph backend uses `ag-ui-langgraph` (AG-UI protocol
> directly, not the LangGraph Platform API), use `kind: "agui"` instead of
> `"langgraph"`. The `LangGraphAgent` adapter expects the LangGraph Platform API
> (`/assistants/search`, `/threads`, etc.), while `ag-ui-langgraph` exposes a
> raw AG-UI endpoint.

### Smoke testing the agent registry

After running migrations, add an agent via the admin UI (`/agents`) or REST:

```bash
# AUTH_DISABLED=true (solo mode) — no session cookie needed.
# Otherwise sign in first and pass `-b cookies.txt` (see Option B in README).
curl -X POST http://localhost:3000/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"id":"test","name":"Test","description":"smoke test","kind":"agui","endpoint":"http://localhost:8000/agent"}'

curl http://localhost:3000/api/agents                 # list
curl -X PATCH http://localhost:3000/api/agents/test \
  -H 'Content-Type: application/json' \
  -d '{"name":"Renamed"}'                              # update
curl -X DELETE http://localhost:3000/api/agents/test   # delete
```

`description` is required (zod-validated). `id` must be lowercase kebab-case
and is immutable after creation.

## Environment Variables

Agents are managed via the `/agents` admin page (stored in Postgres) — no env
vars are required to add or configure agents.

See `.env.example` for optional backend URLs (useful for documentation or
scripts only; the frontend reads endpoints from the DB).

### Auth environment variables

Required unless `AUTH_DISABLED=true`:

- `BETTER_AUTH_SECRET` — secret for signing session cookies (generate with
  `openssl rand -hex 32`)
- `BETTER_AUTH_URL` — public base URL of the app (e.g.
  `http://localhost:3000`)

Optional social providers (omit any you don't want):

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — GitHub OAuth
- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_ISSUER` — external OIDC
  SSO (Keycloak, Authentik, Okta, Entra, etc.)

Solo / no-auth mode:

- `AUTH_DISABLED=true` — skips login entirely; everyone is the single admin.
  No other auth env vars needed. Useful for local dev or single-user
  self-hosted deployments.

## Authentication

Auth is powered by [Better Auth](https://better-auth.com) with:

- **Email/password** sign-up/sign-in
- **Social login** (Google, GitHub) — only enabled if env vars are set
- **OIDC SSO** via `genericOAuth` plugin — for self-hosters with their own IdP
  (Keycloak, Authentik, Okta, Entra, etc.)
- **Admin roles** via `admin` plugin — `admin` and `user` roles
- **Auth-disabled mode** — `AUTH_DISABLED=true` makes everyone the single admin

### Auth architecture

```
Browser → proxy.ts (cookie gate) → Next.js App
                                       ↓
                          /api/auth/*     → Better Auth (signup, signin, callback)
                          /api/copilotkit → CopilotRuntime (auth + ALS wrapping)
                          /api/agents*    → REST (getCurrentUser checks)
                          /api/threads*   → REST (getCurrentUser + userId scoping)
```

**Request user resolution:**

- `getCurrentUser()` (`lib/auth/context.ts`) — resolves the user from the
  session cookie via `auth.api.getSession()`. Used by REST API routes. Returns
  the synthetic admin when `AUTH_DISABLED=true`.
- `getRequestUser(request)` — same but takes a `Request` object. Used by the
  CopilotKit runtime route.
- `getRunnerUser()` (`lib/auth/request-context.ts`) — reads the user from
  `AsyncLocalStorage`. Used by `PersistentAgentRunner` (which has no access to
  the request). The ALS context is set by wrapping the CopilotKit handler in
  `runWithUserAsync()` in the runtime route.

**First user becomes admin:** The `databaseHooks.user.create.after` hook in
`lib/auth/auth.ts` promotes the first user to `admin` role. The
`npm run create-admin` script can also create/promote an admin explicitly.

### Access control

- **Admin role:** Can add/edit/delete agents, test connections, manage users.
- **User role:** Can use all agents and their own conversations; cannot manage
  agents.
- **Thread scoping:** Threads are scoped per user via `user_id` on
  `thread_metadata`. `listThreads` filters by the current user via ALS.
  `deleteThread`/`renameThread` check ownership.

### Postgres (auth + agent store)

Auth and agent storage share a single `pg.Pool` (see `lib/db/pg.ts`),
constructed from `DATABASE_URL`. Better Auth receives the pool via
`betterAuth({ database: getPool(), ... })` and wraps it in Kysely's
`PostgresDialect` internally. The `databaseHooks.user.create.after` hook
(first-user-is-admin bootstrap) runs raw `query()` calls against the same
pool — note `"user"` is a reserved word in Postgres and must be
double-quoted in all raw SQL.

Better Auth's tables (`user`, `session`, `account`, `verification`) are
created via `npx @better-auth/cli migrate --config lib/auth/auth.ts`. The
app's own tables (`agents`, `agent_runs`, `run_state`, `thread_messages`,
`thread_metadata`) are created via `npm run migrate` (see
`lib/db/migrations/`). Each command owns its own tables.

### In-memory cache (sync interface bridge)

CopilotKit's `LocalThreadEndpointRunner` interface requires the 5 thread
methods (`listThreads`, `getThreadMessages`, `getThreadEvents`,
`getThreadState`, `clearThreads`) to be **synchronous** — they return
concrete values, not Promises. But `pg` (node-postgres) is async-only.
There is no maintained sync Postgres driver for Node.js.

`PostgresAgentRunner` bridges this with 3 in-memory `Map`s (`threadCache`,
`messageCache`, `eventsCache`) that act as a read-through cache. **PG is
always the source of truth:**

1. **Write-through:** write paths (`captureThreadData`, `deleteThread`,
   `renameThread`) update PG FIRST, then the cache. If the cache update
   fails, PG is still correct.
2. **Read-through on async paths:** `connect()` and `run()` (both async
   via fire-and-forget Observable pattern) fetch from PG INTO the cache
   before completing.
3. **Sync methods read cache ONLY** — no DB I/O, no Promises.

Single-instance deployments (OSS self-hosters, solo mode) have no
staleness — every write updates the local cache synchronously after the
DB write. `useThreads` refetches on run completion and on window focus,
so the sidebar always reflects the latest cache state.

**Multi-instance SaaS caveat:** each instance has its OWN in-memory cache.
A thread created on instance A won't appear in instance B's cache until B
refreshes from PG (on the next `connect()`/`run()` for that thread, or on
restart). The `deleteThread`/`renameThread` ownership check reads cache
first — if a thread exists in PG but not in this process's cache (created
on another instance), the check fails. This is acceptable for single-
instance OSS deploys. For multi-instance SaaS, see the Future section
below.

## Architecture

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

### Conversation History Contract

Per the [AG-UI protocol](https://docs.ag-ui.com/concepts/events#runstarted),
this frontend sends the **full conversation history** (`input.messages`) on every
`/run` request. This is the source of truth for message history — the frontend
(CopilotKit's `agent.messages` + `PersistentAgentRunner`) stores and manages all
messages.

Agent backends have two valid options for handling `input.messages`:

1. **Stateless (read history):** Read `input.messages` from the request body and
   pass them to the LLM as conversation context. No server-side storage needed.
   This is the simplest approach and works for any AG-UI-compliant backend.

2. **Stateful (self-managed history):** Maintain their own conversation storage
   (e.g., Agno's session DB, LangGraph checkpoints) and ignore the frontend
   history. The frontend sending full history is redundant but harmless — the
   backend reads only what it needs (typically the last user message).

Either approach works. The frontend does not assume which one a backend uses, so
contributors can connect any AG-UI-compatible backend without frontend changes.

**When adding a new agent backend**, document in that backend's own repo which
strategy it uses so users know whether server-side session storage is required.

## v1 Scope

- Streaming chat (token streaming, multi-turn, cancel/resume)
- Human-in-the-loop interrupts (`useInterrupt`)
- Multi-agent switching with per-agent threads (`AgentChat` wrapper in
  `chat-shell.tsx` keys `CopilotChat` by `agentId + threadId` and clears the
  agent's in-memory messages on unmount — this prevents duplicate messages on
  switch, since CopilotKit's `/connect` replays all historic events and
  `AbstractAgent.apply()` appends content to existing messages)
- Tool-call visualization (`useRenderTool`)
- Postgres-backed thread runner with conversation persistence
  (`PostgresAgentRunner` in `lib/agents/pg-runner.ts` — extends `AgentRunner`
  from `@copilotkit/runtime/v2`, owns its `ACTIVE_CONNECTIONS` Map for
  live-bridging, smart-replay `connect()` filters `RUN_ERROR` events before
  `compactEvents` to avoid the AG-UI verifier lock bug, in-memory cache
  bridges the sync `LocalThreadEndpointRunner` interface to async PG — see
  "In-memory cache" section below)
- Multi-conversation sidebar (`useThreads` + auto-refetch on run completion) with
  inline rename + delete (`PATCH/DELETE /api/threads/[id]` — the runner exposes
  `renameThread`/`deleteThread` since the local SSE runner doesn't support
  CopilotKit's Intelligence-platform-only `useThreads` mutations)
- Dynamic agent registry (DB-backed `getAgents()` factory + `/agents` admin UI
  with add/edit/delete + test connection + sidebar status dots)
- Collapsible sidebar (icon-only mode with smooth width transition, persisted
  to localStorage)
- LangGraph + Agno backends wired first
- Authentication (Better Auth): email/password, Google/GitHub OAuth, OIDC SSO,
  admin/member roles, per-user thread scoping, `AUTH_DISABLED` solo mode,
  first-user-is-admin bootstrap, user management admin UI
- Schema future-proofed: nullable `org_id` on `agents` + `thread_metadata`
  for future multi-tenant SaaS migration
- Error boundaries (`app/error.tsx` + `app/global-error.tsx`) — render-crash
  recovery UI; `error.tsx` handles child-segment errors inside the layout,
  `global-error.tsx` catches root layout failures (replaces `<html>`/`<body>`)
- Non-admin empty-state CTA gating — `chat-shell.tsx` role-checks via
  `authClient.useSession()`; admins see "Add your first agent →", non-admins
  see "ask your administrator to add one" (previously misleading link that
  bounced on the `/agents` admin redirect)
- Server-side structured logging — `[copilotkit] handler error` in the
  runtime route's try/catch around `innerHandler`, and `[runner] run failed`
  in `PersistentAgentRunner.run()` error callback (previously silently
  swallowed). No logging library — `console.error` with JSON context
- Login/signup auth-disabled redirect fix — moved `router.push(redirect)`
  from render into `useEffect` to avoid React warnings + brief form flash

## Future (structured for easy upgrade)

- Generative UI / shared state (`useCoAgent`) — requires backend to emit
  `STATE_SNAPSHOT`/`STATE_DELTA` events; neither backend currently does
- Additional backends (CrewAI, Mastra, Pydantic AI, Google ADK, AWS Strands, etc.)
- Per-agent ACL (`agent_acl` table) so specific agents can be restricted to
  specific users/groups (e.g. HR agent only visible to HR team)
- Multi-tenant SaaS (populate `org_id` on `agents` + `thread_metadata`,
  scope queries by org) — schema is already nullable-ready
- **Redis-backed cache for multi-instance SaaS:** the in-memory `Map`s in
  `PostgresAgentRunner` (`threadCache`, `messageCache`, `eventsCache`)
  are per-process. For horizontal scaling (multiple Next.js instances),
  replace them with a shared Redis cache. The interface stays the same —
  `cache.get(id)` becomes `await redis.get(id)` wrapped in a sync
  fallback, or (better) CopilotKit v2.x may ship an async
  `LocalThreadEndpointRunner` variant by then. Alternatives:
  PG LISTEN/NOTIFY for cross-instance invalidation, polling refresh on a
  timer, or sticky sessions at the load balancer. Not needed for single-
  instance OSS deploys.
- Email verification + conditional account linking security: when SMTP is
  configured, enable email verification on signup and set
  `requireLocalEmailVerified: true` (secure auto-linking). When SMTP is not
  configured (common for self-hosters), keep `requireLocalEmailVerified: false`
  (graceful fallback — `trustedProviders` mitigates the risk). Requires SMTP
  env vars (`SMTP_URL`, etc.) + `sendVerificationEmail` callback + verification
  callback page.
- Account settings page (link/unlink providers): let signed-in users add
  password access to a social-only account, or link additional social providers
  to a password account. Better Auth supports this server-side via
  `/api/auth/link-password` and `/api/auth/link-social` — needs UI.
- Integration test suite (testcontainers + real Postgres): pg-mem doesn't
  support `WITH RECURSIVE` CTEs (used by `PostgresAgentRunner.getHistoricRuns`)
  or cross-statement `ROLLBACK`. The 7 skipped tests in `lib/agents/pg-runner.test.ts`
  + `lib/db/pg.test.ts` cover these paths. A testcontainers-based integration
  suite would run them against a real PG container in CI.

## Notes

- Env changes require dev server restart — Next.js reads `.env.local` at boot
  and does not hot-reload env vars. After editing `.env.local`, stop the dev
  server (`Ctrl+C`) and run `npm run dev` again. Module-level `const X =
  process.env.X === "true"` patterns in `proxy.ts` and `lib/auth/auth.ts` are
  evaluated once at boot. Documented in `.env.example` + README Quick Start.
- Next.js 16 has breaking changes vs prior versions. Read docs in
  `node_modules/next/dist/docs/` before modifying framework-level code.
- CopilotKit v2 API: import runtime from `@copilotkit/runtime/v2`, React components
  from `@copilotkit/react-core/v2` (NOT `@copilotkit/react-core` — the v1 and v2
  exports are split across subpath exports; v2 has `CopilotKitProvider`, `CopilotChat`
  with `agentId`/`threadId` props, `useInterrupt`, `useRenderTool`).
- `CopilotChat` is imported from `@copilotkit/react-core/v2` (v2 version with
  `agentId`/`threadId` props), NOT from `@copilotkit/react-ui` (which exports
  the v1 version without those props) or `@copilotkit/react-core` (v1 root).
- AG-UI protocol spec: https://docs.ag-ui.com — see
  [Events](https://docs.ag-ui.com/concepts/events),
  [Messages](https://docs.ag-ui.com/concepts/messages), and
  [Build a server](https://docs.ag-ui.com/quickstart/server) for the backend
  contract.

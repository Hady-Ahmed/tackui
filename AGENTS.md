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

Tests use [vitest](https://vitest.dev) with an in-memory SQLite database
(`:memory:`) — no file I/O, no cleanup needed between runs. See
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
  `/api/agents/test` tests). Restore in `afterEach`.
- **No production code changes for testability** — the in-memory SQLite
  (`AGENT_DB_PATH=:memory:`) + vitest's `isolate: true` handle DB isolation
  without needing test-only exports.

## Project Structure

```
app/
  api/copilotkit/[[...path]]/route.ts  # CopilotKit runtime (catch-all — matches /api/copilotkit and all sub-paths)
  api/agents/route.ts          # REST: GET/POST /api/agents (list, create)
  api/agents/[id]/route.ts     # REST: GET/PATCH/DELETE /api/agents/[id]
  api/agents/test/route.ts     # REST: POST /api/agents/test (reachability probe)
  api/auth/[...all]/route.ts   # Better Auth handler (signup, signin, callback)
  api/auth/config/route.ts     # GET enabled providers (for self-configuring login UI)
  api/threads/[id]/route.ts    # REST: PATCH/DELETE /api/threads/[id] (rename, delete conversations)
  agents/page.tsx              # Admin UI — add/edit/delete agents + test connection + user management
  login/page.tsx               # Login (email/password + social + SSO)
  signup/page.tsx              # Sign up (email/password + social + SSO)
  layout.tsx                   # Root layout — wraps app in CopilotKitProvider + FOUC-free theme init script
  page.tsx                     # Main chat page (client component)
  globals.css                  # Global styles + Tailwind (class-based dark mode via @custom-variant)

lib/
  agents/
    agents.config.ts           # AgentEntry / AgentKind types (no runtime config)
    agent-store.ts             # SQLite CRUD for agents table (zod-validated)
    registry.ts                # getAgents() factory — reads DB, builds agents map
    persistent-runner.ts       # PersistentAgentRunner — SQLite-backed runner with thread endpoints (see "Thread history recovery on revisit" in Future for a known connect() replay bug to fix)
    runner-instance.ts         # Shared runner singleton (used by runtime + thread API)
  auth/
    auth.ts                    # Better Auth instance (SQLite adapter, plugins, first-user-is-admin)
    auth-client.ts             # Better Auth React client (signIn, signUp, useSession)
    context.ts                 # getCurrentUser / getRequestUser (session → RequestUser)
    request-context.ts         # AsyncLocalStorage for per-request user (read by runner)
  db/
    migrations.ts              # Idempotent ALTER TABLE helpers
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

Agents are stored in a SQLite table (`agents` in `./data/agent-state.db`, shared
with the thread runner) and managed at runtime via the `/agents` admin page or
the `/api/agents` REST API. No restart is needed when adding, editing, or
removing agents — `CopilotRuntime` receives `getAgents` as a factory function,
called per-request, so DB changes reflect immediately on the next `/run`.

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
hits `POST /api/agents/test`. This performs a server-side `GET` to the endpoint
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

## Environment Variables

Agents are managed via the `/agents` admin page (stored in SQLite) — no env
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

### Postgres portability

Better Auth has a Postgres adapter — swap `new Database(path)` to
`new Pool(...)` in `lib/auth/auth.ts` when migrating. The auth tables are
managed by Better Auth automatically. Agent/thread SQL uses standard types
(avoid SQLite-specifics) to keep the migration cheap.

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
- SQLite-backed thread runner with conversation persistence
  (`PersistentAgentRunner` in `lib/agents/persistent-runner.ts` — extends
  `SqliteAgentRunner` with local thread endpoints for `useThreads`)
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

## Future (structured for easy upgrade)

- Generative UI / shared state (`useCoAgent`) — requires backend to emit
  `STATE_SNAPSHOT`/`STATE_DELTA` events; neither backend currently does
- Additional backends (CrewAI, Mastra, Pydantic AI, Google ADK, AWS Strands, etc.)
- Per-agent ACL (`agent_acl` table) so specific agents can be restricted to
  specific users/groups (e.g. HR agent only visible to HR team)
- Multi-tenant SaaS (populate `org_id` on `agents` + `thread_metadata`,
  scope queries by org) — schema is already nullable-ready
- Postgres migration (swap `better-sqlite3` adapter for `pg` Pool in
  `lib/auth/auth.ts` + agent store)
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
- Thread history recovery on revisit: when a run fails (e.g. backend
  unreachable), `SqliteAgentRunner.connect()` replays stored events from
  `agent_runs` — if those events contain a `RUN_ERROR` (or duplicate
  `RUN_ERROR`s from `finalizeRunEvents`), AG-UI's verifier locks and rejects
  all subsequent events, causing the ENTIRE thread to load empty on refresh
  (not just the failed message). The thread stays permanently unreadable
  even after the URL is fixed and new runs succeed, because the bad run's
  events are concatenated before the good runs' in the replay. The fix is
  to override `connect()` in `PersistentAgentRunner` to emit a single
  `MESSAGES_SNAPSHOT` event from `thread_messages` (our snapshot table,
  populated by `captureThreadData` on both success and failure) instead of
  calling `super.connect()` (which reads from `agent_runs`). This sidesteps
  the verifier entirely. Trade-off: loses live-bridging (connecting while a
  run is active — `ACTIVE_CONNECTIONS` is module-private in
  `sqlite-runner.mjs`) and intermediate event history (`STATE_*`,
  `REASONING_*`, `STEP_*` events — only `thread_messages` snapshots are
  replayed, not the raw event stream). Neither affects current backends.
  See `lib/agents/persistent-runner.ts` and
  `node_modules/@copilotkit/sqlite-runner/dist/sqlite-runner.mjs:211`
  (`connect()` method) + `:109` (`run()` catch block + `finalizeRunEvents`
  at `node_modules/@copilotkit/shared/dist/finalize-events.mjs`).

## Notes

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

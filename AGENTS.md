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
  api/agents/route.ts          # REST: GET/POST /api/agents (list, create) — SSRF guard on POST
  api/agents/[id]/route.ts     # REST: GET/PATCH/DELETE /api/agents/[id] — SSRF guard on PATCH (when endpoint changes)
  api/agents/reachability-probe/route.ts  # REST: POST /api/agents/reachability-probe (pure diagnostic — no SSRF guard, error messages masked)
  api/auth/[...all]/route.ts   # Better Auth handler (signup, signin, callback)
  api/auth/config/route.ts     # GET enabled providers (for self-configuring login UI)
  api/auth/can-manage-agents/route.ts  # GET — returns whether user can manage agents (org owner/admin or platform admin)
  api/threads/[id]/route.ts    # REST: PATCH/DELETE /api/threads/[id] (rename, delete conversations)
  api/threads/[id]/route.test.ts  # Tests for PATCH/DELETE (mocked runner)
  api/health/route.ts          # GET — liveness health check (bypassed by proxy.ts cookie gate)
  agents/page.tsx              # Admin UI — add/edit/delete agents + test connection + user management
  error.tsx                    # Route error boundary — render-crash recovery (centered card + Reload)
  global-error.tsx             # Root error boundary — catches layout-level failures (renders own <html>)
  login/page.tsx               # Login (email/password + social + SSO) — validates redirect param (open-redirect fix) + forgot password link
  signup/page.tsx              # Sign up (email/password + social + SSO) — shows "check your email" when verification enabled
  verify-email/page.tsx        # Email verification callback — Better Auth verifies token server-side, redirects here. Shows success/failure + resend form (does NOT call verifyEmail — uses ?error= param from redirect)
  forgot-password/page.tsx     # Password reset request — calls authClient.requestPasswordReset (anti-enumeration)
  reset-password/page.tsx      # Password reset form — reads ?token=, calls authClient.resetPassword
  layout.tsx                   # Root layout — wraps app in CopilotKitProvider + FOUC-free theme init script
  page.tsx                     # Main chat page (client component)
  globals.css                  # Global styles + Tailwind (class-based dark mode via @custom-variant)

lib/
  agents/
    agents.config.ts           # AgentEntry / AgentKind / PublicAgent types (no runtime config)
    agent-store.ts             # Async CRUD for agents table (zod-validated, pg.Pool-backed) + generateAgentId (random 12-char hex) + toPublicAgent/toPublicAgents (strips langsmithApiKey)
    registry.ts                # getAgents() factory — reads DB, builds agents map (async)
    pg-runner.ts               # PostgresAgentRunner — AgentRunner impl with thread endpoints + smart-replay connect() (RUN_ERROR filtering) + in-memory cache bridging sync interface to async PG
    runner-instance.ts         # Shared runner singleton (used by runtime + thread API)
  auth/
    auth.ts                    # Better Auth instance (Postgres Pool adapter, plugins, first-user-is-admin, BETTER_AUTH_SECRET enforcement on boot)
    auth-client.ts             # Better Auth React client (signIn, signUp, useSession)
    context.ts                 # getCurrentUser / getRequestUser / getSyntheticAdmin (session → RequestUser)
    request-context.ts         # AsyncLocalStorage for per-request user (read by runner)
    solo-org.ts                # ensureSoloOrg / getSoloOrgId — creates real org row on boot for solo mode
    use-auth-config.ts         # useAuthConfig() hook — fetches /api/auth/config once per page load
    use-can-manage-agents.ts   # useCanManageAgents() hook — fetches /api/auth/can-manage-agents once per page load
  db/
    pg.ts                       # Shared pg.Pool singleton (DATABASE_URL) + query/withTransaction helpers
    migrate.ts                  # Versioned SQL migration runner (lib/db/migrations/*.sql)
    migrations/                 # Versioned .sql files tracked in schema_migrations
      0001_init.sql             # Initial schema: agents, agent_runs, run_state, thread_messages, thread_metadata
      0002_org_id_not_null.sql  # Makes org_id NOT NULL (wipe-and-restart for existing deploys)
      0003_agent_id_org_scoped.sql # Composite PK (id, org_id) — same id can exist in different orgs
  email/
    client.ts                   # Resend SDK singleton + EMAIL_ENABLED flag + sendEmail() helper (no-op when RESEND_API_KEY unset)
    templates.ts                # Email template builders — verificationEmail(), passwordResetEmail() (HTML + text)
    templates.test.ts           # 9 tests — template rendering, URL inclusion, HTML escaping
  net/
    safe-fetch.ts               # SSRF guard — assertSafeUrl (blocks private IPs, ALLOW_PRIVATE_ENDPOINTS opt-in) + isPrivateIp (IPv4/IPv6 range checks)
    safe-fetch.test.ts          # 40 tests — private IP ranges, IPv6, IPv4-mapped, DNS resolution, bypass opt-in
  ratelimit/
    store.ts                    # In-memory sliding-window + concurrent counter (single-instance; pluggable for Redis)
    limits.ts                   # Named limit presets (copilotkit: 20/min, concurrent: 3, probe: 10/min, etc.)
    middleware.ts               # checkUserLimit / acquireConcurrent helpers + 429 response builders with X-RateLimit headers
    stream-wrap.ts              # wrapStreamWithRelease — wraps SSE Response body so concurrent-cap decrement fires on stream close/error/cancel
    store.test.ts               # 13 tests — sliding window, concurrent, GC, boundary conditions
    middleware.test.ts          # 10 tests — 429 responses, checkUserLimit, acquireConcurrent + release
    stream-wrap.test.ts         # 7 tests — stream lifecycle: release on completion, error, cancel, no-body, header preservation
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

proxy.ts                       # Next.js proxy (cookie gate + AUTH_DISABLED bypass + /api/health bypass + per-IP rate limiting + open-redirect-safe redirect)
next.config.ts                 # Security headers (CSP, HSTS, X-Frame-Options, etc.) + standalone build + poweredByHeader disabled + Sentry wrapper
sentry.client.config.ts        # Sentry client-side init (no-op if NEXT_PUBLIC_SENTRY_DSN unset)
sentry.server.config.ts        # Sentry server-side init (no-op if SENTRY_DSN unset)
sentry.edge.config.ts          # Sentry edge-runtime init (no-op if SENTRY_DSN unset)
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
  "name": "Research Agent",
  "description": "LangGraph-powered web research assistant",
  "kind": "agui",
  "endpoint": "http://localhost:8001/agent"
}
```

Optional fields: `graphId` (langgraph only), `langsmithApiKey` (langgraph only).

`id` is **server-generated** (12-char random hex) — never send it in the
POST body. The response includes the generated `id`, which you use in
PATCH/DELETE URLs. The id is immutable after creation.

> **Secret handling:** `langsmithApiKey` is **write-only** — accepted on
> POST/PATCH but never returned in GET responses. The API exposes a
> `hasLangsmithApiKey: boolean` instead (see `PublicAgent` in
> `lib/agents/agents.config.ts`). The admin edit form shows "Key set ✓"
> when true; submitting a blank field preserves the existing value.

> **SSRF guard:** Creating or editing an agent with an endpoint that
> resolves to a private/internal IP (`127.x`, `10.x`, `192.168.x`,
> `172.16-31.x`, `169.254.x`, IPv6 equivalents) returns 400. Set
> `ALLOW_PRIVATE_ENDPOINTS=true` to opt in (for self-hosters running
> backends on the same host). See [Security](#security) below.

### Test connection

Both the admin form and the agents table have a "Test connection" button that
hits `POST /api/agents/reachability-probe`. This performs a server-side `GET` to the endpoint
with a 5s timeout and reports reachability. It catches URL typos and down
servers — it does **not** validate auth, AG-UI protocol compliance, or that the
agent will actually run. The sidebar also shows a status dot per agent (gray =
untested, green = reachable, red = unreachable), re-tested on window focus.

The probe is a **pure diagnostic** — it always reports reachability truthfully,
including for `localhost`/private IPs. SSRF protection lives on agent
create/edit (the persistence choke point), not on the probe. Raw error messages
are masked in the response (they can leak internal hostnames via DNS errors);
the full error is logged server-side via `console.error("[reachability-probe] ...")`.

### Security

- **SSRF guard on agent create/edit** — `POST /api/agents` and `PATCH /api/agents/[id]`
  call `assertSafeUrl()` (`lib/net/safe-fetch.ts`) before persisting the endpoint.
  Blocks loopback/private/link-local/multicast IPs (IPv4 + IPv6, including
  IPv4-mapped). Opt in with `ALLOW_PRIVATE_ENDPOINTS=true` for self-hosters
  running backends on the same host. The guard only fires on PATCH when the
  `endpoint` field is in the body — editing other fields on an existing
  private-endpoint agent works without the flag. Once stored, the CopilotKit
  runtime fetches the endpoint during runs without re-checking (intentional —
  existing agents keep working even if the env var changes).
- **`langsmithApiKey` is write-only** — accepted on POST/PATCH, never returned
  in GET responses. `PublicAgent.hasLangsmithApiKey: boolean` replaces it.
  `toPublicAgent()` / `toPublicAgents()` in `lib/agents/agent-store.ts` do the
  stripping. The admin edit form shows "Key set ✓" when true; blank submit
  preserves the existing value.
- **Security headers** (`next.config.ts`) — CSP (`'unsafe-inline'` scripts/styles,
  `'unsafe-eval'` dev-only, `frame-ancestors 'none'`), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (no geo/mic/cam/payment/usb), HSTS (prod only),
  `poweredByHeader: false`.
- **`BETTER_AUTH_SECRET` enforcement** (`lib/auth/auth.ts`) — throws on boot
  if unset when `AUTH_DISABLED !== "true"`. Prevents silent session forgery
  via the publicly-known fallback that was previously in the source.
- **Open-redirect fix** (`app/login/page.tsx`) — `safeRedirect()` validates the
  `redirect` query param is a same-origin relative path (starts with single `/`,
  not `//` or `/\`).
- **`/api/health`** (`app/api/health/route.ts`) — liveness check returning
  `200 { ok: true }`. Bypassed by `proxy.ts` cookie gate so orchestrators can
  probe without a session. Wired into `docker-compose.yml` healthcheck.

### Rate limiting

Two-layer rate limiting protects the server from abuse and floods:

**Layer 1 — Per-IP global flood protection (`proxy.ts`):**
- 300 requests/min per IP on all `/api/*` routes (except `/api/health` which
  is unlimited, and `/api/auth/*` which has its own Better Auth limiter).
- Enforced in the proxy (pre-auth) using `X-Forwarded-For` for IP extraction.
- Proxy runtime pinned to `nodejs` — the in-memory `Map` requires it.

**Layer 2 — Per-user route-level limits (`lib/ratelimit/`):**
- Enforced in route handlers, post-auth, keyed by `user.id`.
- Limits (see `lib/ratelimit/limits.ts`):

| Route | Limit | Concurrent |
| --- | --- | --- |
| `/api/copilotkit/*` (POST runs only) | 20/min per user | 3 concurrent run streams per user |
| `/api/agents/reachability-probe` | 30/min per user | — |
| `/api/agents` POST + `/api/agents/[id]` PATCH/DELETE | 10/min per user | — |
| `/api/agents` GET + `/api/agents/[id]` GET | 60/min per user | — |
| `/api/threads/[id]` PATCH/DELETE | 30/min per user | — |
| `/api/auth/can-manage-agents` GET | 30/min per user (shares `agentRead` bucket) | — |

**Better Auth rate limiting** (`lib/auth/auth.ts`):
- Sign-in: 10/min per IP. Sign-up: 5/min per IP. Configured via
  `rateLimit.customRules` in the `betterAuth()` call. Disabled in solo mode.

**Concurrent SSE stream cap:**
The `/api/copilotkit` route tracks in-flight **run** streams per user (not
connect/info/stop streams). The `isRunRequest` check in the route handler
distinguishes runs from control requests: a POST is a run only if it is
NOT to a `/connect` or `/stop/` sub-path. Only runs count toward the rate
limit (20/min) and the concurrent cap (3). Connect streams (POST
`/agent/*/connect`), stop requests (POST `/agent/*/stop/<threadId>`), info
fetches (GET `/info`), and thread listing (GET `/threads`) are exempt.
Stop requests must be exempt — otherwise stopping a run at the
3-concurrent cap tries to acquire a 4th slot and 429s, making the run
unstoppable. The aborted run's own SSE stream close still fires
`release()` via `wrapStreamWithRelease`, which is what actually
decrements the counter.

The `wrapStreamWithRelease()` helper (in `lib/ratelimit/stream-wrap.ts`)
wraps the `Response` body `ReadableStream` so the concurrent-cap decrement
fires automatically on stream completion, error, or client disconnect — no
manual cleanup needed in route code. When a user exceeds the concurrent cap
(3), they get `429 { error: "Too many concurrent agent runs (3 max)..." }`
which surfaces in the CopilotKit chat UI.

**Solo mode (`AUTH_DISABLED=true`):** Per-user limits are not enforced
(everyone is `id: "local"`). This applies to **all** per-user limits —
the copilotkit run/concurrent caps, agent mutations, agent reads, thread
mutations, reachability probe, and the can-manage-agents check. The guard
is centralized in `checkUserLimit()` / `acquireConcurrent()` in
`lib/ratelimit/middleware.ts` (not in each route handler). Per-IP flood
protection from `proxy.ts` still applies.

**429 responses** include standard `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers.

**Multi-instance note:** The in-memory store (`lib/ratelimit/store.ts`)
is per-process. For multi-instance deployments, replace it with a
Redis-backed store — the interface (`checkLimit` / `incrementConcurrent` /
`decrementConcurrent`) stays the same.

### Error tracking

Sentry integration via `@sentry/nextjs` — automatically captures uncaught
exceptions on both server and client. No-op when `SENTRY_DSN` (server) /
`NEXT_PUBLIC_SENTRY_DSN` (client) is not set, so self-hosters can opt out
entirely by simply not setting the env vars.

- `sentry.client.config.ts` / `sentry.server.config.ts` /
  `sentry.edge.config.ts` — SDK init (reads DSN from env, only enabled in
  production).
- `next.config.ts` — wrapped in `withSentryConfig()` (source map upload,
  tree-shaking).
- `app/error.tsx` + `app/global-error.tsx` — call `Sentry.captureException`
  before rendering the fallback UI.
- `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` —
  transaction trace sampling (default: 0.1 = 10%). Set to 0 to disable
  performance traces.

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
#
# If the endpoint is on localhost or a private IP, set ALLOW_PRIVATE_ENDPOINTS=true
# first — the SSRF guard on POST/PATCH will 400 otherwise.
#
# `id` is server-generated (12-char random hex) — do NOT send it in the body.
# The response includes the generated `id`, which you use in PATCH/DELETE URLs.
curl -X POST http://localhost:3000/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","description":"smoke test","kind":"agui","endpoint":"http://localhost:8000/agent"}'
# → 201 { "id": "a1b2c3d4e5f6", "name": "Test", ... }

curl http://localhost:3000/api/agents                 # list
curl -X PATCH http://localhost:3000/api/agents/a1b2c3d4e5f6 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Renamed"}'                              # update (id from URL)
curl -X DELETE http://localhost:3000/api/agents/a1b2c3d4e5f6   # delete
```

`description` is required (zod-validated). `id` is server-generated
(12-char random hex via `crypto.randomUUID()`, see `generateAgentId` in
`lib/agents/agent-store.ts`), never client-supplied, and immutable after
creation. The PK is composite `(id, org_id)` (migration 0003) — the same
id can exist in different orgs (matches the app-level org scoping on
every query). 48 bits of entropy makes intra-org collisions effectively
impossible; the 23505 catch in the POST handler is a loud-error safety
net, not a retry path.

## Environment Variables

Agents are managed via the `/agents` admin page (stored in Postgres) — no env
vars are required to add or configure agents.

See `.env.example` for optional backend URLs (useful for documentation or
scripts only; the frontend reads endpoints from the DB).

### Auth environment variables

Required unless `AUTH_DISABLED=true`:

- `BETTER_AUTH_SECRET` — secret for signing session cookies (generate with
  `openssl rand -hex 32`). The app **throws on boot** if unset when auth is
  enabled — prevents silent session forgery via a publicly-known fallback.
- `BETTER_AUTH_URL` — public base URL of the app (e.g.
  `http://localhost:3000`)

Optional security flags:

- `ALLOW_PRIVATE_ENDPOINTS` — set to `true` to allow creating/editing agents
  with endpoints that resolve to private/internal IPs (for self-hosters running
  backends on the same host). Defaults to `false` (blocks private IPs to
  prevent SSRF). See [Security](#security) above.

Optional Postgres pool tuning:

- `PG_POOL_MAX` — max connections in the pool (default: `10`)
- `PG_CONNECT_TIMEOUT` — connection timeout in ms (default: `5000`)

Optional social providers (omit any you don't want):

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — GitHub OAuth
- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_ISSUER` — external OIDC SSO
  (Keycloak, Authentik, Okta, Entra, etc.)

Solo / no-auth mode:

- `AUTH_DISABLED=true` — skips login entirely; everyone is the single admin.
  No other auth env vars needed. Useful for local dev or single-user
  self-hosted deployments.

Email (optional — when set, enables email verification + password reset):

- `RESEND_API_KEY` — Resend API key (get one at https://resend.com, free
  tier: 3,000 emails/mo). When unset, email features are disabled entirely.
- `EMAIL_FROM` — sender address (e.g. `noreply@yourdomain.com`). Must be a
  verified domain in Resend. Defaults to `noreply@localhost`.

## Authentication

Auth is powered by [Better Auth](https://better-auth.com) with:

- **Email/password** sign-up/sign-in
- **Social login** (Google, GitHub) — only enabled if env vars are set
- **OIDC SSO** via `genericOAuth` plugin — for self-hosters with their own IdP
  (Keycloak, Authentik, Okta, Entra, etc.)
- **Organizations** via `organization` plugin — personal-org pattern: every
  user gets a personal workspace on signup. Agents and threads are scoped to
  the active org. Enables future team invites + multi-workspace switching.
- **Admin roles** via `admin` plugin — `admin` (platform superuser) and `user`
  roles. Org-scoped roles (owner/admin/member) come from the `organization`
  plugin.
- **Auth-disabled mode** — `AUTH_DISABLED=true` makes everyone the single
  admin. A real solo org row is created on boot so `org_id` is always
  populated (NOT NULL on all tables).

### Auth architecture

```
Browser → proxy.ts (cookie gate) → Next.js App
                                       ↓
                          /api/auth/*     → Better Auth (signup, signin, callback)
                          /api/copilotkit → CopilotRuntime (auth + ALS wrapping)
                          /api/agents*    → REST (getCurrentUser checks)
                          /api/threads*   → REST (getCurrentUser + userId + orgId scoping)
```

**Request user resolution:**

- `getCurrentUser()` (`lib/auth/context.ts`) — resolves the user from the
  session cookie via `auth.api.getSession()`. Used by REST API routes. Returns
  `getSyntheticAdmin()` (async, resolves the solo org id) when
  `AUTH_DISABLED=true`.
- `getRequestUser(request)` — same but takes a `Request` object. Used by the
  CopilotKit runtime route.
- `getRunnerUser()` (`lib/auth/request-context.ts`) — reads the user from
  `AsyncLocalStorage`. Used by `PostgresAgentRunner` (which has no access to
  the request). The ALS context is set by wrapping the CopilotKit handler in
  `runWithUserAsync()` in the runtime route. Carries `orgId` alongside
  `id`/`role`/`name`/`email`.
- `getSyntheticAdmin()` (`lib/auth/context.ts`) — async, resolves the solo
  org id from the DB on first call (see `lib/auth/solo-org.ts`). The synthetic
  admin has `orgId` populated so all scoping code works identically in solo
  mode and SaaS mode.

**First user becomes admin:** The `databaseHooks.user.create.after` hook in
`lib/auth/auth.ts` promotes the first user to `admin` role (bootstrap only).
Personal org + owner membership creation happens in the
`databaseHooks.session.create.before` hook — it checks if the user already
has an owner membership; if not (first signup — `user.create.after` is
deferred to post-transaction by Better Auth so it hasn't run yet), it
creates the org + member rows in-transaction, then sets
`activeOrganizationId` on the session. This ensures every auth path (email
signup, login, social, OIDC) gets a correct `activeOrganizationId`. The
`npm run create-admin` script can also create/promote an admin explicitly.

### Access control

- **Platform admin** (`admin` role from the `admin` plugin): Superuser for
  user management (ban/unban, set roles across all orgs). Can manage agents
  in their own org (same as org owners). Does NOT bypass org scoping for
  threads or agents — sees only their own org's data. When the org switcher
  ships, platform admins will be able to switch to other orgs and manage
  their agents.
- **Org owner/admin** (from the `organization` plugin's `member` table): Can
  manage agents (create/edit/delete) in their own org. Can use all agents and
  see their own threads in the org. Cannot manage users (platform-level).
- **Org member** (future team orgs): Can use agents and their own threads.
  Cannot manage agents.
- **Agent management authorization:** `canManageAgents(user)` in
  `lib/auth/context.ts` — returns true for platform admins (short-circuit) or
  org owners/admins (via `member` table lookup). Used by POST/PATCH/DELETE
  `/api/agents` routes. The client mirrors this via
  `GET /api/auth/can-manage-agents` → `useCanManageAgents()` hook.
- **Org scoping:** Agents and threads are scoped by `org_id` (NOT NULL on
  `agents` + `thread_metadata`). `listAgents(orgId)`, `getAgent(id, orgId)`,
  `listThreads()` (filters cache by `organizationId === orgId`) all scope by
  the user's active org. No bypass for any role.
- **Thread scoping:** Threads are scoped per user + per org. `listThreads`
  filters by `createdById === userId && organizationId === orgId` via ALS.
  `deleteThread`/`renameThread` check ownership (owner or org-mate). No
  bypass for any role.

### Postgres (auth + agent store)

Auth and agent storage share a single `pg.Pool` (see `lib/db/pg.ts`),
constructed from `DATABASE_URL`. Better Auth receives the pool via
`betterAuth({ database: getPool(), ... })` and wraps it in Kysely's
`PostgresDialect` internally. The `databaseHooks.user.create.after` hook
(first-user-is-admin bootstrap) runs raw `query()` calls against the same
pool — note `"user"` is a reserved word in Postgres and must be
double-quoted in all raw SQL.

Better Auth's tables (`user`, `session`, `account`, `verification`,
`organization`, `member`, `invitation`) are created via
`npx @better-auth/cli migrate --config lib/auth/auth.ts` (or automatically
on boot via `ensureAuthTables()` in `instrumentation.ts`). The
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
(CopilotKit's `agent.messages` + `PostgresAgentRunner`) stores and manages all
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
  admin/member roles, per-user + per-org thread scoping, `AUTH_DISABLED` solo
  mode, first-user-is-admin bootstrap, user management admin UI, personal-org
  pattern (every user gets a workspace on signup via the `organization` plugin)
- Multi-tenant org scoping: `org_id` NOT NULL on `agents` + `thread_metadata`,
  all queries scope by the user's active org, org-level agent management
  (`canManageAgents` — org owners/admins can manage their workspace's agents),
  solo mode creates a real org row on boot
- Error boundaries (`app/error.tsx` + `app/global-error.tsx`) — render-crash
  recovery UI; `error.tsx` handles child-segment errors inside the layout,
  `global-error.tsx` catches root layout failures (replaces `<html>`/`<body>`)
- Non-admin empty-state CTA gating — `chat-shell.tsx` uses
  `useCanManageAgents()`; org owners/admins see "Add your first agent →",
  others see "ask your administrator to add one"
- Server-side structured logging — `[copilotkit] handler error` in the
  runtime route's try/catch around `innerHandler`, and `[runner] run failed`
  in `PostgresAgentRunner.run()` error callback (previously silently
  swallowed). No logging library — `console.error` with JSON context
- Login/signup auth-disabled redirect fix — moved `router.push(redirect)`
  from render into `useEffect` to avoid React warnings + brief form flash
- Security hardening (OSS release) — `langsmithApiKey` stripped from all
  GET responses (`PublicAgent.hasLangsmithApiKey` boolean replaces it);
  SSRF guard on agent create/edit (`lib/net/safe-fetch.ts` +
  `ALLOW_PRIVATE_ENDPOINTS` opt-in); security headers in `next.config.ts`
  (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy,
  `poweredByHeader: false`); `BETTER_AUTH_SECRET` throws on boot if unset
  when auth enabled; open-redirect fix (`safeRedirect()` in login page);
  `/api/health` liveness endpoint (bypassed by proxy cookie gate); error
  message masking on reachability probe (no internal hostname leakage)
- Rate limiting (SaaS hardening) — two-layer: per-IP global flood protection
  in `proxy.ts` (300/min) + per-user route-level limits in `lib/ratelimit/`
  (20 runs/min, 3 concurrent SSE streams, 10/min probe/mutations, 60/min
  reads). Better Auth `rateLimit` config (sign-in: 10/min, sign-up: 5/min
  per IP). 429 responses with standard `X-RateLimit-*` headers.
- Error tracking — `@sentry/nextjs` integration (server + client + edge
  configs). No-op when `SENTRY_DSN` is not set. Error boundaries call
  `Sentry.captureException`. Trace sampling via `SENTRY_TRACES_SAMPLE_RATE`.
- Email verification + password reset — env-gated via `RESEND_API_KEY`.
  When set: `requireEmailVerification: true`, `requireLocalEmailVerified: true`,
  `sendVerificationEmail` + `sendResetPassword` callbacks via Resend, `/verify-email`
  callback page, `/forgot-password` + `/reset-password` flow pages, signup shows
  "check your email" screen. When unset: graceful fallback (no verification,
  accounts work immediately, forgot-password link hidden).
  - `sendOnSignIn: false` — verification email is NOT auto-sent on every login
    attempt (avoids spam). Instead, the login page catches the 403 "email not
    verified" error and shows a "Resend verification email" button.
  - The `sendVerificationEmail` callback rewrites the callbackURL to
    `/verify-email` (Better Auth's default is `/`) so all verification emails
    land on the success page — consistent UX for both automatic signup emails
    and manual resends.
  - The `/verify-email` page does NOT call `authClient.verifyEmail()` — Better
    Auth verifies the token server-side before redirecting. The page just
    checks for `?error=` param (failure) vs no error (success).
  - Login + signup use `window.location.href` (hard navigation) after
    successful auth to avoid client-side session hydration races.

## Future (structured for easy upgrade)

**SaaS launch track (the next concrete phase):**

- **ToS / privacy pages** — required for SaaS that processes user
  conversations (PII) and offers social login. Need `/terms` + `/privacy`
  routes + cookie notice (esp. EU).
- **PG LISTEN/NOTIFY cache invalidation for multi-instance:** the in-memory
  `Map`s in `PostgresAgentRunner` (`threadCache`, `messageCache`, `eventsCache`)
  are per-process. For horizontal scaling (multiple Next.js instances),
  add a dedicated LISTEN connection that evicts cache entries on NOTIFY from
  other instances. Keeps self-host at one dependency (PG). Redis only needed
  if you go multi-region or add it for another reason (rate limiting, jobs).
  Not needed for single-instance OSS deploys.
- **Org switcher + team invitations UI** — the `organization` plugin supports
  invites server-side; needs client-side invite flow + org-switcher dropdown
  in the account menu. Personal-org users (the majority at launch) have one
  org and never need to switch.
- **ToS / privacy pages** — required for SaaS that processes user
  conversations (PII) and offers social login. Need `/terms` + `/privacy`
  routes + cookie notice (esp. EU).

**Feature track (whenever, no SaaS dependency):**

- Generative UI / shared state (`useCoAgent`) — requires backend to emit
  `STATE_SNAPSHOT`/`STATE_DELTA` events; neither backend currently does
- Additional backends (CrewAI, Mastra, Pydantic AI, Google ADK, AWS Strands, etc.)
- Per-agent ACL (`agent_acl` table) so specific agents can be restricted to
  specific users/groups (e.g. HR agent only visible to HR team). Group
  resolution should delegate to the IdP (OIDC token claims) when SSO is
  configured, falling back to an app-managed group table for email/password
  only. Separate from org_id (which is isolation, not sharing).
- Account settings page (link/unlink providers): let signed-in users add
  password access to a social-only account, or link additional social providers
  to a password account. Better Auth supports this server-side via
  `/api/auth/link-password` and `/api/auth/link-social` — needs UI.
- Integration test suite (testcontainers + real Postgres): pg-mem doesn't
  support `WITH RECURSIVE` CTEs (used by `PostgresAgentRunner.getHistoricRuns`)
  or cross-statement `ROLLBACK`. The 5 skipped tests in `lib/agents/pg-runner.test.ts`
  cover these paths. A testcontainers-based integration suite would run them
  against a real PG container in CI.
- Nonce-based CSP — current CSP uses `'unsafe-inline'` for scripts (pragmatic
  v1). A nonce-based policy requires threading a per-request nonce through
  Next's middleware + script tags — stronger XSS defense.

## Notes

- Env changes require dev server restart — Next.js reads `.env.local` at boot
  and does not hot-reload env vars. After editing `.env.local`, stop the dev
  server (`Ctrl+C`) and run `npm run dev` again. Module-level `const X =
  process.env.X === "true"` patterns in `proxy.ts`, `lib/auth/auth.ts`, and
  `lib/net/safe-fetch.ts` are evaluated once at boot. Documented in
  `.env.example` + README Quick Start.
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

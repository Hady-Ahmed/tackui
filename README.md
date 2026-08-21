# AG-UI Chat

A unified frontend for custom agents speaking the [AG-UI protocol](https://docs.ag-ui.com). Built on [CopilotKit](https://copilotkit.ai) with a pluggable agent registry — add any AG-UI-compatible backend with zero UI code changes.

## Features

- **Streaming chat** — token streaming, multi-turn conversations, cancel/resume
- **Multi-agent switching** — per-agent conversation threads with sidebar picker
- **Human-in-the-loop interrupts** — approve/deny cards for agent actions
- **Tool-call visualization** — expandable cards with arguments, results, copy button, error detection
- **Conversation persistence** — Postgres-backed threads with inline rename and delete
- **Dynamic agent registry** — add, edit, and remove agents via the admin UI with no restart
- **Test connection** — server-side reachability probe with sidebar status indicators
- **Collapsible sidebar** — icon-only mode with smooth transition, persists across reloads
- **Authentication** — email/password, Google, GitHub, and OIDC SSO (Keycloak, Authentik, Okta, Entra, etc.)
- **Organizations** — every user gets a personal workspace on signup; agents and conversations are scoped to the workspace
- **Roles & user management** — admin/member roles, first user is admin, ban/unban, set roles
- **Per-user scoping** — each user only sees their own conversations within their active workspace
- **Email verification + password reset** — optional, via Resend. When enabled, accounts require email verification before sign-in.
- **Solo mode** — `AUTH_DISABLED=true` skips login entirely for single-user deployments
- **Rate limiting** — two-layer (per-IP flood protection + per-user route limits) with concurrent SSE stream caps
- **Error tracking** — optional Sentry integration (no-op when DSN is not set)
- **Light/dark mode** — toggle in the sidebar footer; defaults to system preference, then remembers your choice

## Quick Start

### Option A: Docker Compose (easiest)

```bash
git clone <repo-url>
cd agent-front-end
docker-compose up
```

Open [http://localhost:3000](http://localhost:3000). That's it — Postgres,
migrations, and the app all start automatically. Auth is disabled by default
(solo mode); see [Self-hosting](#self-hosting-with-docker) to enable it.

### Option B: Manual setup

```bash
git clone <repo-url>
cd agent-front-end
npm install
```

You'll need a Postgres database. The fastest way to get one running locally:

```bash
docker run --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
```

Create a `.env.local` file:

```bash
# Required
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
BETTER_AUTH_SECRET=<generate with: openssl rand -hex 32>
BETTER_AUTH_URL=http://localhost:3000

# Optional: skip login entirely (solo mode)
# AUTH_DISABLED=true
```

Migrations run automatically on boot — no manual `npm run migrate` needed.
For local dev (without Docker), you can trigger them explicitly:

```bash
npm run dev
```

The dev server boots, runs migrations against `DATABASE_URL`, and starts the app. The first user to sign up becomes the admin.

> **Env changes require a restart.** Next.js reads `.env.local` at boot and does not hot-reload env vars. After editing `.env.local`, stop the dev server (`Ctrl+C`) and run `npm run dev` again.

> **No agents configured?** Navigate to **Manage agents** in the sidebar (or `/agents`) to add your first agent backend. Only admins see this link.

## Self-hosting with Docker

The bundled `docker-compose.yml` runs the app + Postgres with one command.
Migrations run automatically on boot (via `instrumentation.ts`) — no manual
`npm run migrate` needed.

### Solo mode (default)

```bash
docker-compose up
```

Auth is disabled (`AUTH_DISABLED=true`). Everyone is the admin. Good for
local dev, trying the app, or single-user self-hosted deployments.

### With auth enabled

```bash
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
AUTH_DISABLED=false \
docker-compose up
```

The first user to sign up becomes the admin. Configure social login providers
by passing their env vars:

```bash
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
AUTH_DISABLED=false \
GITHUB_CLIENT_ID=your_id \
GITHUB_CLIENT_SECRET=your_secret \
docker-compose up
```

### Data persistence

Postgres data is stored in a named Docker volume (`pg_data`) and persists
across `docker-compose down` + `up`. To wipe all data:

```bash
docker-compose down -v
```

### Updating

```bash
git pull
docker-compose up --build
```

The app re-runs migrations on boot — new schema changes apply automatically.

### Custom port

```bash
APP_PORT=8080 docker-compose up
# → http://localhost:8080
```

### Build-time vs runtime environment variables

Next.js inlines any variable prefixed with `NEXT_PUBLIC_` into the client JavaScript bundle **at build time**. These cannot be supplied at runtime — once `next build` (or `docker build`) runs, the value is frozen in the generated `.next/static/chunks/*.js` files.

This matters when deploying via Docker. The `docker-compose.yml` passes `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` as **build args** (under `build.args`), not runtime environment variables. Supply them in your shell before building:

```bash
NEXT_PUBLIC_SENTRY_DSN=https://...@o123.ingest.sentry.io/456 \
docker-compose up --build
```

Without them, client-side Sentry silently stays a no-op (`instrumentation-client.ts` guards on presence). Server-side Sentry (`SENTRY_DSN`, no prefix) is a runtime variable and can be changed with a container restart — no rebuild needed.

All other environment variables (`DATABASE_URL`, `BETTER_AUTH_SECRET`, Stripe keys, etc.) are runtime-only and can be rotated without rebuilding the image.

## Authentication

Auth is powered by [Better Auth](https://better-auth.com) with a Postgres adapter (same database as agents and conversations).

### Login methods

All login methods are optional and self-configuring — the login UI only shows providers that have env vars set.

| Method | Env vars | Setup |
| --- | --- | --- |
| Email/password | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Always enabled |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | [GitHub Developer Settings](https://github.com/settings/developers) |
| OIDC SSO | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ISSUER` | Your IdP (Keycloak, Authentik, Okta, Entra, etc.) |

OAuth callback URLs follow the pattern `{BETTER_AUTH_URL}/api/auth/callback/{providerId}`:
- Google → `http://localhost:3000/api/auth/callback/google`
- GitHub → `http://localhost:3000/api/auth/callback/github`
- OIDC → `http://localhost:3000/api/auth/callback/oidc`

### Roles

- **Admin** — can add/edit/delete agents, test connections, manage users (set roles, ban/unban). First user to sign up is automatically promoted to admin.
- **User** — can chat with all agents and manage their own conversations. Cannot manage agents.
- Use `npm run create-admin <email> <password> [name]` to create or promote an admin explicitly.

### Account linking

If a user signs up with email/password and later logs in via a social provider (or vice versa) using the same email, the accounts are automatically linked. The user can then log in with either method.

### Solo / no-auth mode

Set `AUTH_DISABLED=true` to skip login entirely. Everyone is treated as the single admin. Useful for local dev or single-user self-hosted deployments where auth is unnecessary.

### Email verification + password reset (optional)

Email verification and password reset are **optional** and env-gated via [Resend](https://resend.com). When `RESEND_API_KEY` is set:

- New email/password signups receive a verification link via email. Users must verify before they can sign in.
- "Forgot password?" link appears on the login page — users can request a password reset email.
- Social/OIDC login delegates verification to the provider (Google/GitHub/OIDC verify emails themselves).
- `requireLocalEmailVerified: true` — prevents account-linking takeover (a social account can't auto-link to an unverified email/password account).

When `RESEND_API_KEY` is **not** set (self-hosters without SMTP):
- Accounts work immediately without verification.
- Password reset is unavailable (the "Forgot password?" link is hidden).
- `requireLocalEmailVerified: false` — trustedProviders mitigates the risk.

**Setup:**
1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails/month)
2. Verify your sending domain in Resend's dashboard
3. Set the env vars:
   ```bash
   RESEND_API_KEY=re_xxxxx
   EMAIL_FROM=noreply@yourdomain.com
   ```
4. Restart the server

## Architecture

```
Browser → proxy.ts (cookie gate) → Next.js App → /api/copilotkit (CopilotRuntime)
                                                    ↓ auth + ALS wrapping
                              ↓ AG-UI event stream (SSE)
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
              LangGraph   Agno     any AG-UI server
```

The CopilotKit runtime is a thin server-side proxy that holds the `agents` map. Each agent speaks AG-UI to its backend. The frontend never talks to backends directly — it talks to the runtime, making agents pluggable. The runtime resolves the user from the session cookie and wraps each request in `AsyncLocalStorage` so the runner can scope conversations per user.

Agent configurations and conversation history are stored in Postgres, shared with Better Auth for users and sessions. Agents are managed at runtime via the `/agents` admin page or the `/api/agents` REST API — no restart needed.

## Adding Agents

Via the admin UI (`/agents` page → "Add agent" form) or `POST /api/agents`:

```json
{
  "name": "Research Agent",
  "description": "LangGraph-powered web research assistant",
  "kind": "agui",
  "endpoint": "http://localhost:8001/agent"
}
```

`id` is **server-generated** (12-char random hex) — never send it in the POST body. The response includes the generated `id`, which you use in PATCH/DELETE URLs.

Optional fields: `graphId` (langgraph only), `langsmithApiKey` (langgraph only).

### Supported Backends

| Kind | Adapter | Endpoint format |
| --- | --- | --- |
| `langgraph` | `LangGraphAgent` | LangGraph Platform API URL (e.g. `:8123`) |
| `agno` | `HttpAgent` (from @ag-ui/client) | AG-UI endpoint (e.g. `:8000/agui`) |
| `agui` | `HttpAgent` (from @ag-ui/client) | Any AG-UI-speaking endpoint |

> If your LangGraph backend uses `ag-ui-langgraph` (AG-UI protocol directly, not the LangGraph Platform API), use `kind: "agui"` instead of `"langgraph"`.

## Environment Variables

See [`.env.example`](.env.example) for the full list with comments.

| Variable | Required? | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string (e.g. `postgres://user:pass@localhost:5432/dbname`) |
| `BETTER_AUTH_SECRET` | Yes (unless `AUTH_DISABLED=true`) | Secret for signing session cookies. Generate with `openssl rand -hex 32`. The app refuses to boot without it when auth is enabled. |
| `BETTER_AUTH_URL` | Yes (unless `AUTH_DISABLED=true`) | Public base URL of the app (e.g. `http://localhost:3000`) |
| `AUTH_DISABLED` | No | Set to `true` to skip login (solo mode). **Never use this in any deployment exposed to the internet or shared users.** |
| `ALLOW_PRIVATE_ENDPOINTS` | No | Set to `true` to allow creating/editing agents with endpoints that resolve to private/internal IPs (e.g. when agent backends run on the same host). Defaults to `false` (blocks private IPs to prevent SSRF). Hard-locked off under `SAAS_MODE` regardless of this flag. |
| `TRUSTED_PROXY_HOPS` | No | Number of trusted reverse-proxy hops in front of the server, used to resolve the real client IP from `X-Forwarded-For` (default `1`). Set to `2` for Cloudflare → Nginx → app, etc. When behind Cloudflare → Traefik (Coolify), the proxy checks `CF-Connecting-IP` first (Traefik overwrites XFF with the edge IP). This env var is the fallback for non-Cloudflare deploys. |
| `CONCURRENT_RUN_TIMEOUT_MS` | No | Watchdog timeout (ms) for concurrent-run rate-limit slots. Default `600000` (10 min). Floor `60000`. Safety net only — the actual SSE stream / agent run is NOT cancelled; only the counter is decremented to prevent slot leaks when a client opens a run and drops TCP without triggering `ReadableStream.cancel()`. Override if your agents do legitimately long research runs. |
| `SENTRY_DSN` | No | Sentry DSN for server-side error tracking. No-op if unset. |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry DSN for client-side error tracking (public, exposed to browser). No-op if unset. |
| `SENTRY_TRACES_SAMPLE_RATE` | No | Transaction trace sampling rate, 0.0–1.0 (default: 0.1). Set to 0 to disable. |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | No | Client-side trace sampling rate (default: 0.1). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | No | Google OAuth provider |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | No | GitHub OAuth provider |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_ISSUER` | No | External OIDC SSO (Keycloak, Authentik, Okta, Entra, etc.) |
| `RESEND_API_KEY` | No | Resend API key. When set, enables email verification + password reset. |
| `EMAIL_FROM` | No | Sender address for emails (e.g. `noreply@yourdomain.com`). Must be a verified domain in Resend. Defaults to `noreply@localhost`. |
| `PG_POOL_MAX` | No | Max connections in the Postgres pool (default: `10`) |
| `PG_CONNECT_TIMEOUT` | No | Postgres connection timeout in ms (default: `5000`) |
| `POSTGRES_PASSWORD` | No (docker-compose only) | Postgres password (default: `postgres`) |
| `POSTGRES_DB` | No (docker-compose only) | Postgres database name (default: `agent_frontend`) |
| `APP_PORT` | No (docker-compose only) | Host port to expose the app on (default: `3000`) |

### SaaS mode (hosted only — self-hosters ignore)

These variables configure the hosted SaaS offering. They have **no effect**
on a self-hosted deployment and can be left unset. The SaaS code paths
(landing page at `/`, billing, plan enforcement, legal pages, forced SSRF
guard) are gated behind `SAAS_MODE` and never run when it is unset.

| Variable | Description |
| --- | --- |
| `SAAS_MODE` | Set to `true` on the hosted instance. Enables the landing page at `/` (chat moves to `/app`), `/terms` + `/privacy` + `/pricing` routes, plan enforcement (Free/Pro/Team), and a hard-locked SSRF guard (private endpoints are NEVER allowed on the shared host, regardless of `ALLOW_PRIVATE_ENDPOINTS`). |
| `STRIPE_SECRET_KEY` | Stripe SDK key. Required for paid plans; without it, SaaS mode runs but all users sit on the Free plan — no checkout/portal UI renders. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (from the dashboard or `stripe listen`). |
| `STRIPE_PRICE_PRO` | Stripe Price ID for the Pro plan. The dollar amount lives in Stripe — edit it there. |
| `STRIPE_PRICE_TEAM` | Stripe Price ID for the Team plan (per-seat). |

> **Self-hosters:** do not set any of these. Self-host is the unlimited,
> no-billing, private-endpoints-allowed experience. See
> [Self-hosting vs SaaS](#self-hosting-vs-saas) below.

## Self-hosting vs SaaS

AG-UI Chat ships from one codebase in two modes, gated by a single env var
(`SAAS_MODE`):

- **Self-host (the OSS product, default — `SAAS_MODE` unset):** chat lives
  at `/`, no billing, no plan enforcement, no landing/legal pages. Private
  agent endpoints allowed via `ALLOW_PRIVATE_ENDPOINTS=true`. Multi-user +
  multi-org fully supported when auth is enabled (not crippleware).
- **SaaS (the hosted instance, `SAAS_MODE=true`):** landing page at `/`,
  chat at `/app`, Stripe billing with Free/Pro/Team plans, plan
  enforcement (agent count, concurrent runs, rate limits, seats), legal
  pages, cookie notice. Private endpoints are **never** allowed on the
  shared host (SSRF guard hard-locked on) — regardless of
  `ALLOW_PRIVATE_ENDPOINTS`.

Self-hosters never see SaaS code paths: the landing page, billing UI,
plan checks, and legal pages are all gated behind `SAAS_MODE` and are
inert when it's unset. There is no separate codebase to maintain or
version-sync.

**Workspace model (Vercel/GitHub pattern):** every user gets a personal
workspace on signup (Free). Creating additional workspaces is always
available — new workspaces start on Free (3 agents, 1 member, no invites).
Upgrade a workspace to Pro for solo capacity, or to Team for collaboration
(invites + per-seat billing). The org switcher appears when a user belongs
to >1 org (created a second workspace or been invited to someone else's
team).

| | Self-host (solo) | Self-host (multi-user) | SaaS Free | SaaS Pro | SaaS Team |
| --- | --- | --- | --- | --- | --- |
| Agents | unlimited | unlimited | 3 | unlimited | unlimited |
| Concurrent runs | 3 | 3 | 1 | 3 | 5 |
| Create workspace | n/a | ✅ unlimited | ✅ (starts Free) | ✅ (starts Free) | ✅ (starts Free) |
| Org switcher | n/a (1 org) | ✅ | n/a (1 org) | n/a (1 org) | ✅ |
| Team seats | 1 (solo) | unlimited | 1 (personal) | 1 (personal) | per-seat (min 2, paid) |
| Private endpoints | ✅ | ✅ | ❌ | ❌ | ❌ |
| Support | community | community | community | priority | priority |


## Security

### `AUTH_DISABLED=true` is for single-user setups only

When `AUTH_DISABLED=true`, **everyone who can reach the app is the admin** — no login, no session, full access to all agents, conversations, and settings. This is convenient for local dev or a personal deployment on a trusted network, but it must **never** be exposed to the internet or shared with untrusted users. If you need multi-user access, enable auth (`AUTH_DISABLED=false` with `BETTER_AUTH_SECRET` set).

### Use a TLS-terminating reverse proxy in production

The app does not terminate TLS itself. In production, put it behind a reverse proxy that handles TLS (Caddy, Nginx, Traefik, Cloudflare Tunnel, etc.). Session cookies sent over plain HTTP can be sniffed. The app sends `Strict-Transport-Security` (HSTS) in production mode to instruct browsers to always use HTTPS.

### SSRF protection on agent creation

The "Test connection" button and agent creation/editing send the agent endpoint URL to the server. To prevent [Server-Side Request Forgery](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery) (an attacker using the server to scan internal services or steal cloud metadata credentials), **agent creation and editing block URLs that resolve to private/internal IP addresses** by default (`127.0.0.1`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, IPv6 equivalents).

The "Test connection" reachability probe applies the same `assertSafeUrl` SSRF guard as agent create/edit. Any logged-in user can probe (the sidebar's status dots need it for members too), but only public URLs are allowed — internal IPs / cloud-metadata endpoints are blocked. Self-hosters who need to probe `localhost`/private-IP backends set `ALLOW_PRIVATE_ENDPOINTS=true` (the same flag that gates agent create/edit). Raw error messages from the probe are masked (they can leak internal hostnames via DNS errors); the full error is logged server-side.

Once an agent is stored, the CopilotKit runtime fetches it during runs without re-checking — this is intentional, so existing agents keep working even if you later change the env var.

If your agent backends run on the same host as the frontend (common for self-hosters), set `ALLOW_PRIVATE_ENDPOINTS=true` to allow internal URLs when creating or editing agents. This is safe when only trusted users can reach the admin page.

### Secret handling

- **`BETTER_AUTH_SECRET`** — the app refuses to boot in auth mode without it. A missing secret would silently sign session cookies with a publicly-known value, allowing account forgery.
- **`langsmithApiKey`** — stored encrypted at rest in Postgres (via your database's disk encryption) and never returned in API responses. The admin edit form shows whether a key is set (via `hasLangsmithApiKey: boolean`) but never displays the value. To replace it, type a new value; to keep the existing one, leave the field blank.
- **Social/OIDC client secrets** — only read from environment variables, never stored in the database or exposed via API responses.

### Security headers

The app sets the following headers on all responses:

- `Content-Security-Policy` — restricts script/style/connect/frame sources (defense against XSS and clickjacking)
- `X-Frame-Options: DENY` — prevents the app from being embedded in an iframe (legacy clickjacking defense)
- `X-Content-Type-Options: nosniff` — prevents MIME-type sniffing
- `Referrer-Policy: strict-origin-when-cross-origin` — limits referrer information sent to cross-origin destinations
- `Permissions-Policy` — denies access to geolocation, microphone, camera, payment, USB
- `Strict-Transport-Security` (production only) — forces HTTPS for 1 year

### Rate limiting

The app has two-layer rate limiting to protect against abuse and server overload:

**Per-IP flood protection** (in `proxy.ts`, pre-auth): 300 requests/min per IP on all `/api/*` routes (except `/api/health` which is unlimited, and `/api/auth/*` which has its own limiter). Uses `CF-Connecting-IP` (Cloudflare) or `X-Forwarded-For` (with `TRUSTED_PROXY_HOPS`) for IP extraction behind a reverse proxy.

**Per-user route limits** (in route handlers, post-auth):

| Route | Limit | Concurrent |
| --- | --- | --- |
| `/api/copilotkit/*` (POST runs only — connect/info exempt) | 20/min per user | 3 concurrent run streams per user |
| `/api/agents/reachability-probe` | 10/min per user | — |
| `/api/agents` POST + PATCH/DELETE | 10/min per user | — |
| `/api/agents` GET | 60/min per user | — |
| `/api/threads/[id]` PATCH/DELETE | 30/min per user | — |

**Better Auth rate limiting**: sign-in is limited to 10/min per IP, sign-up to 5/min per IP.

429 responses include standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers. In solo mode (`AUTH_DISABLED=true`), per-user limits are not enforced — per-IP flood protection still applies.

**Multi-instance note:** The in-memory rate-limit store is per-process. For multi-instance deployments, replace it with a Redis-backed store (the interface stays the same).

### Error tracking

The app integrates [Sentry](https://sentry.io) via `@sentry/nextjs` for automatic error capture on both server and client. It's **completely optional** — if `SENTRY_DSN` (server) and `NEXT_PUBLIC_SENTRY_DSN` (client) are not set, Sentry is a no-op and no data is sent anywhere. Self-hosters can opt out by simply not setting these env vars.

- `SENTRY_DSN` — server-side DSN (kept secret)
- `NEXT_PUBLIC_SENTRY_DSN` — client-side DSN (exposed to the browser; use Sentry's public DSN)
- `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` — transaction trace sampling (default: 0.1 = 10%). Set to 0 to disable performance traces.

Error boundaries (`app/error.tsx` + `app/global-error.tsx`) call `Sentry.captureException` before rendering the fallback UI, so render crashes are captured even if the user doesn't report them.

### Known limitations (not yet implemented)

These are documented for transparency and will be addressed in future releases:

- **No CSRF token on mutation routes** — the app relies on `sameSite=lax` session cookies (Better Auth default) and Better Auth's built-in CSRF protection on `/api/auth/*`. Mutation routes (`/api/agents`, `/api/threads`) are not behind an explicit CSRF token. This is acceptable for `sameSite=lax` but is not defense-in-depth.
- **Single-instance cache** — the in-memory thread cache and rate-limit store are per-process. Multi-instance deployments (horizontal scaling) will see stale threads until a cache invalidation mechanism (PG `LISTEN/NOTIFY`) is added, and rate limits will be per-instance until a Redis-backed store is plugged in. Single-instance self-hosted deployments are unaffected.

## Tech Stack

- [Next.js 16](https://nextjs.org) (App Router, TypeScript, Tailwind CSS v4)
- [CopilotKit v2](https://copilotkit.ai) (AG-UI client + runtime)
- [AG-UI Protocol](https://docs.ag-ui.com) (event-based agent communication)
- [Better Auth](https://better-auth.com) (email/password, OAuth, OIDC SSO, admin roles, organizations)
- Postgres (conversation persistence + agent registry + auth via `pg`)
- [Zod](https://zod.dev) (runtime validation)

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Start dev server (`http://localhost:3000`) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npm run test` | Run tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run create-admin` | Create/promote an admin user (`npm run create-admin <email> <password> [name]`) |
| `npx tsc --noEmit` | Type checking |

## Contributing

See [AGENTS.md](AGENTS.md) for architecture details, development conventions, and the full project structure. PRs welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

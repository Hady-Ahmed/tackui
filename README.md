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
- **Roles & user management** — admin/member roles, first user is admin, ban/unban, set roles
- **Per-user scoping** — each user only sees their own conversations
- **Solo mode** — `AUTH_DISABLED=true` skips login entirely for single-user deployments
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

Run the migrations (creates the app's tables + Better Auth's tables):

```bash
npm run migrate
npx @better-auth/cli migrate --config lib/auth/auth.ts
```

Then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The first user to sign up becomes the admin.

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
  "id": "research",
  "name": "Research Agent",
  "description": "LangGraph-powered web research assistant",
  "kind": "agui",
  "endpoint": "http://localhost:8001/agent"
}
```

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
| `BETTER_AUTH_SECRET` | Yes (unless `AUTH_DISABLED=true`) | Secret for signing session cookies. Generate with `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Yes (unless `AUTH_DISABLED=true`) | Public base URL of the app (e.g. `http://localhost:3000`) |
| `AUTH_DISABLED` | No | Set to `true` to skip login (solo mode) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | No | Google OAuth provider |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | No | GitHub OAuth provider |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_ISSUER` | No | External OIDC SSO (Keycloak, Authentik, Okta, Entra, etc.) |

## Tech Stack

- [Next.js 16](https://nextjs.org) (App Router, TypeScript, Tailwind CSS v4)
- [CopilotKit v2](https://copilotkit.ai) (AG-UI client + runtime)
- [AG-UI Protocol](https://docs.ag-ui.com) (event-based agent communication)
- [Better Auth](https://better-auth.com) (email/password, OAuth, OIDC SSO, admin roles)
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

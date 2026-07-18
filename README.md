# AG-UI Chat

A unified frontend for custom agents speaking the [AG-UI protocol](https://docs.ag-ui.com). Built on [CopilotKit](https://copilotkit.ai) with a pluggable agent registry — add any AG-UI-compatible backend with zero UI code changes.

## Features

- **Streaming chat** — token streaming, multi-turn conversations, cancel/resume
- **Multi-agent switching** — per-agent conversation threads with sidebar picker
- **Human-in-the-loop interrupts** — approve/deny cards for agent actions
- **Tool-call visualization** — expandable cards with arguments, results, copy button, error detection
- **Conversation persistence** — SQLite-backed threads with inline rename and delete
- **Dynamic agent registry** — add, edit, and remove agents via the admin UI with no restart
- **Test connection** — server-side reachability probe with sidebar status indicators
- **Collapsible sidebar** — icon-only mode with smooth transition, persists across reloads
- **Authentication** — email/password, Google, GitHub, and OIDC SSO (Keycloak, Authentik, Okta, Entra, etc.)
- **Roles & user management** — admin/member roles, first user is admin, ban/unban, set roles
- **Per-user scoping** — each user only sees their own conversations
- **Solo mode** — `AUTH_DISABLED=true` skips login entirely for single-user deployments
- **Light/dark mode** — toggle in the sidebar footer; defaults to system preference, then remembers your choice

## Quick Start

```bash
git clone <repo-url>
cd agent-front-end
npm install
```

Create a `.env.local` file:

```bash
# Required (generate with: openssl rand -hex 32)
BETTER_AUTH_SECRET=<your-secret>
BETTER_AUTH_URL=http://localhost:3000

# Optional: skip login entirely (solo mode)
# AUTH_DISABLED=true
```

Then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The first user to sign up becomes the admin.

> **No agents configured?** Navigate to **Manage agents** in the sidebar (or `/agents`) to add your first agent backend. Only admins see this link.

## Authentication

Auth is powered by [Better Auth](https://better-auth.com) with a SQLite adapter (same database as agents and conversations).

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

Agent configurations and conversation history are stored in a SQLite database (`./data/agent-state.db`), shared with Better Auth for users and sessions. Agents are managed at runtime via the `/agents` admin page or the `/api/agents` REST API — no restart needed.

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
| `BETTER_AUTH_SECRET` | Yes (unless `AUTH_DISABLED=true`) | Secret for signing session cookies. Generate with `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Yes (unless `AUTH_DISABLED=true`) | Public base URL of the app (e.g. `http://localhost:3000`) |
| `AUTH_DISABLED` | No | Set to `true` to skip login (solo mode) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | No | Google OAuth provider |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | No | GitHub OAuth provider |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_ISSUER` | No | External OIDC SSO (Keycloak, Authentik, Okta, Entra, etc.) |
| `AGENT_DB_PATH` | No | SQLite database path (defaults to `./data/agent-state.db`) |

## Tech Stack

- [Next.js 16](https://nextjs.org) (App Router, TypeScript, Tailwind CSS v4)
- [CopilotKit v2](https://copilotkit.ai) (AG-UI client + runtime)
- [AG-UI Protocol](https://docs.ag-ui.com) (event-based agent communication)
- [Better Auth](https://better-auth.com) (email/password, OAuth, OIDC SSO, admin roles)
- SQLite (conversation persistence + agent registry + auth via `better-sqlite3`)
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

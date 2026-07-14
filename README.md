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
- **Dark mode** — follows system preference

## Quick Start

```bash
git clone <repo-url>
cd agent-front-end
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The app starts with no agents configured. Navigate to the **Manage agents** link in the sidebar (or `/agents`) to add your first agent backend.

## Architecture

```
Browser → Next.js App → /api/copilotkit (CopilotRuntime)
                              ↓ AG-UI event stream (SSE)
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
              LangGraph   Agno     any AG-UI server
```

The CopilotKit runtime is a thin server-side proxy that holds the `agents` map. Each agent speaks AG-UI to its backend. The frontend never talks to backends directly — it talks to the runtime, making agents pluggable.

Agent configurations are stored in a SQLite database (`./data/agent-state.db`) and managed at runtime via the `/agents` admin page or the `/api/agents` REST API. No restart is needed when adding, editing, or removing agents.

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

## Tech Stack

- [Next.js 16](https://nextjs.org) (App Router, TypeScript, Tailwind CSS v4)
- [CopilotKit v2](https://copilotkit.ai) (AG-UI client + runtime)
- [AG-UI Protocol](https://docs.ag-ui.com) (event-based agent communication)
- SQLite (conversation persistence + agent registry via `better-sqlite3`)
- [Zod](https://zod.dev) (runtime validation)

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Start dev server (`http://localhost:3000`) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Type checking |

## Contributing

See [AGENTS.md](AGENTS.md) for architecture details, development conventions, and the full project structure. PRs welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

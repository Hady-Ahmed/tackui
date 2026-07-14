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

## Commands

```bash
npm run dev      # Start dev server (http://localhost:3000)
npm run build    # Production build
npm run start    # Start production server
npm run lint     # ESLint
npm run test     # Run tests (vitest)
npm run test:watch  # Run tests in watch mode
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
  api/threads/[id]/route.ts    # REST: PATCH/DELETE /api/threads/[id] (rename, delete conversations)
  agents/page.tsx              # Admin UI — add/edit/delete agents + test connection
  layout.tsx                   # Root layout — wraps app in CopilotKitProvider
  page.tsx                     # Main chat page (client component)
  globals.css                  # Global styles + Tailwind

lib/
  agents/
    agents.config.ts           # AgentEntry / AgentKind types (no runtime config)
    agent-store.ts             # SQLite CRUD for agents table (zod-validated)
    registry.ts                # getAgents() factory — reads DB, builds agents map
    persistent-runner.ts       # PersistentAgentRunner — SQLite-backed runner with thread endpoints
    runner-instance.ts         # Shared runner singleton (used by runtime + thread API)

components/
  agent-sidebar.tsx            # Agent picker + conversation list + status dots + rename/delete + collapsible (useThreads)
  chat-shell.tsx               # Chat layout with agent switching + empty-state CTA + collapsible sidebar state + AgentChat wrapper
  hitl/
    approval-card.tsx          # Human-in-the-loop interrupt handlers
  tools/
    tool-renders.tsx           # Tool-call visualization (useRenderTool)
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

## Architecture

```
Browser → Next.js App → /api/copilotkit (CopilotRuntime)
                              ↓ AG-UI event stream (SSE)
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
              LangGraph   Agno     any AG-UI server
```

The CopilotKit runtime is a thin server-side proxy that holds the `agents` map.
Each agent speaks AG-UI to its backend. The frontend never talks to backends
directly — it talks to the runtime, making agents pluggable.

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

## Future (structured for easy upgrade)

- Generative UI / shared state (`useCoAgent`) — requires backend to emit
  `STATE_SNAPSHOT`/`STATE_DELTA` events; neither backend currently does
- Additional backends (CrewAI, Mastra, Pydantic AI, Google ADK, AWS Strands, etc.)

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

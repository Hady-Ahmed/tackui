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
```

Type checking: `npx tsc --noEmit`

## Project Structure

```
app/
  api/copilotkit/[[...path]]/route.ts  # CopilotKit runtime (catch-all — matches /api/copilotkit and all sub-paths)
  layout.tsx                 # Root layout — wraps app in CopilotKitProvider
  page.tsx                   # Main chat page (client component)
  globals.css               # Global styles + Tailwind

lib/
  agents/
    agents.config.ts         # Static agent registry config (add agents here)
    registry.ts              # getAgents() — builds agents map for CopilotRuntime

components/
  agent-sidebar.tsx          # Agent picker + thread sidebar
  chat-shell.tsx             # Chat layout with agent switching
  hitl/
    approval-card.tsx        # Human-in-the-loop interrupt handlers
  tools/
    tool-renders.tsx          # Tool-call visualization (useRenderTool)
```

## Agent Registry

Agents are configured in `lib/agents/agents.config.ts`. To add a new agent:

1. Add an entry to the `agents` array with `id`, `name`, `description`, `kind`,
   `endpoint`, and optional framework-specific fields.
2. Add the corresponding env var to `.env.local`.
3. That's it — no UI or runtime code changes needed.

### Supported agent kinds

| Kind       | Adapter                        | Endpoint format                          |
| ---------- | ------------------------------ | ---------------------------------------- |
| `langgraph`| `LangGraphAgent`               | LangGraph deployment URL (e.g. `:8123`)  |
| `agno`     | `HttpAgent` (from @ag-ui/client) | AG-UI endpoint (e.g. `:8000/agui`)     |
| `agui`     | `HttpAgent` (from @ag-ui/client) | Any AG-UI-speaking endpoint             |

## Environment Variables

See `.env.example`. Copy to `.env.local` and fill in:

- `LANGGRAPH_URL` — LangGraph server URL
- `LANGGRAPH_GRAPH_ID` — LangGraph graph ID
- `LANGSMITH_API_KEY` — LangSmith API key (optional)
- `AGNO_URL` — Agno AG-UI endpoint URL

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
(CopilotKit's `agent.messages` + `InMemoryAgentRunner`) stores and manages all
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
- Generative UI / shared state (`useCoAgent`)
- Multi-agent switching with per-agent threads (`AgentChat` wrapper in
  `chat-shell.tsx` keys `CopilotChat` by `agentId + threadId` and clears the
  agent's in-memory messages on unmount — this prevents duplicate messages on
  switch, since CopilotKit's `/connect` replays all historic events and
  `AbstractAgent.apply()` appends content to existing messages)
- Tool-call visualization (`useRenderTool`)
- In-memory thread runner (no persistence)
- LangGraph + Agno backends wired first

## Future (structured for easy upgrade)

- Dynamic agent registry (DB-backed `getAgents()` + admin UI)
- Persistent thread runner (swap `InMemoryAgentRunner`)
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

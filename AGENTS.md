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
- **Tool-result rendering:** `react-markdown` + `remark-gfm` (renders tool
  results as markdown; no raw HTML — safe by default against backend-supplied
  content)

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

Type checking: `npx tsc --noEmit` — not wired into `npm run build` for speed;
run it before pushing. CI runs lint + tsc + test on every PR.

**Env changes require dev server restart** — Next.js reads `.env.local` at
boot and does not hot-reload env vars. Module-level consts in `proxy.ts`,
`lib/auth/auth.ts`, and `lib/net/safe-fetch.ts` are evaluated once at boot.

## Testing conventions

When adding new functionality, add tests alongside it. The suite uses
[vitest](https://vitest.dev) with an in-memory Postgres emulator (`pg-mem`) —
no Docker required, no cleanup between runs (see `vitest.config.ts`).

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
  `/api/agents/reachability-probe` tests) or `vi.mock(...)` for module-level
  mocks. Restore in `afterEach`.
- **No production code changes for testability** — the in-memory pg-mem
  emulator + vitest's `isolate: true` handle DB isolation without needing
  test-only exports. pg-mem doesn't support `WITH RECURSIVE` CTEs or
  cross-statement `ROLLBACK` — the skipped tests in
  `lib/agents/pg-runner.test.ts` are intentional; don't "fix" them (see
  `docs/architecture.md` Future section for the testcontainers follow-up).
- **Security-critical code** (`lib/auth`, `lib/billing`, `lib/net`,
  `lib/ratelimit`) — test the bypass attempt, not just the happy path.

## Ground rules

- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:` with optional scope) — see CONTRIBUTING.md.
- **Changelog:** notable changes (features, behavior changes, fixes, security
  work) get a bullet under `## [Unreleased]` in `CHANGELOG.md` in the same
  change that introduces them. Released sections are frozen history. Docs-only
  changes and routine chores are skipped. Entry-writing discipline lives in
  CONTRIBUTING.md.
- **Docs describe product behavior, never business strategy** — no
  marketing channels, no conversion/retention framing; design rationale in
  engineering terms.
- **Don't add `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `any` /
  bare `TODO` comments** — zero today; see CONTRIBUTING.md.
- When a change touches an area covered by `docs/`, update that doc in the
  same change (see the docs index at the bottom). A new subsystem gets its
  own `docs/<name>.md` + an entry in the index below in the same change.

## Gotchas — do not break these

- **CopilotKit v2 imports are split across subpaths:** import runtime from
  `@copilotkit/runtime/v2`, React components from `@copilotkit/react-core/v2`
  (NOT `@copilotkit/react-core` — that's the v1 root). `CopilotChat` comes
  from `@copilotkit/react-core/v2` (v2 version with `agentId`/`threadId`
  props), NOT from `@copilotkit/react-ui` (the v1 version without those
  props).
- **The `app/globals.css` Streamdown table shim is load-bearing** — Streamdown
  1.6.x (pinned transitively by CopilotKit) has an attribute bug that breaks
  chat-table layout, and the shim is the fix. Don't "clean it up" without
  first confirming the installed streamdown is past the bug. Full analysis:
  `docs/architecture.md` → "Chat markdown tables + the Streamdown attribute
  bug".
- **`"user"` is a reserved word in Postgres** — double-quote it in all raw
  SQL (`SELECT * FROM "user"`), including in Better Auth hook queries.
- **Agent `id` is server-generated** (12-char random hex) — never
  client-supplied, immutable after creation. The PK is composite `(id,
  org_id)`: the same id can exist in different orgs.
- **Agent `jwtSecret` is write-only** — accepted on POST/PATCH, never
  returned in GET responses (`PublicAgent.hasJwtSecret: boolean` replaces
  it). A blank submit on the edit form preserves the existing value. The
  encryption-at-rest boundary lives entirely inside
  `lib/agents/agent-store.ts`.
- **SSRF guard on any endpoint-accepting route:** any route that takes a
  backend URL (agent create/edit, catalog templates, reachability probe — or
  any new one) must call `assertSafeUrl()` (`lib/net/safe-fetch.ts`) before
  persisting or fetching. Private IPs are blocked unless
  `ALLOW_PRIVATE_ENDPOINTS=true` (hard-locked ON under SaaS mode). The guard
  only fires on PATCH when `endpoint` is actually in the body.
- **Rate-limit wiring on new routes:** every new route handler gets a
  per-user limit via `lib/ratelimit` (`checkUserLimit` / `acquireConcurrent`).
  Run-stream routes must exempt stop/connect paths — otherwise
  stopping a run at the concurrent cap 429s and runs become unstoppable. SSE
  response bodies must be wrapped with `wrapStreamWithRelease` so the
  concurrent counter decrements on close/error/cancel. Solo-mode bypass is
  centralized in the middleware — don't add per-route `AUTH_DISABLED` checks.
- **AG-UI protocol spec:** https://docs.ag-ui.com — see
  [Events](https://docs.ag-ui.com/concepts/events),
  [Messages](https://docs.ag-ui.com/concepts/messages), and
  [Build a server](https://docs.ag-ui.com/quickstart/server) for the backend
  contract.
- **Next.js 16 has breaking changes vs prior versions** — read docs in
  `node_modules/next/dist/docs/` before modifying framework-level code.

## Where things live

- `lib/agents/` — agent store (zod-validated CRUD, pg.Pool-backed), registry
  factory (`getAgents`, per-request), `PostgresAgentRunner` (thread
  persistence + in-memory cache bridge)
- `lib/catalog/` — agent template store + install/usage logic
- `lib/auth/` — Better Auth instance, request context (ALS), solo org
- `lib/billing/` — Stripe subscriptions (inert when billing off)
- `lib/plans/` — plan enforcement gates (short-circuit off SaaS mode)
- `lib/ratelimit/` — two-layer rate limiting (store, limits, middleware,
  stream-wrap)
- `lib/net/` — SSRF guard (`assertSafeUrl`)
- `lib/db/` — shared pg.Pool + versioned SQL migrations (`migrations/*.sql`)
- `lib/tools/` — pure tool-render helpers
- `app/api/` — REST routes (agents, catalog, auth, billing, threads, org,
  health, copilotkit runtime)
- `components/` — chat shell, sidebar, account menu, dialogs, tool renders
- `proxy.ts` — cookie gate + per-IP flood protection + rate limiting
- `docs/` — architecture deep-dives (index below)

## Deeper docs

Read the relevant doc before working in one of these areas — they carry the
full how-it-works detail this file deliberately omits:

- **`docs/architecture.md`** — request flow, runtime, conversation history
  contract, thread runner + cache bridge, Streamdown rendering, Sentry,
  extension points
- **`docs/agent-registry.md`** — agent CRUD + REST API, smoke tests, test connection,
  user identity forwarding, per-agent JWT auth, encryption at rest
- **`docs/catalog.md`** — templates vs installed copies, install semantics,
  lifecycle/tombstones, run gates, monetization gates + copy policy
- **`docs/auth-and-orgs.md`** — Better Auth setup, access control, orgs,
  members, invitations, email verification
- **`docs/security.md`** — SSRF guard, security headers, rate limiting (both
  layers), concurrent cap + watchdog
- **`docs/saas-mode.md`** — SAAS_MODE/BILLING_ENABLED flags, Stripe billing,
  plan enforcement, marketing pages

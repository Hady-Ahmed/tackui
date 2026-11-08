# E2E smoke suite (Tier 1)

The CI canary that proves the app actually runs: the built Next.js server
boots, every surface renders, and the two most important journeys (login,
chat) work end-to-end. Eight tests, one file (`e2e/smoke.spec.ts`), ~6s of
browser time. Run with `npm run test:e2e` (builds first) — or
`npm run test:e2e:local` to reuse an existing build.

## What's real, what's faked

The suite runs the **real built app** — the standalone `server.js` the
Dockerfile ships — against a **real Postgres** (a throwaway `docker run`
container) with the **real auth flow** (better-auth session cookies issued by
the login page). The only fake is the model: a mock AG-UI agent, a
dependency-free Node `http` server (`e2e/mock-agent.mjs`) that emits the AG-UI
event stream as SSE `data:` lines — byte-identical to what `@ag-ui/encoder`
produces — so the real CopilotKit runtime path (`/api/copilotkit` → registry →
agent → SSE → chat UI) is exercised end-to-end without an LLM. Runs are
deterministic, fast, and free.

## Lifecycle: `e2e/web-server.mjs`

Playwright's built-in `webServer` starts a single command, but the stack has
an ordering constraint: the Postgres container must exist **before** the app
boots (its instrumentation runs migrations and fails fast without a DB), and
the app needs the container's connection string in its env. So one script owns
the full lifecycle and is the only `webServer` command:

1. Start a throwaway Postgres container (`postgres:16-alpine`, plain
   `docker run` — testcontainers stays in the vitest tier; the harness
   itself is dependency-free on purpose, see the teardown note below).
2. Run migrations (`e2e/migrate.mjs` — a standalone port of `lib/db/migrate.ts`),
   better-auth tables (`e2e/auth-tables.mjs`), and seed data (`e2e/seed.mjs`).
   The app's own boot migrations re-run afterwards as no-ops (idempotent).
3. Start the mock AG-UI agent on loopback port 3999.
4. Copy `.next/static` into `.next/standalone/.next/static`, then start
   `node server.js` (port 3990, loopback).
5. Poll `/api/health?deep=true` until ready, then stay alive until Playwright
   tears the stack down (it kills the whole process group — see below).

**Teardown is outsourced to a detached reaper.** Playwright kills the
webServer process group with a bare SIGKILL — no SIGTERM, no grace period —
so no in-process cleanup can run at shutdown (a SIGKILL'd process executes no
handlers). Instead, right after `docker run` the script spawns a tiny
detached watchdog (`sh` loop in its own session, invisible to the group kill)
that polls the harness pid and runs `docker rm -f` the moment the harness is
gone. Container removal also happens on the direct-signal paths (Ctrl-C,
normal exit), and every startup first sweeps stale `tackui-e2e-pg-*`
containers, so a crashed run leaves nothing behind.

**The standalone static-copy step is load-bearing.** `output: "standalone"`
does not include `.next/static` — the Dockerfile does the same copy in a
`COPY` step. Without it every `/_next/static/*` chunk 404s and no page
hydrates.

App env is passed inline to the child process — never written to `.env.local`,
never inherited from the developer's shell. All values are throwaway (the
`BETTER_AUTH_SECRET`, the fixed-pattern `DB_ENCRYPTION_KEY` — the boot guard
requires a valid 64-hex-char key when auth is on — and the container's
`DATABASE_URL`). The container is disposable; nothing here can touch a real
deployment.

## Seed data (`e2e/seed.mjs`)

- **Platform admin** — created through `auth.api.signUpEmail` (the real
  better-auth flow), then `role = 'admin'` + verified email via SQL, the same
  shape `scripts/create-admin.ts` produces.
- **Personal org + owner membership** — inserted directly, mimicking what
  `lib/auth/auth.ts`'s session hook does on first login.
- **One agent** — id `e2e-mock-agent`, auth mode `jwt`, endpoint
  `http://127.0.0.1:3999/` (the mock agent).

## The eight tests

| Test | Proves |
| --- | --- |
| login page renders | The app boots and serves hydrating pages; form fields + button present, no console errors. |
| health endpoint answers | `/api/health?deep=true` reports app + Postgres + migrations healthy. |
| login works, session persists | Real better-auth email/password login through the page, redirect to `/app`, session survives a full reload (exercises the `proxy.ts` cookie gate). |
| chat journey completes | A message sent in the chat UI produces the mock agent's reply — the full run path works. |
| agent list renders | `/agents` lists the seeded agent. |
| catalog renders | `/app/catalog` renders its header + empty state. |
| builder renders | The add-agent entry point is present. |
| platform admin renders | `/admin` is reachable for the seeded platform admin. |

Every UI test asserts its core elements **and** a clean console: uncaught
`pageerror`s always fail the test; `console.error` messages that are browser
resource-load noise (`Failed to load resource`) are filtered, because optional
requests 404 by design (e.g. `/api/billing/subscription` when billing is off —
the client treats the 404 as "no badge"). A test that needs a specific request
to succeed asserts on the UI outcome instead.

## Locator discipline

- **`getByPlaceholder(..., { exact: true })` everywhere.** Playwright's
  placeholder matching is substring by default, and the breakage test found
  the blind spot: a renamed placeholder (`"Broken Email Field"`) still
  satisfied `getByPlaceholder("Email")`. Exact matching closes it.
- **The login page is fully client-rendered** (`BAILOUT_TO_CLIENT_SIDE_RENDERING`)
  — never assert on SSR HTML for its form fields; drive the browser.
- The chat UI ships CopilotKit's own `data-testid`s
  (`copilot-chat-textarea`, `copilot-assistant-message`, …) — prefer them over
  styling-coupled selectors.

## Canaries must die

A smoke suite is only worth its CI minutes if it fails when the app breaks.
This was verified with an intentional breakage: renaming the login email
placeholder → 7 of 8 tests fail (all but the health probe, which never touches
the UI); restoring the source → 8 of 8 pass. Re-run a breakage check whenever
tests are added — a test that has never failed is not a test.

## Running locally

```bash
npm run test:e2e        # build + run (the CI path)
npm run test:e2e:local  # skip the build — reuse .next/standalone
npm run test:e2e:headed # visible browser for debugging
```

Docker must be running (the throwaway Postgres is a container). Ports 3990
(app) and 3999 (mock agent) are loopback-only; a stray `next-server` from a
previous run causes `EADDRINUSE` — `pkill -f next-server` clears it.

## Tier 2 (not built)

Deeper journeys belong in new files, not grown into the smoke suite: agent
CRUD through the UI, catalog install flow, builder flows, org/invitation
management, billing. Same harness (`web-server.mjs` lifecycle, helpers,
seeding), more tests per area.

# E2E suite (Tier 1 smoke + Tier 2 depth)

The CI canary that proves the app actually runs: the built Next.js server
boots, every surface renders, and the two most important journeys (login,
chat) work end-to-end. Eight tests, one file (`e2e/smoke.spec.ts`), ~6s of
browser time. Deeper journeys live in sibling specs that reuse the same
harness — Tier 2 so far: `e2e/chat.spec.ts` (chat depth) and
`e2e/agents.spec.ts` (agent CRUD), below. Run
with `npm run test:e2e` (builds first) — or `npm run test:e2e:local` to
reuse an existing build.

## What's real, what's faked

The suite runs the **real built app** — the standalone `server.js` the
Dockerfile ships — against a **real Postgres** (a throwaway `docker run`
container) with the **real auth flow** (better-auth session cookies issued by
the login page). The only fake is the model: a mock AG-UI agent, a
dependency-free Node `http` server (`e2e/mock-agent.mjs`) that emits the AG-UI
event stream as SSE `data:` lines — byte-identical to what `@ag-ui/encoder`
produces — so the real CopilotKit runtime path (`/api/copilotkit` → registry →
agent → SSE → chat UI) is exercised end-to-end without an LLM. Runs are
deterministic, fast, and free. One conditional branch: a message containing
the trigger phrase `"use the tool"` makes the same reply carry AG-UI
tool-call events (`TOOL_CALL_START/ARGS/END` + `TOOL_CALL_RESULT`) — the
plain-reply path stays byte-identical, and Tier 1's chat test guards that.

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
   `node server.js` (port 3990, loopback) — or, in image mode, run the
   `E2E_APP_IMAGE` container (see below).
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

### Image mode (`E2E_APP_IMAGE`)

Setting `E2E_APP_IMAGE=<tag>` swaps the app-under-test from the local
standalone build to that **container** — the packaged artifact the
Dockerfile ships. Only step 4 changes; Postgres, migrations, seed, mock
agent, and the tests are identical. One runtime env block (`appEnv`)
is shared verbatim between both modes, so the spawn and the container
cannot drift.

The container runs with `--network host` on purpose: the mock agent is
loopback-only (a permanent property) and pg is published to host loopback,
so host networking lets the container reach both exactly as the spawned
process does — no docker network to wire, no seed-URL changes, and the
loopback-only property is preserved. The container boundary isn't doing
security work here — it's the same app with the same throwaway env.

```bash
docker build -t tackui:ci .                 # build once
E2E_APP_IMAGE=tackui:ci npm run test:e2e:local   # no local build needed
```

In CI this is the second half of the `image` job (below).

## Seed data (`e2e/seed.mjs`)

- **Platform admin** — created through `auth.api.signUpEmail` (the real
  better-auth flow), then `role = 'admin'` + verified email via SQL, the same
  shape `scripts/create-admin.ts` produces.
- **Personal org + owner membership** — inserted directly, mimicking what
  `lib/auth/auth.ts`'s session hook does on first login.
- **One agent** — id `e2e-mock-agent`, auth mode `jwt`, endpoint
  `http://127.0.0.1:3999/` (the mock agent).

## The eight Tier 1 tests

| Test | Proves |
| --- | --- |
| login page renders | The app boots and serves hydrating pages; form fields + button present, no console errors. |
| health endpoint answers | `/api/health?deep=true` reports app + Postgres + migrations healthy. |
| login works, session persists | Real better-auth email/password login through the page, redirect to `/app`, session survives a full reload (exercises the `proxy.ts` cookie gate). |
| chat journey completes | A message sent in the chat UI produces the mock agent's reply — the full run path works (plain-reply; also the regression guard for the mock agent's unchanged plain path). |
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

## The parallel-mutation rule

`fullyParallel` workers share ONE seeded database per run. The smoke suite
only *reads*; Tier 2 specs *mutate*. So every mutating test obeys
**create-own / mutate-own / delete-own**:

- Every mutation targets an agent (thread, row, …) that the test created
  itself, under a unique name per run (a random suffix is enough — the
  shared fixtures have fixed names, everything else must be unambiguous).
- Never touch the seeded fixtures: the `e2e-mock-agent` agent, the seed
  admin's credentials, or anything another spec reads — other workers run
  concurrently against the same rows.
- Never assert on global counts (another worker may add rows while the
  test runs) — scope every assertion to the rows the test owns.
- Clean up (delete) everything the test created before it ends where
  practical — and assert the final state within the test's own
  assertions rather than relying on teardown.

## The auth budget

Every test pays one real login (`helpers.ts` `login()`), and better-auth
caps sign-in at 10/min per IP (`lib/auth/auth.ts` — in production this is
the brute-force guard; the harness runs with it fully enabled). A suite
that grows one login per test therefore hits a hard ceiling: at Tier 2's
15 tests, a fast machine compresses the whole run into ~60s and the
rolling window overflows — the last login wave 429s ("Too many requests")
and tests die in `login()`. Found exactly that way when the agent-CRUD
spec joined the suite (#102).

Three conventions keep the suite under the cap as Tier 2 grows:

- **A mutating Tier 2 file spends ONE login.** The file declares
  `test.describe.configure({ mode: "serial" })` — its tests run
  back-to-back in a single worker — and a worker-scoped fixture performs
  the one real login-page flow, handing the session state to each test's
  fresh context. Cookies are the ones the real login issued (nothing is
  faked); each test still gets its own page, so console-error watching
  stays per-test. See `e2e/agents.spec.ts` — the read-only specs
  (smoke, chat depth) keep the per-test login because each is testing a
  fresh-session journey, not CRUD.
- **`login()` never bursts the cap.** Playwright workers are separate OS
  processes with no shared lock, so sign-ins are paced through the
  filesystem: each login claims the next slot ≥ 7s after the last
  claimed one (an atomic `wx` create in a shared temp dir — a losing
  claimant simply aims for the next slot) and waits for it before
  touching the login page. 60s window / 7s spacing ⇒ at most 9 sign-ins
  in any window against the 10 cap: the limiter is never tripped, and
  every login still goes through the real page. Without the pacer the
  retry below is self-defeating — each 429ed attempt also consumes
  limiter budget, so the tail can't out-wait a 60s window from inside a
  60s test timeout.
- **`login()` rides out 429s anyway.** On the rate limiter's "Too many
  requests" banner it waits a jittered interval and retries (bounded) —
  the fallback for the genuinely transient (a concurrent run sharing
  the IP), not the primary defense. A broken login page is not
  transient, and the retry must not mask it: anything else surfaces as
  the original navigation timeout. Jitter keeps parallel workers from
  retrying in lockstep.

The pacer's queue is paid for in test time — 12 logins at ≥7s spacing
puts the last slot up to ~80s out — so the Playwright test timeout is
120s, not 60s: the wait happens inside the test, and a test must not
die of its own suite's scheduling. Still a strict ceiling: a hung
journey fails within two minutes.

Sign-ins aren't the only shared budget. `agentRead` (60/min per user)
is charged by ten routes — the agents list on every sidebar and /agents
load, `can-manage-agents` on every page that shows an add affordance,
the catalog, models, tools, connectors, credentials. Every test IS the
same seeded admin, so the full run's read demand (~66 charges in the
first fixed window, measured) sits right at the cap and pages render
their error panes ("Couldn't load your agents — check your connection
and try again.") at the tail. Squeezing test-side can't deterministically
fix an aggregate this tight, so the harness raises the read cap the same
way it allows loopback endpoints: `AGENT_READ_RATE_MAX=600` in the app
env (lib/ratelimit/limits.ts `maxFromEnv` — default stays 60 in prod;
the knob exists for busy self-hosted instances, the harness is just its
loudest user). Specs that need a table still carry the belt: the page's
own Retry button re-fetches, and `openAgents` (e2e/agents.spec.ts)
clicks it and waits for rows instead of failing on a transient
overflow — read-only specs keep their plain assertions, since their
failures under sustained overflow are real signals, not noise.

## Canaries must die

A smoke suite is only worth its CI minutes if it fails when the app breaks.
This was verified with an intentional breakage: renaming the login email
placeholder → 7 of 8 tests fail (all but the health probe, which never touches
the UI); restoring the source → 8 of 8 pass. Re-run a breakage check whenever
tests are added — a test that has never failed is not a test.

## Packaging gate: the CI `image` job

The smoke suite runs the app as a bare `node server.js` process on the CI
runner — Ubuntu, glibc. That never exercises the container the Dockerfile
ships: `node:24-alpine` runs **musl**, the one environment where native
(C/C++) addon resolution can differ from every other job (prebuilt `.node`
binaries ship per platform + libc; `sharp`/libvips is the obvious resident).
A musl-broken dep would keep lint/typecheck/test/e2e green and fail at
container boot — in someone's production compose stack.

The `image` job closes that gap on every PR:

1. `docker build` the image the PR actually ships (GHA-cached — the deps
   layer only rebuilds when `package-lock.json` changes).
2. Boot it against a throwaway `postgres:16-alpine` on a docker network —
   the same plain-`docker run` pattern as the harness above, with the
   minimal boot env (`AUTH_DISABLED=true`, `DATABASE_URL` pointing at the
   pg container by name; matching the compose default).
3. Poll `/api/health?deep=true` and require `ok === true`, `db === true`,
   and a numeric migration count — the app booted, connected, and
   auto-migrated. The response shape is asserted, not a hard count: adding
   migrations must never break the gate.

Harness: `e2e/image-smoke.mjs` (dependency-free, like `web-server.mjs` —
runs on the runner with nothing but docker and stock Node). On failure it
dumps the app container's logs before teardown — a boot crash is the exact
failure mode the gate exists for, and its last words ("Cannot find module
… sharp" under musl, say) are the whole diagnosis. Teardown (`docker rm -f`
both containers + network rm) is idempotent on every exit path, and a
crashed run sweeps its own residue on the next start.

The recipe was proven one-off on 2026-11-08 (image `tackui:node24-check`:
deep health `{"ok":true,"db":true,"migrations":14}`, `sharp` loading
natively under musl) when the runtime moved to Node 24 (#91); #96 made it
permanent. The job has two halves: the boot gate above (required), then the
Tier 1 smoke suite against the containerized app via the harness's
`E2E_APP_IMAGE` mode (see the lifecycle section) — so the eight journeys
run against the packaged artifact, not just the boot.

**The image job runs Tier 1 only** (`npm run test:e2e:local --
e2e/smoke.spec.ts`): it is the packaging gate, and its signal is "the
packaged artifact boots and runs the core journeys." Feature tiers (Tier 2+,
e.g. `e2e/chat.spec.ts`) run in standalone mode in the `e2e` job — they grow
per area and would only inflate the image job's minutes without adding
packaging signal. The boundary follows the suite's structure: whatever
`smoke.spec.ts` certifies ships-checked in both modes; everything else is
standalone-only.

## Running locally

```bash
npm run test:e2e        # build + run (the CI path)
npm run test:e2e:local  # skip the build — reuse .next/standalone
npm run test:e2e:headed # visible browser for debugging
```

Docker must be running (the throwaway Postgres is a container). Ports 3990
(app) and 3999 (mock agent) are loopback-only; a stray `next-server` from a
previous run causes `EADDRINUSE` — `pkill -f next-server` clears it.

## Tier 2 — chat depth (built: `e2e/chat.spec.ts`, #101)

The first Tier 2 file: three tests over the same harness, growing chat
behaviors the Tier 1 round-trip can't reach. The smoke suite stays frozen at
its 8 tests.

| Test | Proves |
| --- | --- |
| conversation survives a reload | Send → reply → full reload → reopen from the sidebar; user message + reply render again. The conversation-history contract (threads API + `PostgresAgentRunner` + `/connect` replay) through the real cookie gate. Thread ids are not client-persisted, so the reload alone shows a fresh empty chat — reopening the sidebar thread IS the persistence assertion. |
| tool call renders in the bubble | The mock agent's `"use the tool"` trigger makes the run carry AG-UI tool-call events; the wildcard tool render (`components/tools/tool-renders.tsx`) shows the humanized name inside the assistant bubble, and expanding it renders args (key-value rows) + the result through the react-markdown path. |
| two exchanges stay ordered | Two send/reply cycles in one thread render in DOM order: user1, reply1, user2, reply2 (the second send waits for the run to finalize — the sidebar entry appearing — so it can't race the per-thread run lock). |

Notes:

- The tool render has no `data-testid` of its own — the spec asserts on the
  stable rendered text (humanized name, the Arguments/Result labels, the
  markdown heading), scoped inside `[data-testid="copilot-assistant-message"]`.
  A CopilotKit default fallback would render the raw tool name, so the
  humanized-name assertion is what pins the app's own renderer.
- Each spec file (and test) keeps to its own thread; unique first messages
  keep the shared seeded DB's sidebar listings unambiguous across the suite.

## Tier 2 — agent CRUD (built: `e2e/agents.spec.ts`, #102)

The second Tier 2 file: four tests driving the `/agents` surface — the
core operator workflow — end to end. This is the spec the
parallel-mutation rule (above) was written for: it creates, edits, and
deletes while the smoke and chat specs read the same DB concurrently.

| Test | Proves |
| --- | --- |
| an agent can be created through the add form | The add panel's "Connect an existing agent" form (name, description, endpoint, auth mode, JWT secret) POSTs to `/api/agents` and the row lands in the table with its endpoint. The endpoint is the mock agent on loopback — the SSRF guard runs on every create and passes because the harness sets `ALLOW_PRIVATE_ENDPOINTS=true`: the private-endpoint allowance is exercised on purpose. |
| editing with a blank secret preserves the stored secret | The write-only `jwtSecret` contract through the UI: the edit form opens with a BLANK secret field (the stored value is never echoed — GET responses carry `hasJwtSecret` instead), a blank submit PATCHes without the key, and the stored secret survives — asserted via the `hasJwtSecret`-driven "Key set ✓" hint still rendering on re-open plus the connection check succeeding after the save. |
| the form's Test connection probe reaches the mock agent | The form's Test connection button runs the real reachability-probe route (`POST /api/agents/reachability-probe`) against the typed endpoint. Nothing is submitted — the test creates no agent and cancels the panel. |
| deleting an agent removes it — and only it — from the list | The `confirm()`-guarded delete (the dialog copy must name its victim) removes the created agent; the seeded agent the smoke suite reads is still in the table. |

Notes:

- The write-only semantic is asserted without the secret ever appearing
  anywhere: the chain is (field blank on open) → (blank submit) →
  ("Key set ✓" persists on re-open — `hasJwtSecret` stayed true) →
  (connection check succeeding). The hint is the only UI surface of
  `hasJwtSecret`: a blank save that wiped the secret would flip it to
  the create-variant hint ("Shared HS256 secret …"), which is exactly
  what the assertion catches.
- The mock agent answers GET with 405 (it is POST-only), so the probe
  badge reads "✓ Server reachable (HTTP 405)" — the probe asserts
  reachability, not protocol compliance (`TEST_HELP` says the same in
  the UI).
- The row-level Test badge and the form-level badge are both covered:
  the edit test uses the row action (the issue's post-save connection
  check), this file's probe test the form button.
- The four tests run serially in one worker behind one real login —
  the auth budget (above): four more sign-ins per run would breach the
  10/min sign-in cap when the suite compresses into a minute on a fast
  machine. Serialization also makes the CRUD mutations never interleave
  with each other, on top of the create-own/mutate-own/delete-own rule.

## Tier 2 (not built)

Deeper journeys belong in new files, not grown into the smoke suite:
catalog install flow, builder flows, org/invitation management, billing.
Same harness (`web-server.mjs` lifecycle, helpers, seeding), more tests
per area — and every one of them that mutates data binds itself to the
parallel-mutation rule (above).

# E2E suite (Tier 1 smoke + Tier 2 depth)

The CI canary that proves the app actually runs: the built Next.js server
boots, every surface renders, and the two most important journeys (login,
chat) work end-to-end. Eight tests, one file (`e2e/smoke.spec.ts`), ~6s of
browser time. Deeper journeys live in sibling specs that reuse the same
harness — Tier 2 so far: `e2e/chat.spec.ts` (chat depth),
`e2e/agents.spec.ts` (agent CRUD), `e2e/orgs.spec.ts` (orgs &
invitations), `e2e/auth.spec.ts` (auth journeys — signup, email
verification, password reset), and `e2e/catalog.spec.ts` (catalog
install — the journey that closes the pure-app tier), below. Run
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
Since the auth-journeys spec (#107) the same shape covers the mail
transport: the app's email features are ON (a throwaway `RESEND_API_KEY`)
but the Resend SDK's `RESEND_BASE_URL` points at a **local catcher**
(`e2e/email-catcher.mjs`) — every email the app really sends (verification,
password reset, invitation) is delivered to the catcher through the app's
own `sendEmail` path, and the spec drives the real link it carries. Nothing
in the app is stubbed; only where the transport sends changed, exactly like
the mock agent for the model.

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
4. Start the local email catcher on loopback port 3998
   (`e2e/email-catcher.mjs` — POST `/emails` swallows the app's real
   sends, GET `/emails?to=` is how the auth spec picks mail up).
5. Copy `.next/static` into `.next/standalone/.next/static`, then start
   `node server.js` (port 3990, loopback) — or, in image mode, run the
   `E2E_APP_IMAGE` container (see below).
6. Poll `/api/health?deep=true` until ready, then stay alive until Playwright
   tears the stack down (it kills the whole process group — see below).

**Teardown is outsourced to a detached reaper.** Playwright kills the
webServer process group with a bare SIGKILL — no SIGTERM, no grace period —
so no in-process cleanup can run at shutdown (a SIGKILL'd process executes no
handlers). Instead, right after `docker run` the script spawns a tiny
detached watchdog (`sh` loop in its own session, invisible to the group kill)
that polls the harness pid and runs `docker rm -f` the moment the harness is
gone. Container removal also happens on the direct-signal paths (Ctrl-C,
normal exit), and every startup sweeps stale `tackui-e2e-*` containers —
see "The startup sweep is pid-liveness-gated" below for what that sweep
may and may not touch.

**Startup port pre-check.** Before anything boots, the harness probes its
three fixed ports — 3990 (app), 3998 (email catcher), 3999 (mock agent) —
with a real loopback bind (dependency-free; the Postgres port is picked
free at boot and not checked). An occupied port exits immediately with a
two-line message instead of the raw `EADDRINUSE` stack a dying child used
to produce:

```
[e2e-server] FATAL: port 3990 (app) is already in use by next-server (pid 41234) — the harness cannot start.
[e2e-server] Stop that process (kill <pid>, or pkill -f next-server for a leftover app) or move this run with E2E_APP_PORT=<port>, then re-run.
```

Holder identification (`ss -ltnp`, falling back to
`lsof -iTCP:<port> -sTCP:LISTEN -P -n`) is best-effort: without root, `ss`
hides other users' process names, and either tool may be missing — the
message then says "an unidentified process" and points at the manual
commands. The port env overrides (`E2E_APP_PORT`, `E2E_EMAIL_CATCHER_PORT`,
`E2E_MOCK_AGENT_PORT`) are honored in both the probe and the printed remedy.

### The startup sweep is pid-liveness-gated (one battery at a time)

The harness's DB and app containers are named after the pid of the harness
that created them (`tackui-e2e-pg-<pid>`, `tackui-e2e-app-<pid>`), and the
startup sweep removes a container **only when that pid is provably dead**
(`kill -0` semantics — `process.kill(pid, 0)` in the harness). This is the
concurrency story:

- **A stale container (crashed run) is still swept.** Its creating harness
  is gone, so the pid is dead and the next startup removes it.
- **A LIVE battery's container is never touched.** Starting a second
  battery while one runs used to `docker rm -f` the live run's DB container
  at sweep time — the app then logged `[pg] idle client error … Connection
  terminated unexpectedly` / `ECONNREFUSED`, and every subsequent test
  failed with connection errors or the 150s navigation timeout. Now the
  second harness leaves the first run's containers alone.
- **Two batteries at once still don't work.** The protection is against
  destruction, not contention: concurrent runs share the fixed ports (the
  pre-check above fails the second run fast), the seeded DB, and the
  port-pacer's login budget. **"One battery at a time" remains the rule** —
  the difference is that breaking it no longer kills the running battery;
  the second run just refuses to start.

Two residual edge cases, both in the safe direction (leftovers linger,
nothing live is destroyed): a container whose harness pid was recycled by
an unrelated process counts as alive and is skipped — remove it by hand
(`docker rm -f tackui-e2e-pg-<pid>`); and a name without an embedded pid
is never touched at all.

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
- **Second user** (`e2e-member@test.local`, #103) — created the same way
  (real signup + verified email via SQL) but left a plain user: no role
  update and no personal org — the app's session hook creates that on the
  member's first login, which is the journey `e2e/orgs.spec.ts` tests.
  Shared fixture like the admin: every spec treats both seeded users as
  read-only (the orgs spec logs into the member; nothing mutates either
  user's row).
- **Personal org + owner membership** — inserted directly for the admin,
  mimicking what `lib/auth/auth.ts`'s session hook does on first login.
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
| catalog renders | `/app/catalog` renders — header + the settled body, seeding-agnostic since #104: the empty state or template cards, whichever the shared DB holds. |
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
17 paced sign-ins, a fast machine compresses the whole run into ~60s and
the limiter's counter overflows — the last login wave 429s ("Too many
requests") and tests die in `login()`. Found exactly that way when the
agent-CRUD spec joined the suite (#102).

Three conventions keep the suite under the cap as Tier 2 grows:

- **A mutating Tier 2 file spends ONE login — or one per distinct
  user.** The file declares
  `test.describe.configure({ mode: "serial" })` — its tests run
  back-to-back in a single worker — and a `test.beforeAll` hook performs
  the one real login-page flow, keeping the session state in a
  module-level variable that each test's fresh context starts from.
  Cookies are the ones the real login issued (nothing is faked); each
  test still gets its own page, so console-error watching stays
  per-test. See `e2e/agents.spec.ts` — the read-only specs
  (smoke, chat depth) keep the per-test login because each is testing a
  fresh-session journey, not CRUD. The exception is `e2e/orgs.spec.ts`:
  a two-session journey by definition, it spends one login PER USER
  (admin + seeded member, both in `beforeAll`, both through the pacer —
  `helpers.ts` grew a parameterized `loginAs()` that shares the
  parameter-free `login()`'s pacer and 429 ride-out verbatim; the
  chat-input assertion stays in `login()` because a member with zero
  agents never sees it). The auth spec (#107) is the other shape: its
  journeys ARE login boundaries, so there is no `beforeAll` login at
  all — signup, verification, and the reset rotate credentials and
  issue sessions through the real forms — and its EXPECTED-REJECTION
  sign-ins (the unverified 403 gate, the old-password refusal after a
  reset) are paced through the same slot queue via `rejectedSignIn`,
  because a limiter charge is a limiter charge whether or not it
  succeeds.
- **`login()` never bursts the cap.** Playwright workers are separate OS
  processes with no shared lock, so sign-ins are paced through the
  filesystem: each login claims a slot on a 7s grid (`slot-<grid
  point>`, an atomic O_EXCL create in a shared temp dir — a losing
  claimant aims a full step later). The grid is what paces the opening
  wave: workers that all read the shared `last` file before any winner
  wrote it aim at the same grid point, so the create itself arbitrates
  — exactly one wins and the rest queue behind it, instead of each
  claiming a distinct "now + ε" slot and bursting. The winner
  reconciles `last` upward so late readers skip ahead, claims older
  than an hour are pruned, and anything but a lost race is rethrown (a
  broken pacer must fail loudly, not spin into the timeout). 60s
  window / 7s spacing ⇒ at most 9 sign-ins in any window — but "against
  the 10 cap" is not the guarantee it looks like: better-auth's in-memory
  limiter only RESETS its counter after a full quiet gap larger than the
  window (`now - lastRequest > windowInMs` in its `decideConsume`), not on
  a rolling schedule. A sustained 7s cadence never accumulates a 60s
  quiet gap, so the counter climbs monotonically across the whole run and
  the 11th login trips the 10 cap no matter how it is paced (verified
  against a live stack when the orgs spec added the second user, #103).
  The pacer still earns its keep — it keeps the opening wave orderly and
  makes any 429 a known, transient event instead of a burst overflow —
  but the hard ceiling is raised on the harness side instead (below).
  Without the pacer the retry below is
  self-defeating — each 429ed attempt also consumes limiter budget, so
  the tail can't out-wait a 60s window from inside a 60s test timeout.
- **`login()` rides out 429s anyway.** On the rate limiter's "Too many
  requests" banner it waits a jittered interval and retries (bounded) —
  the fallback for the genuinely transient (a concurrent run sharing
  the IP), not the primary defense. A broken login page is not
  transient, and the retry must not mask it: anything else surfaces as
  the original navigation timeout. Jitter keeps parallel workers from
  retrying in lockstep.

The pacer's queue is paid for in test time — 17 sign-ins at ≥7s spacing
puts the last slot up to ~112s out — so the Playwright test timeout is
150s, not 60s (bumped from 120s when the auth-journeys spec joined,
#107): the wait happens inside the test, and the queue is
suite-wide (every spec's logins draw from the same slots, so a test
joining the opening burst can queue ~105s regardless of which spec it
belongs to). Still a strict ceiling: a hung journey fails within two
and a half minutes.

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
loudest user; documented in `.env.example`). One contract covers every
env knob on this page, including the two below: the override works in
BOTH directions — any positive integer replaces the preset, tightening
as readily as relaxing — and only a positive integer passes the guard
(junk, zero, negative, fractional keep the preset), so a typo can't
disable a limit outright. Specs that need a table still carry the belt: the page's
own Retry button re-fetches, and `openAgents` (e2e/agents.spec.ts)
clicks it and waits for rows instead of failing on a transient
overflow — read-only specs keep their plain assertions, since their
failures under sustained overflow are real signals, not noise.

The mutation bucket needed the same relaxation when the catalog spec
joined (#104): `agentMutate` (10/min per user) is charged by agent CRUD
AND the catalog's template routes + install, so the combined run's
mutations land in the same window as ONE user — agents.spec's 7 (tests
1/2/4 each create+delete their own row, test 2 adds a PATCH) plus the
catalog lifecycle's 5 (seed, install, template edit, template delete,
tombstone delete) = 12 against the 10 preset (observed live: a 429ed
agent DELETE). The preset is now `AGENT_MUTATE_RATE_MAX`-overridable the
same way (default stays 10 in prod; the harness sets 60).

Two more budgets saturated the same way when the orgs spec doubled the
login count (#103), and the harness raises both the same way — app env
in `e2e/web-server.mjs`, prod defaults untouched:

- **The Better Auth sign-in cap** (10/min per IP, `lib/auth/auth.ts`
  `customRules` → `AUTH_SIGNIN_RATE_MAX=30` in the harness). With 17
  sign-ins in the six-file run, the gap-based reset above makes the
  counter climb for the entire ~112s login queue — no spacing fits under
  10. The knob gives headroom for further Tier 2 files without
  re-litigating the pacer's grid math every time one joins; sign-up
  stays at 5 and the auth spec (#107) spends it once — its journeys
  issue their own sessions rather than logging into fixtures.
- **The per-IP flood cap** (300/min on all `/api/*`, the proxy's
  `globalIp` preset → `GLOBAL_IP_RATE_MAX=1200` in the harness). A true
  fixed window, but the aggregate trips it: 4 parallel workers' page
  loads plus two live chat runs (connect/info requests, SSE frames,
  thread fetches) charge one IP's bucket several hundred times a
  minute. The failure shape was real app breakage, not a test error —
  an agent list 429ed into its error pane and a chat run never settled
  — which is exactly why this is a harness env, not a test-side retry.

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
(app), 3998 (email catcher) and 3999 (mock agent) are loopback-only; the
harness pre-checks all three at startup and names the offending process if
one is held (see "Startup port pre-check" above) — a stray `next-server`
from a previous run is the usual culprit, and `pkill -f next-server` clears
it. And run **one battery at a time**: a second harness no longer destroys
a running battery's containers (the sweep is pid-liveness-gated), but it
still can't share the ports or the seeded DB — see "The startup sweep is
pid-liveness-gated" above.

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

## Tier 2 — orgs & invitations (built: `e2e/orgs.spec.ts`, #103)

The third Tier 2 file and the first multi-user journey: everything before
it ran as the single seeded admin. The invite → accept handoff runs across
two isolated browser contexts (separate cookie jars — no session leakage)
against the real better-auth organization flow, and the assertions are the
org scoping memberships exist to provide.

| Test | Proves |
| --- | --- |
| the owner invites the member by email through the account menu | The seed admin's real invite dialog ("Invite member" — visible because the admin manages the org and the harness runs self-host, seats unlimited): a probe thread is created first (owner-side fixture for the isolation tests), a stale pending invitation from a retried earlier attempt is cancelled, the invite is sent to the seeded member's email, and the pending row (email + "Invited as member" + `pending` badge + cancel affordance) shows on `/app/members`. |
| before accepting, the member sees none of the owner's org | The member's first login creates their personal workspace via the app's session hook; on `/agents` the workspace agent is absent (org-scoped list, empty state renders) and the chat surface shows "No agents yet." with no trace of the owner's probe thread. The pending invitation surfaces through the app's own no-email discovery path: the account-menu badge ("Pending invitations 1"). |
| the member accepts the invitation and joins the owner's workspace | The real acceptance UI (`/app/invitations` → Accept → `authClient.organization.acceptInvitation` — the invitation id travels through the authenticated `listUserInvitations` response; nothing is stubbed or forged). After accepting, the pending list empties; the org switcher self-renders (the member now belongs to two workspaces) and switching hard-navigates into the owner's workspace — the workspace agent appears in `/agents` and the chat surface (org scoping with a real membership), the owner's probe thread does NOT (threads are scoped per user inside the org), and the member's own probe thread is created by a real chat run. |
| membership is visible to the owner; threads stay scoped to their creator | Back as the owner: the conversation list gains nothing from the member (owner's probe visible, member's probe absent — per-user scoping in both directions), and the members roster shows the joined member with the role the invitation carried ("member" badge) next to the "(you)" owner row; the invitation is no longer pending. |

Notes:

- **No email transport is faked — and since 2E, none is missing.** When
  this spec was built (#103) the harness set no mail provider, so
  better-auth's `sendInvitationEmail` stayed undefined — exactly the
  production-without-SMTP configuration — and the app's own no-email
  discovery path (pending-invitations badge → `/app/invitations` →
  Accept) was the journey under test; nothing was stubbed or forged.
  Since the auth-journeys spec (#107) the harness runs a local mail
  catcher (`RESEND_BASE_URL` → `e2e/email-catcher.mjs`), so an
  invitation email is now delivered to the catcher as well — the badge
  → accept path remains what this spec drives; the email is
  additional, not load-bearing.
- **Two real logins, one per user** (the auth budget exception, above):
  both happen in `beforeAll` through the shared pacer — `login()` for the
  admin and the new `loginAs()` for the member, which is the same paced
  body parameterized. `login()` keeps the chat-input assertion; the
  member's empty personal workspace renders "No agents yet." instead of
  the input, so `loginAs` asserts only the /app redirect and lets each
  user's first surface assert its own settled state.
- **Seeding grew a second user** (`e2e-member@test.local`, verified,
  plain role, no personal org pre-created) — same creation path as the
  admin (`auth.api.signUpEmail` + verified-email SQL). It is shared
  fixture: the orgs spec only ever logs into it; no spec mutates it.
- **No teardown.** Each run reseeds a fresh database, and the journey's
  artifacts are inert to other specs: the member's thread is invisible to
  the admin (per-user scoping — the very thing under test), the
  accepted invitation is no longer pending anywhere, and the membership
  only widens a roster nothing else reads. The invite test still
  cancel-owns a stale pending invitation before sending, so a CI retry
  cannot accumulate invites.

## Tier 2 — auth journeys (built: `e2e/auth.spec.ts`, #107)

The fourth Tier 2 file and the first to exercise the app's email-gated
surfaces: signup, email verification, and password reset — the journeys
Tier 1's login-only coverage deliberately left out. The unlock is the
local mail catcher (see "What's real, what's faked"): the app's email
features are fully ON (a throwaway `RESEND_API_KEY` flips
`lib/email`'s `EMAIL_ENABLED`, turning on `requireEmailVerification`
and the send callbacks — the production-with-SMTP configuration), and
the Resend SDK's `RESEND_BASE_URL` points delivery at
`e2e/email-catcher.mjs`. Every email goes through the app's real
`sendEmail` path; the spec picks up the real link from the catcher and
drives it through the real UI. No app stubbing, no token forging —
and, notably, no DB scraping: better-auth 1.6 stores nothing for the
verification token (it is a signed JWT handed only to the send
callback), which is what routed the DB-driven-link idea to the email
boundary, the artifact the user actually receives.

| Test | Proves |
| --- | --- |
| signup is gated on verification, and the emailed link activates the account | The real `/signup` form with a fresh random identity gets the check-your-email screen (no session at signup), a sign-in before verification meets the app's 403 panel (`rejectedSignIn` — the gate is enforced, and the pacing covers expected rejections), the resend button — `sendOnSignIn: false`'s recovery path — delivers a second, independently-tokened email through the real send path, the newest emailed link activates the account through better-auth's real verify endpoint (the no-error redirect render), and `loginAs` then issues the real session: the account menu names the unique address and the user's own personal workspace settles on the "No agents yet." empty state. |
| a tampered verification token cannot activate an account | A fabricated token on better-auth's real GET verify endpoint redirects with `?error=INVALID_TOKEN` to the app's failure render — the negative half of the verification journey, pinning that the verifier rejects instead of passing garbage through. No rows touched. |
| a password reset through the emailed link replaces the credential | The real forgot-password form (reached via the login page's `emailVerification`-gated link) requests the reset — its anti-enumeration confirmation renders regardless — and the emailed link's token is validated server-side against the verification row better-auth created at request time ("Set a new password" only renders when it did). The reset form sets the new password, and the replacement is asserted in BOTH directions: the old password stops working (paced rejected sign-in), the new one signs in through the real login page and opens the app. The target is the account this file's signup test created — never the seeded admin (the hard rule). |

Notes:

- **Identity generation is per-test-execution, not per-module-load.** A
  CI retry re-runs the signup test with a fresh random address —
  better-auth's duplicate-email response is deliberately identical to
  the fresh path, so a reused address could silently verify the FIRST
  attempt's account and make the retry lie about the gate. The reset
  journey receives the identity through module state; serial mode
  guarantees the handoff order.
- **The file spends no `beforeAll` login** — four paced sign-ins total
  (two `rejectedSignIn` gate checks, two `loginAs` real logins) plus
  one signup, all through the shared pacer (the auth budget, above).
  This is why the suite-wide timeout moved to 150s.
- **No teardown.** A fresh DB is seeded per run; the leftovers (one
  personal workspace per attempt, its verification rows, the catcher's
  in-memory spool) are read by nobody, and the smoke suite's /admin
  assertion is a render, not a user census.

## Tier 2 — catalog install (built: `e2e/catalog.spec.ts`, #104)

The fifth Tier 2 file and the journey that closes the pure-app tier: the
catalog — the monetization surface (docs/catalog.md: templates vs.
installed copies, live propagation, tombstones) the smoke suite could
only read empty — driven through its full documented lifecycle. The
template is seeded through the documented admin capability (the real
`POST /api/catalog` route — the same wire path the `/admin` Catalog
section drives, auth + SSRF guard included; the issue scopes seeding to
the store/API so the template's lifecycle stays inside this file, not a
`seed.mjs` fixture). Everything after that is UI.

| Test | Proves |
| --- | --- |
| a published template installs into the workspace through the real catalog card | The `/app/catalog` card (name + tagline) installs through the real one-click affordance — POST `/api/catalog/[id]/install`, `canManageAgents`-gated — flips to "✓ Added to workspace", and the installed copy lands in `/agents` as a MANAGED row: the "Catalog" chip, the endpoint cell reading "Managed by catalog" (the curator's URL never leaves the server — `GET /api/agents` strips it), and the fully-locked action set (no Edit, no Test; Remove only). |
| the installed copy follows the template — pointing it at the mock agent passes the connection check | A managed copy has no endpoint of its own (it is an entitlement, not a config copy — docs/catalog.md): "pointing the installed copy" happens by editing the TEMPLATE's endpoint through the real `/admin` form, and the connection check is the admin row's Test button — the real reachability probe route 2B drives. The template is born pointing at a dead loopback port, so the check is driven RED first ("✗ Cannot reach server: unreachable") and only goes green ("✓ Server reachable (HTTP 405)") once the edit lands — the probe isn't vacuous, and the managed row in `/agents` still exposes no endpoint after the edit (live propagation, no copy). |
| deleting the template tombstones the installed copy — the workspace removes it from there | The admin delete confirm carries the documented blast-radius warning ("1 workspace has installed it — their installed copies will be removed from those workspaces (past chats stay viewable)"). After deletion the installed copy STAYS in `/agents` — the tombstone: rows survive so past conversations remain viewable, "Removed" chip, still endpoint-less and locked to Remove-only — and the workspace cleans it up via the normal Remove (its own agent DELETE), leaving the seeded agent untouched. |

Notes:

- **The dead endpoint is deliberate.** The template is born pointing at
  a loopback port the harness runs nothing on, so "installed ≠ broken"
  has to be earned: the connection check fails until the template is
  pointed at the mock agent, then passes. The mock agent's plain path is
  untouched — the template's install/run never goes through it; only the
  reachability probe does (a GET, answered 405).
- **The mutation budget grew a knob** (see "The auth budget" above):
  joining this file put the combined run's `agentMutate` charges past
  the 10/min preset — agents.spec's 7 (tests 1/2/4 each create+delete
  their own row, test 2 adds a PATCH) plus this file's 5 (seed, install,
  template edit, template delete, tombstone delete) = 12 — and a delete
  429ed live; the preset is now `AGENT_MUTATE_RATE_MAX`-overridable
  (harness: 60, prod default untouched).
- **Dialog confirms are awaited as events** (`page.waitForEvent`),
  not asserted from a `once`-listener's side effect: `await click()`
  resolves when the input was dispatched, before the renderer's
  `confirm()` has necessarily emitted the dialog event — a same-tick
  assert raced it under full-suite load and read `null`.
- **One real login** (`beforeAll`, the auth budget) — the three serial
  tests share the session state like the agent-CRUD file. The file spends
  one sign-in total.
- **Parallel mutation with a sweep.** The template + installed copy carry
  a unique name prefix per test execution, and `beforeAll` deletes any
  leftovers from a crashed earlier attempt (an ACTIVE leftover template
  would otherwise render a second card on `/app/catalog` and make the
  install test's card-scoped locators ambiguous). The one real install
  lands in the shared org, but no other spec asserts on agent-list
  counts, and the file ends with both its rows deleted (asserted).
- **No teardown beyond that** — a fresh DB is seeded per run; what a
  mid-test crash leaves behind is inert (a tombstoned or orphaned row
  under a unique name) and swept at the next attempt.

## Tier 2 (not built)

Deeper journeys belong in new files, not grown into the smoke suite —
and with catalog install landed (#104) the **pure-app tier is closed**:
what's left doesn't fit this harness. Billing flows are Stripe-driven —
their enforcement logic belongs in the vitest tier, where the Stripe
boundary is mockable (a browser e2e can only reach the marketing
shells, not the subscription state machine). Builder flows need an
AGENTOS harness — the builder is its own Python service with per-run
dependency delivery, a second live backend the e2e stack doesn't run.
Same harness (`web-server.mjs` lifecycle, helpers, seeding), more tests
per area — and every one of them that mutates data binds itself to the
parallel-mutation rule (above).

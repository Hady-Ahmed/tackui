# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Reconnect replay no longer replays post-terminal strays or dangling
  sequences (#67).** A backend that records events after its `RUN_FINISHED`
  (duplicate terminators, trailing traffic) poisoned reconnect replay — the
  AG-UI verifier rejects every event but `RUN_STARTED` after a terminal, so
  the whole history was refused. Replay now stops at each run's first
  surviving terminal event while keeping the next run's own `RUN_STARTED`.
  Errored runs also close what they left open: a synthetic terminator now
  closes open `REASONING_*` sequences (`REASONING_MESSAGE_END` per open
  message, then `REASONING_END` per block) alongside the existing
  message/tool-call closures, so reconnects no longer show permanently
  spinning reasoning blocks or tool calls.
- **A client-supplied run id reused on a different thread no longer drops
  the run from history (#65).** The event log's `run_id` column carried a
  global unique constraint, so a client that legitimately supplies its own
  run ids and reuses one on another thread hit a uniqueness violation at
  persist — the run streamed fine but was silently missing from history on
  reconnect. Uniqueness is now scoped per thread (`(thread_id, run_id)`,
  migration 0016): the same run id may appear on different threads, while a
  duplicate within one thread is still rejected as before. Strictly weaker
  than the old constraint, so no existing data can violate the new index.
- **Deleting a thread no longer races a starting run into resurrecting it
  (#65).** Deleting a thread while a run on it was starting could leave the
  run persisting rows for the deleted thread afterwards — the thread
  reappeared in the sidebar holding only that run's data, orphaning rows
  against a deleted id. Deletions now record a tombstone in the same
  transaction (migration 0017, new `deleted_threads` table): runs on a
  tombstoned thread are refused at start, and an in-flight run's final
  persistence skips writing, so a deleted thread stays deleted. Tombstones
  older than 30 days are pruned on each delete.
- **Non-http(s) connector URLs are now rejected at submit with a clear
  400 (#72).** `PUT /api/connectors` accepted any URL scheme and stored
  it, failing only later — as the store's generic validation 400 or, once
  the platform fetched the endpoint at run time, as a 502. The
  http(s)-only rule now fires at the input boundary with the reason named
  in the validation error. The SSRF guard's behavior is unchanged.
- **A lost catalog-install race now answers 409 (retry) instead of a
  server error (#72).** Two simultaneous installs of the same template
  are arbitrated by a unique index and the loser re-syncs the winner's
  copy; in a rare visibility window that fallback could find no winner
  and fail with a bare 500. The fallback now retries the winner lookup
  once and, if the winner's row is still invisible, returns 409 —
  retrying completes the install through the normal re-sync path.
- **Concurrent template edits can no longer silently lose a just-saved
  secret (#127).** Two admins editing the same catalog template at the
  same instant raced last-write-wins: a rename racing a secret re-save
  could land with the rename intact and the brand-new secret destroyed
  (the rename carried back the stale secret bytes it read before the
  other save). Template updates now serialize on a row lock — the
  second edit merges over the first's committed state, so both land.
- **Undecryptable secrets can no longer be erased by unrelated edits, and
  concurrent credential rotations can no longer silently drop each other
  (#70).** Three secret-handling edges tightened. (1) `updateTemplate`
  used to write NULL over an UNDECRYPTABLE stored `jwt_secret` (a key
  rotation or backup mismatch reads as secret-less through the
  graceful-degrade read path), so an unrelated edit — a rename —
  destroyed the stored ciphertext, unrecoverable even after the
  encryption key is restored. A patch that supplies no new secret now
  preserves the raw stored bytes byte-for-byte; entering a fresh secret
  remains the recovery path. (2) The credentials PUT read-merge-write is
  serialized: it runs in one transaction holding the provider row's
  `SELECT … FOR UPDATE` lock, so two concurrent single-field rotations
  of a multi-field toolkit both survive instead of the last whole-map
  write silently erasing the others (proven against real Postgres with
  a four-way concurrent-rotation test). (3) The route's body bounds gain
  regression coverage: a >500-char field value or >64-char provider is a
  400 (nothing stored), a multi-MB malformed or schema-failing body is a
  400 — never an unhandled 500 — and a pathological DELETE path is a
  clean 404.
- **Short `X-Forwarded-For` headers no longer mint spoofable rate-limit
  buckets (#68).** When the header carries FEWER entries than
  `TRUSTED_PROXY_HOPS`, the IP resolver used to clamp to its LEFTMOST
  entry — on a misconfigured deployment (hop count set higher than the
  real proxy chain) that entry is client-suppliable, so a client could
  rotate a fresh bucket per request through every IP-keyed limiter (the
  global flood cap, the deep health probe, Better Auth's sign-in
  limiter). Short headers now fail closed to the shared `unknown` bucket:
  all such requests mutually throttle instead, and the fix for the
  operator is correcting the env var. Headers carrying exactly enough
  hops — and the default single-hop self-host topology — still resolve
  exactly as before. The same change completes the rate-limit docs: every
  per-user route limit is now enumerated in `docs/security.md` and the
  README (the admin-platform and catalog rows were missing), and the
  install / connector-delete route families gain the route-level 429
  tests the other families already had, alongside a new `client-ip`
  resolver test file covering the spoof attempt itself.
- **Fresh workspaces no longer log a console error on every page load
  (#74).** `getAgents()` used to throw when an org had zero agents, so the
  CopilotKit runtime answered `GET /api/copilotkit/info` with a 500 and the
  browser logged `runtime_info_fetch_failed` on every page load of a brand-
  new workspace — a completely normal state. An empty workspace now resolves
  to an empty registry: `/info` returns 200 with no agents (the existing
  "No agents yet" empty state renders with a clean console), unauthenticated
  callers still error, and runs against unknown agent ids fail closed with
  the runtime's 404. The two e2e console-noise filters that existed solely
  to swallow `runtime_info_fetch_failed` are deleted with it — the error
  source no longer exists, so they'd only mask a future /info regression.
- **`clearThreads()` is a deliberate no-op (#99).** The runner's
  interface-required clear method used to fire-and-forget an unscoped
  DELETE across all four persistence tables — unreachable today (the
  copilotkit route 403s the demo's `POST /threads/clear`), but capable
  of erasing a live run's `run_state` lock row if it ever ran mid-run
  (interleaved history + unstoppable stop). The method now does nothing
  by design; a real "clear everything" feature needs deliberate scoping,
  auth, and live-run handling.
- **The disabled-builder banner renders its message once (#81).** With
  `AGENTOS_BASE_URL` unset, both catalog loads fail with the identical
  `AgentosError` message, and the builder form joined the two error slots
  verbatim — the same sentence twice, dot-separated. The join now dedupes
  (`catalogErrorCopy`, alongside the form's other pure copy helpers):
  identical messages collapse to one, while genuinely distinct failures
  (one catalog 503, the other 502) still both display.
- **The admin model Test-button tooltip names where the key goes (#84).**
  The `env_key_set: false` hint read "Set `OPENAI_API_KEY` on the platform
  to test this model" — "on the platform" could mean the Next.js app, the
  builder, or the host, leaving the operator to guess. The tooltip now
  names the destination: "in the agent builder service's environment"
  (matching the service name as `docs/agent-builder.md` uses it). Copy
  only — the probe, its gating, and the `env_key_set` logic are untouched.
- **Models & tools: a provider's enabled state is derived from its model
  ids (#83).** The provider checkbox and the model-id list read as two
  inputs but were one fact — two save-time guards enforced the same
  diagonal ("provider 'X' is disabled — its model ids were ignored" when
  ids sat under an unticked provider; a blocked save when a ticked
  provider listed none), so operators could construct both forbidden
  states and then get scolded at save time. The checkbox is now a
  non-interactive status indicator — a filled dot plus the model count
  when ids exist, a hollow "○ off" when none do (the shape and the text
  carry the state, not just color) — and enablement follows the rows:
  adding the first id lights the provider, removing the last dims it,
  and a new "Clear all" button (shown only when ids exist, no
  confirmation — nothing persists until Save) empties saved and
  uncommitted rows in one go. The PUT body derives `enabled` from the id
  rows, so neither error state can be constructed from this UI anymore,
  let alone sent; the backend guards remain as defense-in-depth. A dead
  ("No longer available") provider keeps its clear path — its panel
  opens read-only with Clear all, and saving sends `enabled: false`,
  exactly as unticking used to. Toolkits are unchanged: their checkbox
  is a genuine independent choice.
- **Agent builder tool palette: readable rows, palette search, honest
  tool cap.** Palette rows were a single flex line where the key badge
  crushed both the tool name ("Gen…") and the description into
  unreadable slivers with no way to expand; they're now two-line rows —
  full name + badge on the first line, the description clamped at two
  lines with a "Show more / Show less" toggle (rendered only when the
  text overflows) beneath, and a blue border on checked rows (the
  platform-admin ToolRow language). The palette gains a search input
  (case-insensitive on label + description, with a "No tools match"
  state — filtering is display-only, so hidden selections keep their
  payload slot), the cap hint counts live ("3 of 10 selected"), and at
  the cap unchecked rows disable with an explanatory title instead of
  the click silently no-op'ing. Rows render in a deterministic
  (toolkit, label) order instead of the upstream allowlist's append
  order. See #106.
- **E2E Tier 2D — catalog install** (`e2e/catalog.spec.ts`): the full
  documented catalog lifecycle (docs/catalog.md) driven through the real
  UI — the journey that closes the pure-app Tier 2 ladder. A template is
  seeded through the real admin catalog route (`POST /api/catalog`, the
  wire path the `/admin` Catalog section drives — auth + SSRF guard
  included), installed through the real `/app/catalog` card ("Add to
  workspace" → "✓ Added to workspace"), lands in `/agents` as a managed
  row (Catalog chip, "Managed by catalog", no Edit/Test — Remove only),
  is pointed at the mock agent by editing the TEMPLATE (the managed copy
  is an entitlement, not a config copy — live propagation), passes the
  real connection check via the admin row probe (driven red first
  against a dead endpoint, so green is earned), and the template's
  deletion tombstones the installed copy — "Removed" chip, still
  endpoint-less, the blast-radius warning in the delete confirm — before
  the workspace cleans the tombstone up via Remove. Joining the file
  overflowed the shared `agentMutate` bucket the same one-user way — 12
  combined charges (agents.spec's 7 plus this file's seed/install/
  template edit/template delete/tombstone delete) against the 10/min
  prod preset, a live 429ed DELETE — so the preset becomes a boot-time
  env override (`AGENT_MUTATE_RATE_MAX`, same positive-integer contract
  as the other rate knobs); prod default untouched, the harness sets
  60. Tier 1's catalog smoke assertion is now seeding-agnostic (the
  suite can no longer assume an empty catalog); the suite stands at 17
  paced sign-ins. See #104 and `docs/e2e.md`.
- **E2E Tier 2E — auth journeys** (`e2e/auth.spec.ts`): signup, email
  verification, and password reset driven end-to-end through the real
  forms and better-auth's real endpoints — the pure-app journeys Tier 1's
  login-only coverage left out. The harness now runs the app with email
  features ON (a throwaway `RESEND_API_KEY` flips `lib/email`'s
  `EMAIL_ENABLED`, turning on `requireEmailVerification` and the send
  callbacks — the production-with-SMTP configuration) while pointing the
  Resend SDK's `RESEND_BASE_URL` env at a new local mail catcher
  (`e2e/email-catcher.mjs`, loopback port 3998, started by the harness
  like the mock agent): every email the app really sends lands there and
  the spec drives the real link each carries — signup gated on
  verification (no session until the emailed link activates the account,
  the 403 panel on early sign-in, the resend recovery path), a tampered
  token rejected by the real verifier, and a password reset asserted in
  both directions (old password stops working, new one signs in). The
  reset target is the test-created account only — the seeded admin's
  password is never touched. `helpers.ts` grows `rejectedSignIn` (a paced
  expected-rejection sign-in — a limiter charge is a charge whether or
  not it succeeds), taking the suite to 16 paced sign-ins and the
  Playwright timeout to 150s. See #107 and `docs/e2e.md`.

- **E2E Tier 2C — orgs, invitations, member visibility** (`e2e/orgs.spec.ts`,
  the first multi-user Tier 2 spec): the real invite → accept handoff
  driven across two isolated browser contexts — the seed admin invites the
  new seeded second user (`e2e-member@test.local`, created by `e2e/seed.mjs`
  through the same `auth.api.signUpEmail` + verified-email path as the
  admin, but a plain user) through the real invite dialog, the member
  discovers the pending invitation via the account-menu badge, accepts it
  through the real `/app/invitations` acceptance UI, and switches into the
  owner's workspace with the org switcher. No mail provider runs in the
  harness (better-auth's `sendInvitationEmail` stays undefined, as in
  production without SMTP) — the app's own no-email discovery path is what
  is exercised; nothing is stubbed and no membership is forged. Org scoping
  is asserted in both directions: before accepting, the member sees none of
  the owner's org (no workspace agent on /agents, no probe thread in the
  chat surface); after joining, the workspace agent appears but threads
  stay scoped to their creator (the owner's probe thread is invisible to
  the member and vice versa), and the members roster shows the joined
  member with the role the invitation carried. The suite now spends two
  real logins per run for this file (one per user, both through the shared
  sign-in pacer — `helpers.ts` grows a parameterized `loginAs` that keeps
  the pacer and the 429 ride-out verbatim). The doubled login count (and
  the 4-worker suite's aggregate /api traffic) overflowed two rate-limit
  buckets that pacing alone cannot fit under: Better Auth's 10/min sign-in
  cap — its counter only resets after a full quiet gap larger than the
  window, so sustained sub-rate logins accumulate until they trip — and
  the proxy's 300/min per-IP flood cap. Both become boot-time env
  overrides (`AUTH_SIGNIN_RATE_MAX`, `GLOBAL_IP_RATE_MAX`, same positive-
  integer contract as the existing `AGENT_READ_RATE_MAX`); prod defaults
  are untouched and the harness raises only these two. See #103,
  `docs/e2e.md`, and `docs/security.md`.
- **E2E Tier 2B — agent CRUD** (`e2e/agents.spec.ts`, new Tier 2 spec along
  the frozen smoke suite): the core operator workflow driven end-to-end
  through the real `/agents` UI — create a custom-endpoint agent aimed at
  the mock agent (the SSRF guard's private-endpoint allowance exercised on
  purpose via the harness's `ALLOW_PRIVATE_ENDPOINTS=true`), the write-only
  `jwtSecret` semantic (the edit form opens blank — the secret is never
  echoed; a blank submit preserves the stored secret, asserted via the
  `hasJwtSecret`-driven "Key set ✓" hint surviving a re-open plus the
  connection check succeeding after save), the real reachability probe
  (form button and row action), and the confirm-guarded delete scoped to
  the test's own agent. `docs/e2e.md` gains two rules the joining spec
  forced into the open: the parallel-mutation rule (`fullyParallel`
  workers share one seeded DB, so mutating specs create-own /
  mutate-own / delete-own — the seeded fixtures are read-only to every
  test) and the auth budget: better-auth caps sign-in at 10/min per IP,
  so a mutating Tier 2 file spends ONE real login (serial mode plus a
  single `test.beforeAll` login shared through module-level session
  state), cross-worker sign-in pacing (filesystem slot claims on a 7s
  grid — spaced ≥ 7s apart from the opening wave on) keeps every login
  under the limiter's 10/min cap with a bounded 429 retry as the
  fallback, and
  the test timeout rises to 120s to absorb the paced tail. The ten
  routes charging the `agentRead` bucket put the full run's read demand
  right at its 60/min cap, so that limit gains an operator-facing env
  override (`AGENT_READ_RATE_MAX`, positive integers only; `lib/ratelimit/
  limits.ts`) and the harness sets 600 — same relaxation shape as
  `ALLOW_PRIVATE_ENDPOINTS` — while specs needing a table click the
  pages' own Retry pane on transient overflows. See #102 and
  `docs/e2e.md`.

- **E2E Tier 2A — chat depth** (`e2e/chat.spec.ts`, new alongside the frozen
  8-test smoke suite): thread persistence across a real reload (send → reply
  → reload → reopen the conversation from the sidebar, exercising the
  threads API + `PostgresAgentRunner` + `/connect` replay through the cookie
  gate), AG-UI tool-call rendering (the mock agent gains a `"use the tool"`
  trigger branch that emits `TOOL_CALL_*` events — the plain-reply path stays
  byte-identical — asserted through the wildcard tool render's expanded
  args/result panel), and multi-turn ordering (two exchanges in DOM order in
  one thread). The CI `image` job's Playwright step is scoped to
  `e2e/smoke.spec.ts`: it stays the packaging gate (Tier 1 only); feature
  tiers run in standalone mode in the `e2e` job. See #101 and `docs/e2e.md`.

- **CI packaging gate (`image` job): every PR boots the shipped container.**
  The e2e job certifies the standalone `server.js` under the CI runner's
  Node 24 (Ubuntu/glibc); the new `image` job certifies the `node:24-alpine`
  image itself — the one environment where musl libc can change native addon
  resolution (`sharp`/libvips). The job builds the image the PR ships, boots
  it against a throwaway `postgres:16-alpine` on a docker network (the same
  plain-`docker run` pattern as the e2e harness), and requires a green
  `/api/health?deep=true` (`ok`, `db`, migration count — response shape, not
  a hard count). Makes the 2026-11-08 one-off Node 24 container certification
  repeatable. See #96.

- **Smoke suite can run against the containerized app (`E2E_APP_IMAGE`).**
  `e2e/web-server.mjs` gains an image mode: setting `E2E_APP_IMAGE=<tag>`
  swaps the app-under-test from the local standalone build to that
  container — same Postgres, seed, mock agent, and eight tests, one shared
  runtime env block so the two modes can't drift. The container runs with
  `--network host` so the loopback-only mock agent stays loopback-only and
  the seeded URLs are unchanged. Wired as the second half of the CI `image`
  job. See #96.

- **Shipped runtime on Node 24 (current LTS since Oct 2025; Node 20 EOL'd
  April 2026).** The Dockerfile moves `node:20-alpine` → `node:24-alpine`,
  the `engines` floor moves to `>=24`, and the remaining CI jobs (`lint`,
  `typecheck`, `e2e`) converge on 24 — the whole battery now matches what
  ships. The e2e Postgres harness keeps plain `docker run`: the original
  swap was a Node-20 workaround (#90), but a dependency-free supervisor
  that survives Playwright's bare-SIGKILL teardown is a permanent property,
  not a version workaround. See #91.

- **CI test tier on Node 24 + fail-loud real-Postgres probe.** The vitest
  real-Postgres tests (testcontainers) were silently skipping on CI: the
  availability probe labeled a Node-20 library crash (nested undici needs
  Node ≥ 22) as "Docker unavailable", so the job ran green with zero
  real-Postgres coverage. The `test` job now runs Node 24, and the probe
  distinguishes genuine Docker-unavailability (skip locally) from any other
  failure (throw — red on CI). See #90.

- **Tier 1 E2E smoke suite** (`npm run test:e2e`, new `e2e` CI job):
  8 Playwright tests run the real built app — the standalone `server.js`
  build against a throwaway Postgres container, real better-auth sessions,
  and a mock AG-UI agent standing in for the model. Covers boot (login page,
  deep health probe), the login journey (session persists across reload),
  the chat run path end-to-end, and every surface rendering with a clean
  console. Verified to fail when the app breaks (breakage test). See
  `docs/e2e.md`.

- **The landing page now sells the whole product, not just the protocol.**
  The hero leads with an outcome ("Your own AI agents — built, installed,
  or connected") instead of AG-UI jargon; a "three ways to get an agent"
  section (build in the no-code builder / install from the catalog /
  connect your own AG-UI backend) replaces the connect-endpoint-first
  how-it-works; an agent-builder spotlight section (rendered when
  `AGENTOS_ENABLED`), a catalog spotlight with an illustrative template
  mockup, and a consolidated "for developers" section give each of the
  three paths a full section and move the protocol, self-host, and
  bring-your-own-backend content low on the page. SEO metadata and the
  OG/Twitter card copy follow the same structure.

- **The agent-builder service now lives in this repo** (`agent-builder/`
  at the root), moved out of the agent-warehouse monorepo where it sat
  beside unrelated projects. Location-only move — no functional change.
  Its Python tests run in CI via a path-filtered workflow
  (`ci-python.yml`), and the service's dependency pins carry over the
  exact versions the warehouse lock had tested (the `agents_shared.auth`
  module it used is vendored into the folder).

- **The Docker compose stacks now include the agent builder.** Both
  `docker-compose.yml` and `docker-compose.dev.yml` gain a `db-builder`
  Postgres (own volume, distinct user/db) and an `agent-builder` service —
  both network-internal with no published ports, so the app stays the
  sole host-facing interface. The app's `AGENTOS_BASE_URL` defaults to
  the compose service (`http://agent-builder:7778`), the shared
  `AGENTOS_JWT_SECRET` feeds the builder's `JWT_SECRET`, and the builder
  exposes `AGENTOS_DB_PASSWORD` / `AGENTOS_SENTRY_DSN` as compose-only
  variables. A new `agent-builder/.dockerignore` keeps the host's
  `.venv` out of the image build context (it previously clobbered the
  venv baked by the Dockerfile) and keeps `.env` secrets out of images.

- **CopilotKit runtime telemetry is opt-out by default for new setups.**
  `.env.example` now ships `COPILOTKIT_TELEMETRY_DISABLED=true` (the
  runtime's anonymous usage telemetry is on by default; `DO_NOT_TRACK=1`
  works too), so configurations copied from the example start
  telemetry-off. Existing deployments are unaffected. Documented in the
  README env table.

- **Boot no longer spams an Edge-Runtime `process.exit` warning.** The
  fail-fast helper moved from `instrumentation.ts` into its own Node-only
  module (`lib/db/fail-fast.ts`) behind a dynamic import: instrumentation
  is compiled for the Edge runtime too, and the Edge compiler rejects
  Node-only APIs it can see even when a `NEXT_RUNTIME` guard prevents them
  from ever running. Boot behavior is unchanged.

- **Replay history is verifier-safe without lying about failures.** The
  connect() replay filters persisted `RUN_ERROR` events (the AG-UI verifier
  locks on them mid-stream, making failed-run threads permanently unreadable
  on reconnect) — but a run left without a terminal event previously got a
  synthetic `RUN_FINISHED` unconditionally, which violated the AG-UI rule
  against synthesizing terminators for truncated streams and re-presented
  the failed run as a completed turn, with the errored run's message and
  tool-call sequences left open under a "finished" run (permanently-spinning
  tool calls on reconnect). The synthesis is now conditional and properly
  closed: a synthetic `RUN_FINISHED` is appended ONLY when a later
  `RUN_STARTED` would otherwise follow in the same verified stream — a
  later run's start already in the history (the verifier-unlock case), or
  a live bridge about to append an in-flight run's events (whose first
  event is its RUN_STARTED) to the same stream — and any open message or
  tool-call sequence is closed first with an error-flavored tool result.
  A run unterminated at the END of the history with no bridge following
  stays unresolved — the spec makes resolving a truncated final run the
  consumer's business.
- **Deleting a thread mid-run can no longer resurrect it.** A thread deleted
  from the sidebar while its run was still streaming came back on run
  completion: the finishing run's persistence re-inserted the run/message/
  metadata rows and re-seeded the sidebar cache — for a FIRST in-flight run
  the delete even reported success-as-failure (no rows existed yet to
  delete, so the cache entry survived too). The delete now always clears the
  thread's caches and marks the in-flight run; the run's persistence window
  (storeRun + captureThreadData) skips writes for the marked thread and the
  marker dies with the connection at teardown.
- **A transient DB failure during a run's lock release no longer wedges the
  thread forever.** The release in end-of-run cleanup is best-effort; when
  it failed, the thread's run_state stayed `is_running` with no runtime
  recovery — every subsequent run was refused with "Thread already running"
  until the next process restart. Run acquisition now detects the stale
  lock (a `current_run_id` with no live in-process connection, aged past a
  grace window so a just-acquired lock in a concurrent race is never
  mistaken for an orphan) and steals it, logging loudly.
- **Connect-vs-completion race no longer regresses the event cache.** A run
  committing while a connect()'s history read was in flight could be
  clobbered: connect's read-through write (from the older snapshot) landed
  after the run's cache merge, regressing the sync readers to pre-run
  history until the next write on the thread. The read-through write is now
  skipped when the cache already holds a run the snapshot doesn't.
- **Run-shaped paths are classified as runs first.** A POST to
  `/agent/<id>/run/connect` used to match the control-path substring check
  and skip the per-user run limit and concurrent cap; run attribution now
  wins over the control-path check, so a run-shaped path that doesn't parse
  (trailing segments, undecodable agent id) fails closed with a 404 instead
  of being treated as exempt control traffic, and the `threads/clear` guard
  is decode- and trailing-slash-tolerant (`%63lear` and a trailing slash can
  no longer smuggle past it).
- **Concurrent catalog installs can no longer create duplicate agents.**
  Two installs of the same template landing at the same moment could
  both pass the existence check and insert duplicate installed-agent
  rows for the same org. A partial unique index (migration 0015) makes
  the duplicate insert fail with a unique violation, which the installer
  now catches and treats as "already installed" — the first install wins
  and both callers end up with the same single agent. The (rarer)
  agent-count-cap overshoot under concurrent different-template installs
  remains a check-then-act window; it is accepted and documented in
  docs/catalog.md.
- **Completed runs now refresh the thread event cache.** The runner's
  sync event/state readers (CopilotKit's runtime exposes them as
  `/threads/:id/events` and `/threads/:id/state`) only ever saw the
  history as of the last `connect()` — a finished run wasn't merged in,
  so those reads served pre-run history until the thread was reconnected.
  Persisting a run now merges its (redacted) events into the cache, with
  the same RUN_ERROR filter the replay path applies. The shipped chat UI
  wasn't affected (it replays via `connect`); the fix closes the gap for
  the HTTP surface and external tooling.
- **Boot fails fast when migrations can't apply; `/api/health?deep=true`
  reports readiness (security audit, Phase F).** Previously a migration
  failure after the retry window was only logged — the server booted and
  served 500s while liveness probes stayed green, so orchestrators kept a
  permanently-broken container running. Boot now exits non-zero when the
  migrations or auth tables can't be brought up (the run-state reset stays
  non-fatal — it strands threads as "already running", it doesn't break
  requests). The readiness probe (`?deep=true`) round-trips Postgres and
  counts the applied migrations, returning 503 with a generic error when
  the DB is unreachable — for orchestrator readiness gates and
  post-deploy smoke checks. The plain probe is unchanged liveness. The
  deep probe is itself rate-limited to 30/min per client IP and answers
  429 beyond that, so it can't be turned into a free Postgres oracle.
- **Credentials/template hardening + billing/org rate limits (security
  audit, Phase C).** Four closes: (1) a credentials UPDATE now intersects
  the stored row with the provider's current contract before merging, so
  fields the catalog no longer declares (stale rows, catalog changes) can't
  ride along into new writes — and dropping them can surface a genuinely
  incomplete map, which is rejected rather than half-saved; (2) a template
  re-sync whose stored `jwt_secret` is undecryptable no longer nulls the
  installed agent's previously-synced working secret (the COALESCE keeps
  the row's fallback auth intact); (3) the Stripe checkout/portal routes
  get a per-user `billingMutate` limit (10/min — each call creates an
  outbound Stripe session) and the subscription/org reads share an
  `accountRead` limit (60/min); (4) the API-keys page no longer offers a
  second form for a provider that already has a saved key — the saved row
  (with an "Incomplete" flag when the contract grew) is the one place to
  rotate or complete it. Also: `docker-compose.yml` now passes
  `DB_ENCRYPTION_KEY` and the `AGENTOS_*` builder vars through, and
  `.env.example` documents the SaaS-mode/Stripe variables.
- **Runner can no longer deadlock a thread (security audit, Phase B).** A
  pre-run DB failure (history read / parent-run resolution) previously
  escaped the error handling: `is_running` stayed true forever (the thread
  became permanently unrunnable) and the SSE subjects never completed (the
  client hung). Every exit path now runs through a shared teardown that
  releases the run lock only while this run still owns it and removes the
  connection entry only while it's still this run's object — so an aborted
  run's teardown can no longer clobber a replacement run's lock or stop
  button. The running check is now a single atomic conditional upsert
  (two concurrent runs can no longer both pass the "not running" check), a
  mid-run persistence failure can no longer skip the rest of the teardown,
  and stale `is_running = true` rows are reset at boot, so a crash no longer
  leaves threads permanently "already running".
- **Builder connector requirements are id-snapshotted; undecryptable
  connector tokens now 402.** The requirements snapshot stores connector
  refs as `{id, name}` instead of bare names: a connector that is deleted
  and re-created keeps its name but gets a new id, so the run gate now
  resolves by id and 402s (with a re-save remedy) instead of delivering a
  token the stored config's dispatcher will refuse mid-run. The PATCH route
  blocks a preserved connector whose id no longer resolves (409 with
  "include connectors" remedy). And a connector whose saved token can no
  longer be decrypted (key rotation, corrupted row) is now a hard blocker —
  `tokenUndecryptable` on the store record — rather than being delivered as
  an empty bearer token that fails the run mid-stream.
- **Cross-tenant guards on the run and connect paths (security audit).**
  Three holes closed, each pinned by tests: `startRun` now resolves the
  target thread's existence and ownership from Postgres before any state
  change, so a caller who knows another tenant's thread id can no longer
  mark it "running" (denying the owner's real runs) or append their own
  messages to the victim's persisted history — a brand-new threadId stays
  creatable (the first runner becomes its owner); `startConnect` applies
  the same `threadVisible` rule as every sync read, so a known thread id
  no longer replays a foreign thread's full event history (and the denial
  fires before the history fetch, leaving the caches untouched); and the
  CopilotKit route now gates CopilotKit's stateless `POST
  /agent/:id/suggest` path exactly like a run (it executes the provider
  agent directly — previously it skipped the rate limit, plan gates,
  builder gate and concurrent cap), collapsing duplicate slashes before
  attribution so a `//run` path can't slip past the gate regexes either.
- **Saved API keys are editable.** Each row on the API keys page gains an
  Edit button (next to Delete) that opens the provider's form in place —
  blank inputs mean "keep the current value", so one field of a
  multi-credential toolkit (e.g. the X toolkit's access token) rotates
  without re-typing the rest. PUT semantics are position-aware: new
  providers still require the full contract; updates merge submitted
  values over the stored ones (undecryptable rows are treated as absent,
  forcing full re-entry) and a wholly-blank update is rejected.
- **Payment status gates plan enforcement.** `getOrgPlan` reads the
  subscription's Stripe status: only `active`/`trialing` keep their plan — a
  lapsed status (`past_due`, `unpaid`, `canceled`, `incomplete_expired`) reads
  as free, so a dunning org stops riding paid limits (agent caps, concurrent
  runs, quotas) until the subscription is fixed. The plan column alone is not
  authorization.
- **`DB_ENCRYPTION_KEY` is a boot requirement outside solo mode.**
  `instrumentation.ts` throws at boot when the key is missing and
  `AUTH_DISABLED` is not `true` — BYOK keys, connector tokens and agent JWT
  secrets are encrypted at rest, and booting without the key would store them
  in plaintext with only a console.warn. Solo mode (local playground, no real
  tenants) keeps the plaintext fallback.
- **SaaS disables the first-user-admin bootstrap.** The first-signup promotion
  in `lib/auth/auth.ts` runs only outside `SAAS_MODE`; on the hosted product
  the admin comes exclusively from `npm run create-admin` (which now also sets
  `"emailVerified" = true`).
- **Small honest-UI fixes from the audit's nit sweep:** an empty connector
  name now reports "Name is required" (the charset rule no longer
  overwrites it); the builder's provider picker prettifies provider slugs
  (same convention as the key badges — members pick "Openai Responses",
  not the internal door slug; the option value stays the raw slug so the
  PATCH contract is untouched); "Save changes" with a zero diff relabels
  to "Open in chat" (a stale snapshot still says "Save changes" — that
  click genuinely re-publishes the full config); the custom-endpoint form
  at the plan cap opens the same UpgradeDialog the builder form opens
  instead of showing a dead-end 402; "Configured agents (0)" no longer
  flashes during load; the edit-load failure pane gained a Retry; and
  member-visible copy consistently says "the agent builder" (the copy
  test now pins the rule against bare "the platform").
- **Failed fetches no longer impersonate empty states.** The /agents list
  shows a load-error pane with Retry (401 redirects to login) instead of
  claiming "No agents yet"; the builder's connector palette distinguishes a
  failed fetch (error + Retry) from a genuinely empty org, and its
  empty-state copy no longer says "add it" without an antecedent; the
  Connectors admin's load/save/remove and the custom-endpoint form's
  submit/delete catch network failures with the standard
  "Couldn't reach the server — please try again."; the builder's
  connect-key form renders save errors inline next to the inputs (the old
  page-level banner sat several screens away from the form — a failed save
  read as a silent no-op); the "Manage keys →" link on a blocked run fires
  only for key blockers (a missing-connector blocker no longer strands the
  user on a page that can't fix it); and key badges prettify
  provider/toolkit slugs instead of leaking raw dep keys.

- **Review-pass hardening for the doors feature.** The run gate's stale-snapshot
  refusal (keyed model without a declared `depKey`) is now pinned at the store
  level too — a pre-door blob must FAIL the schema and read back `undefined`
  (the gate blocks on that), so re-optionalizing the fields reopens a visible
  test failure, not a silent fail-open. The builder badge treats a keyed model
  with no `depKey` as missing with no connect form (never slug-guessed), the
  credentials catalog warns when it skips such a model, and the dead
  `depKeyForProvider` helper is gone. `docs/agent-builder.md` now describes
  the fail-closed 402 instead of the removed mechanical fallback.

### Added
- **The agent builder offers every model class a vendor ships — API doors included** — the platform's model discovery now registers every concrete model class each agno module defines instead of picking one canonical class per module: OpenAI's chat-completions and Responses API doors appear side by side (`openai-chat`, `openai-responses`), as do the generic adapters a self-hoster can point at their own server (`openai-like`, `openai-open-responses`), and the Responses doors of OpenRouter/xAI/Azure. Slugs are a pure function of where agno defines each class — the module's own file keeps the bare module slug (`openrouter`, `xai`), any other file gets `<module>-<file>` — never hand-picked, so nothing can flip out from under a saved row. One vendor's doors share the vendor's single key — the catalog now declares each provider's `dep_key` (deriving it from the slug would demand an `openai-responses_api_key` nobody can save) — and the same model id may exist under two doors: the registry binds component configs by `(id, class name)` instead of id alone, and the model catalog's global duplicate-id rule is now per-provider. tackui follows: the requirements snapshot REQUIRES the declared `depKey` and binding `name` (a keyed model without them is a stale snapshot — the run gate refuses it with a re-save instruction instead of guessing), the run gate resolves door-slug models' keys through the declared dep key and 402s with the vendor's label, the credentials page collapses a vendor's doors into one entry, and the builder's key-state badge routes "connect a key" at the vendor entry. `npx tsc --noEmit` clean; 850 tests green.

### Security
- **Cross-tenant thread isolation (IDOR cluster).** The runner's thread
  endpoints dispatched on `threadId` alone: a signed-in member of any org
  could read another tenant's conversation messages/events/state — or kill
  another tenant's in-flight run — by knowing a thread id (leaked via logs,
  Sentry breadcrumbs, screenshots). One visibility rule now guards every
  thread path (list, messages, events, state, stop, delete, rename): exact
  org match + owner-or-empty-owner (legacy ownerless rows are org-shared,
  matching the org-mate semantics deleteThread already had); solo mode (no
  runner user) sees everything; a cache-miss is denied fail-closed and
  denials are indistinguishable from unknown thread ids. The old
  `organizationId === ""` tolerance in `listThreads`/`deleteThread` — which
  let empty-org rows pass for every org — is gone. Behavior note: thread
  delete/rename is now owner-or-ownerless too, aligning management with
  visibility. The old deleteThread rule additionally let a same-org member
  delete or rename a thread they could not even view — management was
  strictly narrower than view before, and now they match.
- **SSRF guard hardened: fail-closed DNS, more bogon ranges, run-time
  re-validation, redirect re-guarding.** An unresolvable hostname is now
  REFUSED instead of passed through (the old fail-open was a rebinding
  window — an attacker's authoritative server can refuse the guard's lookup
  and resolve public for the real fetch). The blocked set gains
  carrier-grade NAT 100.64.0.0/10, 192.0.0.0/24, 198.18.0.0/15 and the
  TEST-NET documentation ranges; IPv4-mapped IPv6 is decoded in any textual
  form (hex `::ffff:7f00:1` included) via a full 8-group expander, and an
  unparseable IPv6 literal is refused. Run requests to tenant-supplied
  endpoints (manual/template agents) are guarded at request time — the
  guarded fetch re-runs the check on the URL and on every redirect hop
  MANUALLY followed — a public endpoint that 302s to an internal address
  no longer turns a validated URL into a pass-through. Builder agents are
  exempt: their endpoint is operator-configured platform infrastructure
  (AGENTOS_BASE_URL, typically a private-network address under SaaS
  mode), not a tenant-supplied URL — wrapping it in the guard refused
  every builder run under `SAAS_MODE=true` (`UnsafeUrlError: hostname
  resolves to a private address`), including against the agent builder's
  private-network backend service planned for production.
- **The CopilotKit runtime's global thread-wipe endpoint is unreachable** — `POST /api/copilotkit/threads/clear` is classified as a run by the copilotkit route (POST, not connect/stop), fell through to the runner's `clearThreads()`, which deletes EVERY tenant's runs, run states, messages and metadata with no caller identity to scope by (the runner is server-side). Nothing in the app calls it; the route now refuses it unconditionally, before auth and before any rate-limit accounting could burn a slot on it.
- **The live run stream is redacted with the same rule as persistence** — the `RUN_STARTED` fill (emitted when the backend doesn't echo the input) copies `request.input`, whose context carries the gate-injected secrets (model keys + MCP connector tokens): those streamed to every subscriber while `storeRun` redacted only the persisted copy. Every live event now passes the same `redactReservedEvent` rule before any subscriber sees it, with the reserved set captured inside the runner ALS scope so the redaction never depends on callback timing.
- **Closed the default-plan fallback that handed out the self-host sentinel** — `defaultPlan()` keyed on `BILLING_ENABLED`, so a SaaS deploy without Stripe wired (the exact state a launch passes through) fell back to the unlimited self-host plan for every org. It keys on `SAAS_MODE`: the hosted product's no-subscription default is free, always; `BILLING_ENABLED` only gates checkout.
- **MCP connector URLs now come from a platform-side registry — never the run wire.** A wire-supplied URL was an SSRF primitive: the dispatcher connected to attacker-chosen addresses from inside the deployment, with org tokens attached. Connector create/edit now **push-first-sync** the endpoint (id + URL + label, never tokens) to the platform's connector registry BEFORE the local write — a failed push changes nothing locally and surfaces the error — deletes remove the registry entry first, and the run wire carries `{connector_id: {token}}` only. Agent configs reference connector **ids** (names are org-scoped and collide across orgs; ids are the registry's keys) while the requirements snapshot keeps names, and agent saves re-register their referenced connectors belt-and-braces so a restored platform DB can't orphan them. The platform skips an unregistered id loudly and ignores any wire URL outright.
- **Stale-snapshot agents can actually be saved again** — the run gate's 402 remedy for a snapshot-less row ("open it in the agent builder and save it again") was a dead end: the edit form diffs against the missing snapshot, sending an empty patch (409) or — if one tool was ticked — a partial config that would silently destroy the agent's real tool set. A snapshot-less edit now sends the FULL config (`buildEditPayload` with a null original), so a zero-edit save works, and an amber banner explains why the model/tools/connectors fields start blank.

### Security (prior rounds)
- **Builder-origin rows can no longer be edited through the generic `PATCH /api/agents/[id]`** — an org admin PATCHing a builder agent there would write fields the registry ignores (endpoint/authMode/jwtSecret) while desyncing the local name/description from the AgentOS component with no sync path. The route now 400s with `AGENT_BUILDER_MANAGED` and points at the builder; DELETE still works (it soft-deletes the remote component). The builder route owns every edit for these rows.
- **Fixed a monetization bug where a 429 burned a daily platform-key run** — the builder run gate now runs in two phases: requirement checks (model/tool keys, connectors) stay before the concurrent-slot acquisition (nothing consumed, nothing held), while the platform-key quota is consumed only AFTER a concurrent slot is acquired. Previously a user at their concurrent cap could fire a platform-key run, have the quota counter increment, and then get 429'd — losing a daily run without any run happening. The gate's own docs claimed the opposite ordering. (Follow-up in the same vein: a throw inside the quota phase itself — a DB round-trip that happens after the slot is acquired — now releases the slot instead of leaking it to the watchdog.)
- **Closed a client-supplied credential-injection vector on the run path** — the registry middleware now strips any client-sent AG-UI context item whose key is a reserved dependency key before merging in the server-resolved per-run stash, which is appended last (stash wins collisions). Two layers: the mechanical `_api_key` family (case-insensitive), plus — inside a gated run — the run gate's exact delivered dep-key set, which covers multi-field credential contracts (`x_consumer_key`, `x_access_token`, …) that the regex can't know about. A signed-in user could otherwise ride a raw run request with a forged `mcp_connectors` item (the AgentOS dispatcher connects to attacker-chosen URLs with attacker-chosen Authorization headers — SSRF) or a forged BYOK key item, bypassing the run gate's org scoping entirely. Non-reserved client context still flows. Applies to every agent, builder or not.
- **Config-declared MCP connectors enforced AgentOS-side (defense in depth)** — the builder writes the agent's referenced connectors into the stored component config (initially keyed by name; the connector-registry redesign above switched configs and the wire to stable **ids** — the bullet above reflects the shipped design), and the platform-os dispatcher refuses any wire `mcp_connectors` key outside that list (fail-closed: warn + skip, the run proceeds without them). The dispatcher enforces the namespace, not the payload — see docs/security.md for the precise trust model. Config carries ids only, never URLs or tokens.
- **SSRF guard on `PUT /api/connectors`** — connector URLs now run `assertSafeUrl` before persisting (the AgentOS fetches connector URLs at run time with the org's token attached; the previous http(s)-only check did nothing against private-IP targets). `ALLOW_PRIVATE_ENDPOINTS=true` preserves localhost MCP servers for self-hosters; SaaS mode hard-locks the guard on.
- **Rate limit on `GET /api/connectors`** — member reads now go through the per-user `agentRead` bucket (writes were already limited).

### Added
- **Real-Postgres test coverage via testcontainers** — the five tests that were permanently skipped (pg-mem can't parse `WITH RECURSIVE` CTEs, do cross-statement ROLLBACK, or expose pg_catalog index metadata — the `pg-runner` connect() suite, the `withTransaction` rollback test, the migration index test) now run against a throwaway Postgres container (`lib/db/test-postgres.ts`); they skip with a console note when Docker isn't running, so Docker-less environments stay green.
- **Agent builder (create your own agents)** — members can create and edit agents on the platform AgentOS service (identity, model picker, tool palette, connectors) with BYOK credentials, per-run dependency delivery, run-gate 402s, and a platform-key daily quota.
- **DB-backed, discovery-driven models & tools admin (`/admin/platform`)** — what the agent builder offers is now a deployment decision made by ticking checkboxes: the platform-os scans its installed agno modules at boot and the platform admin enables model providers (with per-provider model-id lists), toolkits, and per-model attributes on the new admin page. Only the admin's decisions are stored (a separate `platform_catalog.db` on the AgentOS; tables start empty — the admin re-ticks boxes once after deploy); everything else (model classes, credential contracts, function lists) is derived from the discovery scan and rendered read-only. Adding a model or tool = an agno import + one checkbox — no code, no env, no redeploy (the AgentOS registry rebuilds on the next request). tackui proxies the AgentOS admin API (`GET/PUT /api/admin/platform/catalog`, `POST /api/admin/platform/test-model`) so the platform's JWT secret never reaches the browser; model-entry validation and 400s belong to the platform — their validation text surfaces to the admin as a clean detail line (member surfaces only ever see sanitized copy), and a Test button probes one model entry with a single completion through the platform's own env key. Gated to platform admins only (`role === "admin"`, same as `/admin` — the catalog is global, so its editors must be) + the usual rate-limit buckets; linked from the builder (admin-only) and `/admin`.
- **The agent builder as the single source of truth for the builder** — the tool palette and the BYOK provider catalog are derived live from the agent builder service (`GET /platform/tools`, `GET /platform/models`); adding a tool or model provider is a builder-side change with zero tackui code (not even env). The `BUILDER_TOOLS`/`CREDENTIAL_PROVIDERS` hardcodes are gone; the run gate is driven by the per-agent requirements snapshot captured at create/update time, and the builder's model/provider key-state badges derive from the same catalogs.
- **API keys page (`/app/credentials`)** — a dedicated BYOK credentials page linked from the account menu (the builder's inline connect forms stay as contextual shortcuts). Saved rows always render from the local DB; add-rows come from the live platform catalog per request (no cache). When the platform is unreachable, a banner explains that saved keys are unaffected and only new keys can't be added — `PUT` is fail-closed against the live catalog, while `DELETE` accepts any saved provider (a provider removed from the catalog shows "No longer supported" and stays deletable).

### Changed
- **`/agents` is the one agent-management surface — the standalone builder pages are gone** — the sidebar's separate "Create agent" and "Add agent" entries collapsed into a single member-visible "Add agent" icon that opens `/agents` with the add panel open. The panel shows the right form per agent kind: the agent builder form (member-accessible, now embedded via `components/builder/builder-form.tsx`) for creating new agents, the endpoint/JWT form for connecting an existing AG-UI backend (org admins flip the panel's "Create a new agent / Connect an existing agent" toggle — members get the builder form straight away), and Edit on a table row opens that row's correct form in the same panel (builder rows: author-only, with "Built with the agent builder" standing in for the endpoint; custom rows: the admin endpoint form; catalog installs stay curator-managed). The builder rows' dead Test button is gone (there's no client-visible endpoint to probe). The old `/app/builder` routes were removed outright — no redirects.
- **The builder edit form prefills the current instructions** — they were invisible after creation (blank field + "leave blank to keep" semantics, a pattern borrowed from write-only secrets). Instructions aren't a secret: `GET /api/agents/[id]` now reads them back from the AgentOS component config for builder agents (best-effort — an unreachable platform omits the field and the blank-preserve PATCH contract keeps the stored value), the form prefills, and the "leave blank to keep" hint is gone. Owner-editable like every other field.
- **Provider labels read correctly in member-visible copy** — `prettifyProviderLabel` applies a small acronym map ("openai" → "OpenAI", "azure_openai" → "Azure OpenAI", "z-ai" → "Z AI"), so the 402 run-gate banner, key badges, and connect forms no longer say "Openai" or "Api key".
- **The builder's model picker is two dropdowns (provider, then model)** — the provider decides whose API key a run needs, so it's now an explicit first choice; picking a provider resets the model to that provider's default. The old single select encoded the choice as `provider:model-id` and split it back on every colon, mangling model ids that contain one (OpenRouter's `:free` suffixes) — the model dropdown now holds raw ids, so ids round-trip exactly. In edit mode, a saved model or provider that the platform no longer offers renders as an explicit "(no longer offered)" placeholder with a notice explaining that the agent keeps its definition until a replacement is picked (saving other changes still preserves the old model).
- **AgentOS misconfiguration is loud again** — `logAgentosWarnings()` existed but was never called (dead code): a deployment with `AGENTOS_BASE_URL` set but no `AGENTOS_JWT_SECRET` booted silently and every builder run failed as an opaque 502. It now runs from `instrumentation.ts` at boot.
- **AgentOS error copy is sanitized at the source** — `agentosRequest` used to embed "AgentOS", the HTTP method/path, the status, and up to 300 chars of the response body into every failure message, and every proxying route surfaced it verbatim — so a SaaS user whose model list failed to load saw "AgentOS is unreachable (fetch failed)." and a platform admin's failed model test rendered a raw JSON dump. `AgentosError.message` is now always end-user-safe ("The agent builder is unavailable right now — please try again shortly." for unreachable/5xx; a generic rejected-request message for 4xx; the builder-disabled 503 no longer names `AGENTOS_BASE_URL`), and the upstream validation text rides in a separate `detail` field parsed from the response body — admin-gated routes (`/api/admin/platform/*`) return `{error, detail}` so operators keep the platform's own "why", member routes return the message only. The full upstream body is still logged server-side.
- **Model catalog entries whose provider slug doesn't match the model class are dropped (fail-closed)** — each platform model class now declares the credential dep key it resolves (`openai` → `openai_api_key`); a `PLATFORM_MODELS` entry whose provider slug doesn't match (e.g. `z-ai:...` for an OpenRouter-class model) would have passed the pre-run gate but failed at run time when the runner key was injected under a key name the class never reads. The entry is now dropped with a warning, and the operator-facing README documents the contract.
- **Dispatcher run-error events no longer leak raw exception text; MCP teardown is cancellation-safe** — the platform-os dispatcher's terminal `RUN_ERROR` event carries a generic message (raw detail stays in server logs; it can leak internal paths/URLs/provider errors to any signed-in client). The per-run MCP connector sessions now close cancellation-safely: Starlette leaves a cancelled stream's body generator suspended at its yield (its `finally` would only run via GC's asyncgen finalizer), so the dispatcher's response wrapper closes the generator deterministically on unwind, and the session closes themselves run inside an anyio shielded cancel scope — a client disconnect can't skip the `__aexit__` calls or leak an open HTTP/2 connection to the MCP server. The per-run credential reset also moved inside the `finally` so it runs on the cancellation path too. Also renamed the colliding `providerForDepKey` helpers (`providerForDepKeyInCatalog` is now the catalog-lookup variant).
- **The platform catalogs are empty by default** — the AgentOS no longer ships default tools or models: a freshly deployed platform exposes nothing to the builder until the platform admin enables providers/toolkits on `/admin/platform` (see the Added entry — the old env-allowlist flow is gone). tackui distinguishes reachable-but-empty from unreachable everywhere the catalogs render — the tool palette, model picker, and the credentials page's Connect-a-key section each get admin-facing empty-state copy ("The agent builder has no tools yet…"), while the unreachable banner keeps covering actual fetch failures. Create stays disabled while the model catalog is empty; edit is unaffected.
- **BYOK credentials are multi-field** (migration 0014) — one row per provider with a `fields` JSONB map (field name → AES-256-GCM ciphertext; the old single `secret` column is backfilled as `{"api_key": …}` then dropped), matching how toolkits actually take credentials: the X toolkit needs consumer key/secret + access token/secret, LLM providers take one `api_key`. Connect forms render one password input per field of the provider's derived contract (save gated on every field), and `PUT /api/credentials` validates the exact contract — unknown field names rejected, missing ones rejected, the save all-or-nothing (a partial contract would pass the run gate and fail mid-run). The run gate delivers one AG-UI context item per dep key of each contract. GET responses carry field names only, never values.
- **Builder runs are 100% BYOK — the platform-key free tier is dormant** — the run gate no longer exempts platform-tier models or serves platform-fallback tools from the platform env key: `platformTier`/`platformFallback` stay in the requirements snapshot and the platform-key quota wiring stays in place, but the gate ignores both and the daily platform-key quota never fires until Phase 3 publishing wakes them. The builder badges drop the "runs on the platform key" states accordingly (model badges are connected/missing/keyless; tool badges are connected/missing).
- **Pricing page leads with outcomes** — headline is now "Run real AI agents in your browser." (was "Pricing"), tiers show marketing prices that must match the configured Stripe Prices, Free's agent cap line is explicit that it covers catalog installs and your own agents ("Connect up to 3 agents — from the catalog or your own"), and the usage-limit copy was sharpened: Free lists "Daily usage limits on catalog agents (enough to get a feel)" while Pro mirrors it with "Much higher usage on every catalog agent." The upgrade dialog's tier lists match the new page copy.
- **Quota 402 banner carries an inline Upgrade button** — chat run failures with 402 `AGENT_QUOTA_EXCEEDED` / `PLAN_AGENT_LOCKED` render as a calm blue info banner (quota exhaustion isn't an error — red stays for genuine failures like rate limits and removed agents) with an "Upgrade" button beside the message that opens the upgrade dialog, so the conversion ask lands at the paywall moment rather than behind the account menu. The button only renders when an upgrade actually helps: free-plan quota exhaustion (Pro raises the cap) and plan-locked agents (a higher tier always exists); paid plans exhausting a shared paid quota get the countdown without a button, since Team shares Pro's allowance.
- **Quota 402 copy no longer says "daily"** — "You've reached your daily usage limit for this agent." → "You've reached your usage limit for this agent — you can use it again in 5h 12m." (the window is rolling-24h, not calendar-day; the countdown was already accurate).

### Fixed
- **A config edit on a builder row without a requirements snapshot can no longer silently wipe its tools and connectors** — a partial config patch (e.g. model only) on such a row defaulted the unpatched halves to empty and published a config with no tools; it now 409s with "include its model, tools, and connectors", mirroring the model half's existing refusal, and the compensating revert now restores (or clears) the snapshot unconditionally so a failed publish can never leave the local row leading the AgentOS. Unreachable through the app — every create writes a snapshot — this is a guard for hand-edited rows and future create paths. Pinned by tests.
- **Clicking the "Tools" or "Connectors" heading no longer toggles the first checkbox** — the section titles were `<label>` elements, which browsers wire to the first checkbox inside them; they're now proper fieldset/legend headings.
- **Thread rename/delete stop failing silently** — a network error during either action showed nothing; both now surface "Couldn't reach the server — please try again.", the rename/delete buttons also become visible on keyboard focus (they were hover-only, leaving keyboard users tabbing to invisible controls), and the status-dot/info icons are announced by assistive tech (`role="img"` — aria-label on a bare span is ignored).
- **Models & tools: Save is disabled while any enabled provider has no model ids** — the file's own docs claimed client-side blocking, but Save stayed clickable: the server's 400 would reject the entire full-state batch, discarding every other valid change with it. The inline row error + the Save tooltip say what to repair; dead-row clearing is unaffected.
- **Keyless-provider agents actually run now (the fix is complete this time)** — the previous round taught the run gate to skip the key demand for `requiresKey: false` models but missed that the agent store's zod schema didn't declare the field: zod strips undeclared keys on every write *and* read, so every DB-loaded snapshot looked legacy and ollama agents still 402'd with an unsaveable key demand. The schema now round-trips `requiresKey` (optional, never defaulted — absent stays absent so legacy snapshots stay legacy), the create test asserts the full shape, and a store round-trip test pins both directions.
- **The chat shell no longer sits on "Loading agents..." forever** — a failed or non-401 erroring agent-list fetch never set the loaded flag; it now surfaces a retryable "Couldn't load your agents" state with a Retry button (a window focus also refetches, as before).
- **The builder edit form no longer renders a blank provider select when the platform catalog is empty** — the empty-catalog state (the documented default before an admin enables anything) left the saved provider matching no rendered option; it now shows "«provider» (no models are enabled yet)" instead of nothing.
- **Builder PATCH 409s (concurrent edit) now re-converge the local row** — the compensating revert restores only the fields the request actually wrote, and it runs on a 409 too: the AgentOS write was refused, so the local row would otherwise lead the AgentOS. A 409 still surfaces as "This agent was just updated by someone else — reload and try again." Pinned by tests, including that a revert never touches fields the patch didn't change.
- **Internal jargon no longer reaches end users on failure paths** — the sidebar's status-dot tooltip told every member that success "does NOT validate AG-UI protocol compliance" (internal protocol name; member surfaces now get plain copy while the admin test-connection tooltip keeps the detail), a failed reachability probe said "Network error talking to /api/agents/reachability-probe" (an internal route path — now "Couldn't check the connection — try again shortly."), an org with zero agents threw "Add agents via the /agents admin page" into the run path, 500s told users to "Check server logs" (agents/credentials/connectors/catalog routes now say "please try again" — the logs are Sentry's job), and the catalog 409 said "template with the slug".
- **Keyless-provider agents are runnable** — the run gate unconditionally demanded a runner key for the model even when the platform catalog marks the provider keyless (`requires_key: false`, e.g. ollama), while the credentials catalog deliberately excludes keyless providers — so an ollama agent 402'd with "add your own Ollama key" that could never be satisfied. The requirements snapshot now carries the model's `requiresKey`, and the gate skips the key demand for it (legacy snapshots without the field keep the old behavior).
- **The models & tools admin page stops losing work silently** — a dirty draft now warns on tab close/refresh (`beforeunload`); a failed post-save refresh no longer shows a successful save as nothing (the draft is preserved and an explicit "Saved — but the page couldn't refresh" appears); a mid-save network failure shows an error instead of dying silently; a failed catalog load gets a Retry button instead of a confusing empty-state; open provider rows survive the post-save reload instead of snapping back to enabled-only; and the "Catalog saved." notice auto-dismisses on the same ~8s clock as test results. The draft inputs are now frozen while a save + refresh is in flight (a keystroke landing mid-flight was silently reverted by the refresh), a save with nothing to change is disabled, and the catalog PUT's partial-failure now says the models half applied instead of implying nothing was saved.
- **The edit form no longer claims a saved model is "no longer offered" just because the catalog is empty** — a reachable-but-empty catalog (the documented first-run state, before the platform admin enables anything) made every existing agent's edit page show the removal copy and lock the model select; empty-catalog and removed-model are now distinct states. An enabled provider/toolkit the platform no longer offers can also be unticked again (the dead-row clear path was unreachable because the checkbox was disabled outright — the admin was stuck in a permanent 400 loop), and the builder page's catalog-failure banner gets the same Retry button as the admin page.
- **A failed model test can no longer fail silently** — a client-side fetch exception (proxy down mid-request) in the Test button used to render nothing at all; the row now shows "✗ Couldn't reach the server — try again shortly."
- **Catalog-save warnings are no longer invisible** — the AgentOS PUT response can carry a `warnings` array of soft notes on an otherwise successful save (skipped rows, normalized entries); tackui's proxy dropped it, so the admin saw "Catalog saved." and never learned the save wasn't quite what they typed — the note surfaced later as a member's agent failing to run. The proxy now passes `warnings` through, and the admin page renders them in an amber "Saved with notes" banner that stays until dismissed (the ✕) or the next save — unlike the green notice, it doesn't auto-dismiss, because a warning the admin never saw is the exact failure mode this surface exists to prevent.
- **The admin page is screen-reader navigable** — the 36 accordion headers expose `aria-expanded`/`aria-controls` with panel ids (previously the expansion state was visual-only), provider/toolkit checkboxes and model-row inputs carry accessible names, and the remove buttons no longer rely on `title` alone. A provider slug that outgrows its header now truncates instead of overflowing the card.
- **A corrupt builder row no longer half-registers** — `getAgents()` used a non-null assertion on a builder row's `remoteAgentId`; a row with origin "builder" and a missing remote id (e.g. a failed write) would mint an endpoint of `/agui/undefined` and 404 at run time. Such rows are now skipped like a disabled platform.
- **Malformed percent-encoding in a run path no longer 500s** — extracting the agent id from `/api/copilotkit/agent/{id}/run` called `decodeURIComponent` unguarded; a path segment like `%%` throws URIError and would surface as a 500 on the run path. Malformed encodings now return null (the request is treated as no agent — 404-shaped), keeping the failure contained.
- **Run-failure banners no longer mislabel a paywall or a removed agent as "too many requests"** — the chat shell's fallback copy for bare 402/410 failures said "Too many requests. Try again shortly." (the server's own message usually wins; the fallback is now status-specific: "This agent can't run right now." / "This agent is no longer available."). Small copy/a11y tidy-ups alongside: the dismiss glyph matches the ✕ used elsewhere, the inline key-form inputs have accessible names, the catalog Test buttons announce which model they test, the "Your agents" list degrades silently on a network failure like every other loader, key inputs on the credentials page have accessible names, save/delete there disable each other (and Delete agent during a save), and the sidebar no longer carries its own drifting copy of the reachability-probe helpers.

### agent-builder service (history imported from the agent-warehouse
monorepo, where this service lived as `agents/platform-os` until the
move above)

- **The MCP cleanup close is capped like the attach.** When a connector
  handshake times out, the best-effort close of the in-flight session
  ran `__aexit__` with no timeout — a hung endpoint can hang the CLOSE
  just as it hung the open, reintroducing the eternal-spinner /
  occupied-slot failure the attach timeout exists to prevent. The
  cleanup now gets its own `wait_for` (same `MCP_ATTACH_TIMEOUT_SECONDS`
  cap); a cancelled cleanup never masks the original failure. Pinned by
  test (a connector that hangs on both enter and exit still lets the
  run start). The attach timeout env var is also parsed defensively now
  — a typo'd value falls back to 20s instead of crashing the service at
  import — and is documented in `.env.example`.

- **Upgrade note for pre-registry deployments:** components created
  before the connector registry carry connector NAMES in their stored
  config; the wire now carries ids and the dispatcher filters against
  the declared list — such agents silently run without their connectors
  until re-saved in the agent builder. Fresh deployments are unaffected
  (nothing to migrate). See the builder docs' connectors section.

- **Nit sweep:** the tool-function index now WARNS when two different
  toolkits expose the same function name (the index is last-writer-wins
  while registry rehydration is first-instance-wins — a future toolkit
  overlap must be a decision, not a silent shadow); `main.py` no longer
  builds the whole app at module level (importing the module for tooling
  no longer opens DB connections — the `__main__` entry passes the app
  object to uvicorn directly instead of an import string); and the
  per-agent thread-id contract is documented in the run client's
  architecture doc (`assert_session_writable` matches on
  `(user_id, thread_id)` — component match is parity with the stock
  router, so the frontend's per-agent keying is the guarantee).

- **The event loop is no longer the bottleneck for blocking catalog work.**
  The dispatcher's pre-stream section (`ensure_current` — a DB round-trip,
  and under a revision bump a FULL registry rebuild under the rebuild lock —
  plus agent construction) now runs on `anyio.to_thread`, and the
  `/platform/models` + `/platform/tools` routes are sync `def` (FastAPI
  threadpool). Previously every catalog request paid a blocking round-trip
  on the event loop, and a rebuild stalled EVERY concurrently streaming run
  for its whole duration; under >8 concurrent DB touchers the pool's 30s
  default acquire wait could pile requests up silently. The pool now bounds
  its acquire wait at 10s and fails fast with a clear `PoolTimeout` instead.
- **Each MCP connector handshake is capped** (`MCP_ATTACH_TIMEOUT_SECONDS`,
  default 20s, env-overridable): a hung connector endpoint (unreachable
  host, silent drop) no longer holds the run start indefinitely — the
  in-flight session is closed and the run proceeds without the connector,
  same skip-with-warning posture as any other failed handshake. Pinned by
  test alongside the cancellation-leak test.
- **The platform catalog refuses a version-mismatched database at boot.**
  `platform_catalog_version` carries a `schema_version` marker (column
  added idempotently): a fresh database is stamped with the code's version,
  and a mismatch (code deployed against newer tables, or stale tables under
  new code) fails the boot with the remediation in the error instead of
  serving rows it misreads.
- **CORS is now actually absent, not just unconfigured.** Agno's AgentOS
  unconditionally installs CORSMiddleware with its own default allowlist
  (localhost:3000, agno.com domains) — and passing `cors_allowed_origins=[]`
  does NOT help: agno's `resolve_origins` treats an empty list as falsy and
  falls back to those defaults anyway. `build_app` now strips the middleware
  entirely; a test pins that no `Access-Control-Allow-Origin` header is ever
  emitted, even on Origin-bearing requests (the service is
  private-network-only; its only browser-adjacent client proxies
  server-to-server).
- **The smoke test's destructive-boot guard no longer trusts single-label
  hostnames.** A bare hostname (`db`, `postgres`) is NOT proof of a
  container — Railway-style private networks name REAL production databases
  that way, and the old clause let the smoke test's destructive boot run
  against them with no override. Local compose targets now need
  `SMOKE_ALLOW_DESTROY` (testcontainers fixtures are loopback anyway).
- **Deployable as a Railway service**: `agents/platform-os/Dockerfile`
  (same two-stage uv workspace pattern as the sibling agents), and AGENTS.md
  documents the service's Dockerfile path + watch paths.
- **Optional Sentry, env-driven**: `SENTRY_DSN` initializes the FastAPI
  integration at boot (no-op when unset); traces stay off (provider
  streaming dominates latency — request spans are noise at chat volume).
  Documented in `.env.example`.
- **Platform env-key dormancy is now written down where the operator
  reads it**: `.env.example` carries the Tavily-style discipline on
  `OPENAI_API_KEY`/`OPENROUTER_API_KEY` — SaaS leaves them UNSET (the run
  gate 402s without a runner key), because an env key here lets any run
  silently spend the platform's money. The stale "Duplicate model ids"
  CHANGELOG bullet — which described a uniqueness rule the same unreleased
  series later replaced (per-provider ids, same-id doors, binding-pair
  uniqueness) — is removed rather than left contradicting the doors
  bullet.

- **Model bindings refuse to fall back, and the picker can't offer a dead
  row.** The dispatcher now REFUSES a run whose model binding doesn't
  resolve to a live registry instance — an identity check (`is`) against
  `registry.models`, not equality, so it holds regardless of how agno's
  resolution order evolves. The fallback it prevents: agno's
  `resolve_model` rebuilds a keyless model from the serialized dict when
  the registry misses, which then rides THIS deployment's platform env
  key — silently converting a BYOK run into a platform-funded one
  (observed live during the wrapper-cache incident). The refusal runs
  before anything starts (no credentials installed, no MCP sessions
  opened) and surfaces the AG-UI contract's terminal `RUN_ERROR` with an
  actionable, member-safe message. Feeding that path, the model index —
  the builder-facing picker (`GET /platform/models`) — is now built
  INSIDE `_build_registry` from the same accepted-rows loop (the function
  returns `(registry, model_index)`; `_rebuild_indexes` is now
  `_rebuild_tool_index`, fn_index only): the old separate rebuild
  recomputed the index from the raw snapshot WITHOUT the construct
  checks, so a row the registry skipped stayed pickable, agents got saved
  against it, and their runs hit the fallback above.
- **MCP connector URLs resolve from a platform-side registry, never the
  wire.** New `platform_connector` table (id → url/label, no tokens —
  they stay per-run deliveries) + admin endpoints
  `GET/PUT/DELETE /platform/connectors[/{connector_id}]` (admin-JWT
  guarded, pinned in the route-inventory test; URL shape validated),
  written only by the run client's server push-first. The dispatcher
  attaches MCP toolkits using the registry's URL for the wire's connector
  id; any URL arriving on the wire is IGNORED outright (a wire URL was an
  SSRF primitive — this service connecting to attacker-chosen addresses
  with org tokens attached), and an unregistered connector id is skipped
  loudly (the run proceeds without it — same posture as a failed
  handshake; the client's pre-run gate is the primary guard). Connector
  rows ride the catalog's revision-stamped snapshot
  (`CatalogSnapshot.connectors` → `CatalogState.connector_index`), so a
  push swaps the attach index atomically with the registry rebuild.
- **Review-pass hardening for the doors feature.** Discovery now accepts
  single-file model modules (`agno/models/foo.py` defining `Model`
  subclasses directly) — the export filter only matched the package
  layout, silently dropping such modules with no skip line; the docstring
  examples that claimed single-file support while the filter contradicted
  it are aligned. The PUT now ENFORCES the registry binding invariant the
  code only asserted in comments: two rows sharing BOTH a model id and an
  effective binding name (a hand-set `name=` attribute, or two
  same-named classes across modules) are rejected with the collision
  named — `get_model(id, name)` must always resolve to exactly one
  instance. New tests: the binding-collision rejection, the dead-provider
  admin rendering, `/platform/available`'s `dep_key` shape, the
  wrapper-cache reuse (identity across rebuilds), and the loud
  slug-collision skip for two classes in one file.

- **The per-provider model wrapper cache keys on the provider CLASS, not
  the module** — a REGRESSION the doors rewrite exposed: the cache key
  `(module, dep_key, env)` is identical for every door of one vendor, so
  the `openai-responses` row was built as a `PlatformOpenAIChat` wrapper.
  The registry then held two same-named chat instances for one id: a chat
  run bound the mis-wrapped instance and silently lost the row's attrs
  (the `reasoning_effort=none` fix gone — every tool run on the chat door
  400'd again), while a responses run matched nothing by name and fell
  back to agno's from-dict rebuild — a plain instance on the PLATFORM's
  env key, a silent BYOK bypass. The cache now keys on the provider
  class; a regression test pins that same-id doors produce one wrapper
  per class and that `registry.get_model(id, name)` resolves each door to
  exactly its instance.

- **Model discovery offers every class a module defines — no canonical
  picks.** The old `_CANONICAL_MODEL_CLASS` map (which silently skipped
  multi-class modules without a hand-written entry) is gone. Every
  concrete `Model` subclass an agno module exports is now an offering
  with its own slug, a pure function of where agno defines the class:
  the module's own file keeps the bare module slug (`openrouter`,
  `xai`, `deepseek`), any other file gets
  `<module>-<defining-submodule>` — `openai-chat`, `openai-responses`,
  `openai-like`, `openai-open-responses`, `openrouter-responses`,
  `xai-responses`, `azure-openai-chat`, `azure-openai-responses`.
  Nothing is hand-picked and no heuristic remains; note a slug still
  changes if agno itself reorganizes its files — that lands as a
  fail-closed dead row the admin re-enables, never a silent redirect.
  Only what a module DEFINES counts (a pure
  re-export is the defining module's offering). One vendor's doors share
  the vendor's single credential: `ModelProvider` gains `slug` and
  `dep_key` derives from the agno module, not the slug. The model index
  keys by `(provider_slug, id)` instead of id alone (same model id under
  two doors is the feature, not a shadowing hazard — the registry binds
  component configs by `(id, effective class name)` via agno's
  `registry.get_model`, and the PUT enforces that binding pair's
  uniqueness across providers), so the admin API's duplicate-id rule
  relaxes from global to per-provider. `GET /platform/models` rows carry the
  slug as `provider` plus the binding `name` and `dep_key`;
  `/platform/available` and `/platform/catalog/models` declare `dep_key`
  too. The `PlatformOpenAIChat` test seam moved from `models.py` into the
  test that uses it (production code stays generic).
- **UPGRADE NOTE (slug renames):** deployments with saved catalog rows
  under the old bare slugs (`openai`, `azure`) now have dead rows — the
  rebuild skips them with a warning and the admin page lists them as
  "No longer available" (their checkbox is disabled). Re-enable the same
  models under the new slugs (`openai-chat`, `azure-openai-chat`); any
  per-model attributes (e.g. `reasoning_effort=none`) must be re-entered.
  Nothing runs broken in the meantime: a dead row serves nothing and
  agents bound to it fail closed at run time.
- **Smoke test can no longer destroy prod data:** `smoke_test.py` used to
  blanket-merge `../personal/.env` into the environment — pulling in
  personal's PROD Neon `DATABASE_URL`, which satisfied the boot check and
  was then DROPped by the destructive boot (catalog tables + the agno
  `ai` schema, i.e. sessions, memories and learnings). Personal's .env is
  now read key-only (OPENROUTER/TAVILY); `DATABASE_URL` can only come from
  platform-os's own .env or the shell. And the destructive boot refuses
  non-throwaway targets — loopback/container hosts only — unless
  `SMOKE_ALLOW_DESTROY=1` is set; the same guard function is re-asserted
  immediately before the DROPs so the check and the drops cannot drift.
  The guard is pinned by unit tests (`tests/test_smoke_guard.py`).
- **The catalog runs on a connection pool:** every `catalog.py` operation
  — including each run's revision check — used a full TCP/TLS
  connect+close per call; a lazily-created `psycopg_pool.ConnectionPool`
  (one per DSN, min 1 / max 8, 5s connect timeout, created on first
  CatalogDB use — never at import) serves them all now, with identical
  context-manager semantics. The dep is `psycopg[binary,pool]`, and the
  dead `psycopg2-binary` is removed (agno rewrites `postgresql://` to the
  psycopg3 `postgresql+psycopg` dialect — no psycopg2 anywhere).
- **Rebuild stamps the revision it snapshotted:** the registry rebuild
  read the revision AFTER the row reads (spanning several connections), so
  a write committing in between was stamped as "already built" — a
  non-self writer's change then never triggered a rebuild until the NEXT
  write (permanent staleness). The rebuild now reads revision + rows over
  ONE transaction (`CatalogDB.snapshot`) and stamps that captured
  revision; a regression test interposes a concurrent write and asserts
  the next `ensure_current` rebuilds. The in-place registry swap also
  builds its fresh lists first and bulk-assigns (readers are still not
  serialized — only writers hold the lock — but the residual window is
  two list assignments, one-request transient at worst).
- **MCP attach no longer leaks sessions on client disconnect:** a
  cancellation during the attach phase (disconnect before the first byte
  streams) escaped the old `except Exception` (CancelledError is a
  BaseException) without closing the in-flight toolkit, and the partial
  attach progress was lost with the local list. `_attach_mcp_connectors`
  now appends every opened toolkit to a CALLER-OWNED list immediately
  after its handshake (survives the raise; the generator's shielded
  teardown closes them) and closes the in-flight toolkit best-effort
  before re-raising. Regression test cancels the task mid-attach and
  asserts both closes happen.
- **Smaller fixes:** the model env scan matches only assignment-shaped
  lines (a docstring merely mentioning another `*_API_KEY` can no longer
  misderive `platform_env_key`; all 36 shipped providers derive the same
  keys, pinned by test); `_coerce` rejects non-finite floats (nan/inf)
  with the standard error; a credential value that json-decoded into a
  non-string (extract_context turns `"12345"` into an int) logs "was sent
  but is not a string — treating as missing" through the single funnel
  (`credentials.resolve_from_deps`, shared by the run-context path and the
  dispatcher's pre-context toolkit build) instead of being silently
  dropped; and the `.env.example` admin-page path is corrected to
  the frontend's `/admin/platform`.
- **SQLite → Postgres:** the whole service now runs on the owner's
  `DATABASE_URL` Postgres (Neon for prod, local Postgres for dev — same
  pattern as the sibling chat agents). Agno's `SqliteDb` (components/sessions) is
  replaced by `PostgresDb` (auto-creates its `ai` schema + tables), and the
  catalog store (`catalog.py`) is rewritten from `sqlite3` to `psycopg`
  (`ON CONFLICT` upsert, native `BOOLEAN`); the
  `PLATFORM_OS_DB_FILE` / `PLATFORM_CATALOG_DB_FILE` env vars are gone.
  Model `attrs` moved to a native JSONB column — malformed JSON is
  rejected by the database at write time, which subsumes the earlier
  corrupt-row fix: a row whose TEXT-stored `attrs` failed to decode used
  to brick `GET /platform/catalog/models`, `GET /platform/models` and the
  `ensure_current` rebuild (i.e. every run request) until the row was
  hand-edited, and a skip-on-read guard was added for it; that guard (and
  its test) are removed because JSONB makes an unparseable row
  structurally impossible — a stronger guarantee than skip-on-read. The
  rebuild-time fail-closed skips for unconstructible/credential-bearing
  rows are unchanged. Tests run against
  a session-scoped testcontainers Postgres (Docker required; per-test
  truncation keeps runs hermetic), and `build_app` now takes
  `db_url=` as its test seam.
- **Model-entry grammar guard:** a `key=value` token that is not trailing —
  e.g. `openrouter:…:max_tokens=100:free`, an attribute typed before the
  `:free` suffix — is now rejected with a 400 instead of being glued into
  the model id. The old parse persisted a bogus `…:max_tokens=100` id that
  construct-checked fine and silently mutated into a different row on the
  next admin save (the client's round-trip drops the token).
- **Credential-attribute rejection re-applied at rebuild:** the
  rebuild-time re-validation of stored rows (`_validate_attrs`) now also
  rejects credential-shaped attrs, so a row hand-inserted with
  `attrs = {"api_key": …}` (direct DB edit or downgrade) is skipped with a
  warning instead of being served as a shared platform fallback key.
- **More grammar guards:** a mid-id `tier` token
  (`openai:model:tier:free`) and empty segments (`openai::gpt-4o`) are now
  rejected with a clear 400 instead of being silently glued into the id /
  silently filtered. The old parse persisted a bogus id with the tier flag
  dropped, and let a doubled colon change nothing while the admin thought
  it saved. Legit trailing orders (`provider:id:tier`,
  `provider:id:k=v`, either order) and colon-bearing ids (OpenRouter
  `:free` variants, `ft:gpt-4o-mini:org:suffix:ab12`) still parse.
- **Model-test probe is capped:** `POST /platform/test/model` now sends a
  30s timeout and a small `max_tokens` budget (64, explicit attrs win)
  whenever the model class accepts them — previously a class without a
  typed timeout fell back to the OpenAI SDK's ~10-minute default, and no
  token cap existed at all, while the client's proxy times out at 10s.
- **Dependencies:** the package now declares `agno[mcp,…]` (the
  dispatcher's MCP connectors import `agno.tools.mcp` — previously
  resolved only via a sibling workspace package, so a fresh
  `uv sync --package agents-platform-os` yielded a broken MCP feature) and
  `fastmcp` as a dev dependency (the test suite imports it directly).
- **Same-module toolkit collisions are surfaced:** two Toolkit subclasses
  in one agno module with different function sets silently overwrote each
  other in the discovery map; the overwrite is now logged like the
  cross-module dedupe (which one wins is unchanged). Plus dead-code
  removal (`models.py` unreferenced OpenAI client imports, a never-true
  `origin is Optional` check in `discovery.py`) and a `.env.example` for
  the service (default port documented as 7778).
- **Registry rebuild is swap-lock-protected:** `CatalogState.ensure_current`
  / `refresh` now hold a `threading.Lock` around the
  staleness-check → rebuild → registry-swap sequence (double-checked inside
  the lock). FastAPI's sync endpoints run in a threadpool, so two
  concurrent requests could both see a stale revision, both rebuild, and
  race the in-place swap — wasted rebuilds at best, an interleaved
  registry at worst. The common current-registry path stays lock-free.
- **Attribute values cannot contain `:` — rejected honestly:** a value
  like `base_url=http://localhost:11434` is tokenized at every colon and
  the tail lands in the model id; the entry is now rejected with a 400
  naming the attribute and stating the delimiter rule (nothing truncated
  is ever stored; the misplaced-attribute typo keeps its generic message).
  Related fix: `_coerce` now tries each member of a multi-member `Union`
  (e.g. `base_url: Union[str, httpx.URL, None]`) instead of falling through
  to `json.loads`, so union-typed attributes accept plain strings at all —
  previously every string value failed with an opaque "expects Union".
  Documented in the README's Known limitations.
- **Anonymous-401 pinned per `/platform` route:** every admin/builder
  `/platform/*` route is now pinned to answer 401 with no Authorization
  header (and 401 — not 403 — for a present-but-invalid token), with an
  inventory test that fails when a new platform route ships unpinned.
- **Silent drops now warn:** disabling a provider the deployment can no
  longer produce clears its dead row, and the save response's `warnings`
  now says so (previously the provider vanished from the catalog with no
  record of why). The disabled-provider-with-ids warning path is now
  asserted by test, and the model-test endpoint re-raises deliberate
  `HTTPException`s instead of re-wrapping them into "test failed: …" /
  "does not construct (HTTPException: …)" noise.

## [2.0.0] — 2026-10-17

### Added
- **Agent catalog (one-click agent installs, managed-plugin model)** — a curated, platform-admin-managed catalog of agent templates (`agent_templates` table, migration 0010) that any workspace can install with one click: an in-app page at `/app/catalog` (Add / Added ✓ / 🔒 plan-locked states; long card copy clamps with a Show more toggle so a 2000-char description can't stretch the grid; descriptions render typed line breaks, taglines are single-line), entry points in the chat sidebar's Agents header (book icon) + chat empty state, and a template-CRUD section on the platform-admin `/admin` page. Templates require a non-empty `tagline` + `description` (published cards can't be blank) and the optional `icon` must be a single emoji. Installed agents are **references, not copies**: the runtime resolves endpoint/auth live from the template on every run, so template edits (endpoint fixes, secret rotation, renames) propagate to every org with no user action — display copy too (the sidebar shows the live tagline/description/icon; the row's avatar is the live emoji, or a first-letter placeholder when the template has none). Install is idempotent — re-installing refreshes the snapshot in place, agent id preserved. Managed agents are **fully locked** (any PATCH → 400 `AGENT_MANAGED`; only Remove offered) and their `endpoint` is stripped from all API responses — curator backend URLs never reach the client. Works in both SaaS and self-host.
- **Catalog run gates (both modes) + monetization gates (SaaS-only)** — `checkCatalogRunGates` in the copilotkit run path: tombstoned agents → 410 `AGENT_REMOVED`, deactivated templates → 402 `AGENT_UNPUBLISHED` (the reversible kill switch) — both in every mode. Then SaaS-only: `requiredPlan` enforcement (402 `PLAN_AGENT_LOCKED`, catches post-install downgrades) and **per-tier rolling-24h per-user quotas** (402 `AGENT_QUOTA_EXCEEDED` with a "you can use it again in 5h 12m" countdown) — the cap picked by the org's plan: free → `freeDailyQuota`, pro/team → `paidDailyQuota` (one shared paid value; Team members get Pro's allowance; migration 0012 adds the column; nullable = uncapped). Usage limits surface only in the run 402 and on the pricing page — never on catalog cards. The sidebar annotates gated installs with a 🔒 Pro/Team chip (covers gated-after-install and downgrade-after-install). Quota counts come fresh from the run log on every run — attempts that never reach a backend don't consume it.
- **Template tombstones (migration 0011)** — deleting a template stamps its installed copies `agents.template_deleted_at` instead of deleting them: users keep browsing past conversations (a "Removed" chip in the sidebar; history replay works via the row's last-synced config), new runs are 410'd at the route before anything reaches the backend, and the org can clean up via the normal Remove. Tombstones never count toward the plan's agent cap (`countAgents` excludes them). Deactivation (`is_active = false`) stays the reversible kill switch.
- **Public `/catalog` marketing page (SaaS-only)** — server-rendered catalog with per-template `#slug` anchors for shareable deep links to individual agents (cards use the same tagline/description clamping as the in-app grid — the server emits the clamped `<p>`, the client adds the Show more toggle). Session-aware CTAs — uniform **"Get started"** → `/signup` when signed out (no per-card tier signals), **"Open in TackUI"** → `/app/catalog` when signed in; self-host redirects to `/app` (like `/pricing`); proxy allowlists it under SaaS mode. Pricing tiers now mention catalog usage qualitatively ("Catalog agents with daily usage limits" on Free / "Much higher daily limits on catalog agents" on Pro; Team inherits it via "Everything in Pro").
- **Marketing discoverability for `/catalog`** — "Agents" nav + footer link on all marketing pages (session-agnostic; the catalog page adapts its own CTAs) and a static catalog strip on the landing (copy + "Browse the agent catalog →" button — no live template data, so it renders the same regardless of catalog size). Per-page metadata (title + description) on all five marketing pages (landing, `/catalog`, `/pricing`, `/terms`, `/privacy`) so tab titles and shared-link previews no longer fall back to the root default.
- **Per-agent JWT auth (HS256)** — optional `authMode: "jwt"` per `agui` agent: the runtime mints a short-lived JWT (`sub` = the authenticated user's Better Auth id, `exp` +1h) signed with the agent's `jwtSecret` and sends it as `Authorization: Bearer <token>` on every run. Optional `jwtScopes` claim for backends with authorization (RBAC) enabled. `jwtSecret` is write-only (`PublicAgent.hasJwtSecret: boolean` replaces the raw value); encrypted at rest when `DB_ENCRYPTION_KEY` is set (see Security below).
- **User identity forwarding** — the runtime injects the authenticated user's id into `input.forwardedProps.user_id` on every `agui` run (Agno's convention for per-user memory/sessions). Done server-side per-request in `lib/agents/registry.ts`; client-supplied `forwardedProps` are preserved. Sent in both auth modes — when a JWT is present the backend pins to `sub`, otherwise it uses `user_id`.
- **Optional Umami analytics** — self-hosted web analytics integration (no-op when unset); CSP `script-src` origin wired accordingly.
- **Branded icon set** — thumbtack favicon (`app/icon.svg`, theme-aware via `prefers-color-scheme`), generated apple-touch icon + OG/Twitter social-share cards via `next/og` (no committed binaries), `metadataBase` from `BETTER_AUTH_URL`; removed the dead `COPY public/` Dockerfile line that broke builds with an empty `public/`.
- **Social provider icons** on the Google/GitHub sign-in buttons.
- **Sidebar agent avatars** — every chat-sidebar row leads with an avatar: the agent's emoji icon live-stamped from its catalog template, or a first-letter placeholder when there's no icon. Status dots ride the avatar's corner (white-ringed overlay) in both sidebar modes, and rows align now that every row has one.
- **Responsive UI** — drawer sidebar, mobile-friendly tables, compact back button on small screens; responsive landing navbar + hero.
- **Landing page expansion** — product mockup, bento grid, how-it-works section, scroll reveals; theme toggle added to the marketing header.
- **Active press feedback** on public-facing buttons.

### Changed
- **Agent `description` is now enforced as required** — the zod schema only rejected oversized descriptions; empty ones passed despite being documented as required. Create + PATCH now reject empty/whitespace-only values (trimmed at the boundary), and the `/agents` form marks the field required.
- **Test-connection results auto-dismiss** — the ✓/✗ reachability badges on `/agents` + `/admin` clear after ~5 seconds (successes included) instead of lingering. The chat sidebar's persistent status dots remain the always-on status surface — now for manually-added agents only: managed (catalog) agents have no client-visible endpoint to probe, so they render no dot (the avatar's corner carries state flags instead: amber = Paused, blue = plan-locked).
- **Forms on `/agents` no longer auto-open** — the agent and catalog-template forms are hidden by default behind a quiet "+ Add agent" / "+ New template" button on each section's heading row (Cancel closes; a successful submit closes too; Edit opens the form pre-filled and scrolls it into view). Arriving via the chat sidebar's + icon (`/agents?add=1`) opens the add-agent form automatically. Empty states carry an inline first-agent/first-template button. The page now leads with the data instead of a wall of inputs. Also fixes the "Configured agents" section's missing bottom margin (invisible in 1.0.0 when it was the last section, crowded once more sections stacked below).
- **Sidebar actions moved into the AGENTS header; `/admin` page split** — the chat sidebar's stacked footer links are gone: "Browse catalog" is now a book icon and "Manage agents" a + icon on the Agents section header (book for everyone, + gated to `canManage` and links to `/agents?add=1` which auto-opens the add-agent form; collapsed mode mirrors this under the agent-avatar stack) — the footer is down to avatar + theme. `/agents` is now purely workspace agent management; the platform-admin tools (catalog templates + user management) moved to a new gated `/admin` page ("Admin settings"), linked from the account menu's Admin section (and from the solo-mode avatar's new mini menu, which replaces the previously static synthetic-admin badge).
- **Tool-call rendering rewrite** — the `useRenderTool` wildcard now renders inline ChatGPT/Claude-style activity rows: status icon (spinner → ✓/✗), humanized tool name, inline arg preview; the expanded panel shows arguments as key-value rows and results as rendered markdown (`react-markdown` + `remark-gfm`), HTML tables (array-of-objects), pretty JSON, or plain text. Results that arrive JSON-escaped (literal `\n` / `\"` / `\uXXXX` — e.g. Agno/Tavily) are decoded first via `normalizeResultString` (conservative gate: zero real newlines + escape artifacts present). No size caps — only a visual height clip with Show all/Show less; `useMemo` + `React.memo` keep big results parsing once. Pure helpers live in `lib/tools/format.ts` (40 tests).

### Removed
- **`langgraph` agent kind** — the LangGraph Platform API integration (`LangGraphAgent` + Graph ID / LangSmith API Key fields) shipped in 1.0.0 without ever being smoke-tested against a real deployment. Removed rather than ship an admin-UI option that may silently not work; LangGraph users are served via `ag-ui-langgraph`. Migration 0008 deletes existing `kind='langgraph'` agent rows and drops the `graph_id` + `langsmith_api_key` columns (the langsmith secret's entire write-only stripping surface existed solely for this kind). Restore from git history when there's real demand (plus the missing smoke test).
- **Agent `kind` field removed entirely** — with `langgraph` gone, `kind` had exactly one legal value: a constant column, a single-value schema, and a one-case registry switch. Migration 0009 drops the `kind` column. POST/PATCH bodies that still send `kind` are accepted and discarded (zod strips unknown fields); the reachability probe no longer expects it (it was validated but never read); the admin sidebar no longer renders a kind badge. When a second kind is genuinely demanded, re-add the column + adapter in the same migration as its config fields.

### Fixed
- **Markdown tables in chat rendered broken** — Streamdown 1.6.x (pinned transitively by CopilotKit) stamps the inner `<table>` element with its wrapper's `data-streamdown="table-wrapper"` attribute via a prop-spread bug, so CopilotKit's stylesheet applied its `display: flex` wrapper rule to the table itself — destroying the table's column grid: header and body columns sized independently (header text not aligned over body cells), rows shrink-wrapped to content width inside the full-width box (dead space to the right), and a black gap between the header band and the first row. `app/globals.css` forces the real table back to `display: table` (the selector only matches the buggy attribute shape, so it goes dormant once streamdown is upgraded past 1.6.x), plus table polish: tables hug content instead of stretching full-width (wide tables still scroll via the wrapper's `overflow-x-auto`), solid header band, transparent body rows on the existing hairline separators instead of the stacked translucent tints, and a touch more horizontal cell padding (20px vs CopilotKit's 16px) so the outermost text doesn't sit against the hairline border.
- **Mobile marketing pages had no sign-in entry point** — the mobile nav in `MarketingLayout` rendered only a "Sign up" CTA when signed out ("Sign in" existed solely in the desktop nav), so mobile visitors had to go through the signup page to reach `/login`. A text "Sign in" link now sits beside the "Sign up" button on all four marketing pages (`/`, `/pricing`, `/terms`, `/privacy`).
- **Better Auth per-IP rate limiting behind proxies** — `ipAddress` headers configured so Better Auth's own limiter resolves the real client IP instead of the proxy's.
- **`/pricing` public under SaaS mode** — the proxy cookie gate now allows it (was redirecting signed-out visitors to `/login`).
- **Pricing page Team tier deduped** — the Team card listed "Priority support" separately despite "Everything in Pro" already covering it. Removed, and the upgrade dialog's feature lists now match the pricing page.
- **AG-UI no longer breaks across lines** in landing page headings.
- **Arabic/Quranic glyphs** now render via the Amiri font fallback instead of falling back to a Latin font.

### Security
- **Encryption at rest for agent JWT secrets** — `jwtSecret` values are stored as AES-256-GCM ciphertext (`enc:v1:<iv>:<ciphertext>:<tag>`, `lib/crypto/encrypt.ts`) when the new `DB_ENCRYPTION_KEY` env var is set (32-byte hex, `openssl rand -hex 32`), so a leaked DB dump/backup alone no longer exposes backend JWT verification keys. Encryption/decryption is contained inside `lib/agents/agent-store.ts` (write boundary encrypts, read boundary decrypts) — the registry, API responses, and blank-preserve PATCH flow work unchanged. An idempotent boot pass (`lib/crypto/backfill.ts`, wired into `instrumentation.ts`) re-encrypts legacy plaintext rows automatically. Unset key = documented plaintext fallback with loud boot warning. Per-row decrypt failure (rotated key, tampered value) degrades gracefully — the agent is treated as secret-less and the rest of the app is unaffected. Rotating the key requires re-saving each agent's JWT secret.

### Docs
- README cleanup + rename agent_frontend → tackui; Docker Compose V2 syntax + migration note; self-hosting note for same-host agent backends; placeholder GitHub links replaced with the actual repo URL; legal-page updates (account deletion claims, hardcoded "Last updated" date); AGENTS.md updates (Conventional Commits, branded icon set).

### Environment
- New optional env var: `DB_ENCRYPTION_KEY` — 32-byte hex key (`openssl rand -hex 32`) used to encrypt agent JWT secrets at rest (see Security above). Unset = documented plaintext fallback with a loud boot warning.
- New optional env vars: `NEXT_PUBLIC_UMAMI_URL` + `NEXT_PUBLIC_UMAMI_WEBSITE_ID` — self-hosted Umami web analytics (no-op when unset). `NEXT_PUBLIC_*` vars are baked at build time, so the prebuilt image can't enable them (see the README's build-time vs runtime note).

## [1.0.0] — 2026-09-09

Initial public release.

### Added
- **Streaming chat** — token streaming, multi-turn, cancel/resume (AG-UI protocol over SSE via CopilotKit)
- **Human-in-the-loop interrupts** — `useInterrupt` approval cards
- **Multi-agent switching** with per-agent threads (`AgentChat` wrapper keys `CopilotChat` by `agentId + threadId`)
- **Tool-call visualization** — `useRenderTool`
- **Postgres-backed thread runner** with conversation persistence (`PostgresAgentRunner` — extends `AgentRunner` from `@copilotkit/runtime/v2`, smart-replay `connect()` filters `RUN_ERROR` events, in-memory cache bridges the sync `LocalThreadEndpointRunner` interface to async PG)
- **Multi-conversation sidebar** — `useThreads` + auto-refetch on run completion, inline rename + delete (`PATCH/DELETE /api/threads/[id]`)
- **Dynamic agent registry** — DB-backed `getAgents()` factory + `/agents` admin UI with add/edit/delete + test connection + sidebar status dots. No restart needed when adding/editing/removing agents. Agent kind dropdown shows labeled options ("AG-UI / Generic", "LangGraph Platform") with descriptions; Graph ID + LangSmith API Key fields only appear when `langgraph` is selected.
- **Collapsible sidebar** — icon-only mode with smooth width transition, persisted to localStorage
- **LangGraph + Agno + raw AG-UI backends** wired first
- **Authentication (Better Auth):** email/password, Google/GitHub OAuth, OIDC SSO (Keycloak/Authentik/Okta/Entra), admin/member roles, per-user + per-org thread scoping, `AUTH_DISABLED` solo mode, first-user-is-admin bootstrap, user management admin UI, personal-org pattern (every user gets a workspace on signup via the `organization` plugin)
- **Multi-tenant org scoping** — `org_id` NOT NULL on `agents` + `thread_metadata`, all queries scope by the user's active org, org-level agent management (`canManageAgents`), solo mode creates a real org row on boot
- **Workspace member management** — `/app/members` page: roster via `listMembers` with role badges; remove a member (inline confirm); change a member's role (member↔admin↔owner) via `updateMemberRole` — enables ownership transfer; cancel a pending invitation; self-leave via `removeMember`; non-admins see only the roster + their own Leave button
- **SaaS mode (`SAAS_MODE`)** — same codebase as OSS self-host, gated by one env var. SaaS-only paths are inert when unset. SaaS pages (`/`, `/terms`, `/privacy`, `/pricing`, cookie notice) render at request time (`force-dynamic`), reading the live env var instead of build-time values.
- **Billing (Stripe flat subscriptions, SaaS-only):** Free / Pro / Team plans with per-plan agent + seat caps. Webhook receiver is signature-verified, bypasses the cookie gate, returns 500 on handler errors so Stripe retries transient failures.
- **Plan enforcement (SaaS-only):** `checkAgentCountLimit` (POST `/api/agents` 402s at cap), `checkMemberCountLimit` (invite path 402s at seat cap), `checkCanCreateOrg` (always allowed — workspace creation is free), plan-derived `runsPerMinute` + `concurrentRuns` overrides fed to the rate-limit middleware
- **Org switcher + invitations** — `org-switcher.tsx`, `invite-dialog.tsx`, `new-workspace-dialog.tsx`, `upgrade-dialog.tsx`, `/app/invitations` page
- **Marketing + legal pages (SaaS-only)** — `landing.tsx`, `/pricing`, `/terms`, `/privacy`, `cookie-notice.tsx`; session-aware buttons ("Go to app" for signed-in users instead of "Sign in to upgrade")
- **Email verification + password reset** — env-gated via `RESEND_API_KEY`. `sendOnSignIn: false` (verification email not auto-sent on every login); login page catches the 403 "email not verified" error and shows a "Resend verification email" button
- **Error tracking** — `@sentry/nextjs` integration (server + client + edge configs). No-op when `SENTRY_DSN` is not set. Error boundaries call `Sentry.captureException`. Trace sampling via `SENTRY_TRACES_SAMPLE_RATE`.
- **Error boundaries** — `app/error.tsx` (child-segment errors) + `app/global-error.tsx` (root layout failures, replaces `<html>`/`<body>`)
- **Server-side structured logging** — `[copilotkit] handler error`, `[runner] run failed`, `[reachability-probe] fetch failed`, `[billing-webhook] ...`, `[ratelimit] watchdog force-released concurrent slot`
- **Marketing layout** — `components/marketing-layout.tsx`, shared header/footer for SaaS marketing pages. Session-aware nav: "Go to app" for signed-in users, "Sign in" + "Sign up free" for signed-out.
- **Landing page redesign** — Linear/Vercel style with blue accent: radial glow, gradient headline, SVG feature icons, "Built on" trust section, final CTA. CSS animations (`fade-in-up`, `pulse-glow`) in `globals.css`.
- **"Need an agent backend?" links** on the admin page + chat empty state + README, pointing to the [AG-UI quickstart](https://docs.ag-ui.com/quickstart/server) + [19 integration packages](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations).
- **Security hardening:** `langsmithApiKey` stripped from all GET responses (`PublicAgent.hasLangsmithApiKey: boolean`); SSRF guard on agent create/edit (`lib/net/safe-fetch.ts` + `ALLOW_PRIVATE_ENDPOINTS` opt-in); security headers in `next.config.ts` (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, `poweredByHeader: false`); `BETTER_AUTH_SECRET` throws on boot if unset when auth enabled; open-redirect fix (`safeRedirect()` in login page); `/api/health` liveness endpoint (bypassed by proxy cookie gate); error-message masking on reachability probe
- **Rate limiting (two-layer):** per-IP global flood protection in `proxy.ts` (300/min) + per-user route-level limits in `lib/ratelimit/` (20 runs/min, 3 concurrent SSE streams, 10/min probe/mutations, 60/min reads). Better Auth `rateLimit` config (sign-in: 10/min, sign-up: 5/min per IP). 429 responses with standard `X-RateLimit-*` headers. Client-IP resolution checks `CF-Connecting-IP` first (Cloudflare → Traefik setups overwrite `X-Forwarded-For`), so the counter doesn't split across edge IPs.
- **Dockerfile + docker-compose.yml** — multi-stage build, non-root user, standalone Next.js output, Postgres 16 with healthcheck, app healthcheck wired to `/api/health`
- **In-memory test suite** — vitest + `pg-mem` (no Docker required, no cleanup needed between runs). 324 tests covering API routes, stores, billing, ratelimit, SSRF, auth, email templates, plan enforcement.

### Security
- **SSRF guard on reachability probe:** `POST /api/agents/reachability-probe` now applies `assertSafeUrl`. Previously any logged-in user could make the server issue an outbound GET to any URL — including cloud-metadata endpoints. Any logged-in user can still probe (the sidebar's status dots need it for members too), but only public URLs are allowed.
- **Mask internal errors on agent POST:** `POST /api/agents` no longer returns raw `err.message` on non-23505 failures (could leak DB topology / schema details). Now returns a fixed message and logs the detail server-side.
- **Pin session-cookie `secure` flag:** `betterAuth()` now sets `advanced.defaultCookieAttributes.secure = NODE_ENV === "production"` explicitly, instead of relying on Better Auth's `secure: "auto"` default (which depends on proxy header forwarding).
- **Webhook orgId cross-check:** Stripe webhook handler now cross-checks `sub.metadata.orgId` against `getOrgIdByCustomerId(sub.customer)` and drops the event on mismatch — defense against Stripe-account compromise attempting to re-attribute a subscription to a different org.
- **`X-Forwarded-For` spoofing fix:** `proxy.ts` now takes the Nth-from-right entry (configurable via `TRUSTED_PROXY_HOPS`, default `1`) instead of the leftmost. A malicious client can no longer override the rate-limit client IP by prepending `X-Forwarded-For: fake-ip`.
- **Concurrent-run watchdog:** `acquireConcurrent` now force-releases the rate-limit slot after `CONCURRENT_RUN_TIMEOUT_MS` (default 10 min) if `release()` was never called. Prevents slot leaks when a client opens a run and drops TCP without triggering `ReadableStream.cancel()`. The actual SSE stream / agent run is NOT cancelled — only the counter is decremented.
- **Empty webhook secret → null:** `getWebhookSecret()` now treats empty-string `STRIPE_WEBHOOK_SECRET` as `null` (was `""`), preventing silent signature-verification failures + Stripe's infinite-retry storm.
- **Defensive solo-mode secret fallback:** `AUTH_SECRET` const makes the `"solo-mode-no-sessions"` fallback unreachable by construction when `AUTH_DISABLED !== true` — guards against a future refactor removing the boot-time throw.
- See the README [Security](./README.md#security) section for the full posture: SSRF guard, rate limiting, session-cookie flags, `BETTER_AUTH_SECRET` enforcement, open-redirect protection, security headers, secret handling, known limitations.

### Added (OSS release)
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
- `.github/workflows/ci.yml` — lint + tsc + test on push/PR (pg-mem in-memory, no Postgres service)
- `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/bug.yml` + `feature.yml`, `.github/dependabot.yml`
- `package.json` metadata: `license`, `repository`, `author`, `engines`, `bugs`, `homepage`, `description`
- `CHANGELOG.md` (this file)

### Environment
- New optional env var: `TRUSTED_PROXY_HOPS` (default `1`) — number of reverse-proxy hops in front of the server, used to resolve the real client IP from `X-Forwarded-For`. Set to `2` for Cloudflare → Nginx → app, etc.
- New optional env var: `CONCURRENT_RUN_TIMEOUT_MS` (default `600000` = 10 min) — watchdog timeout for concurrent-run rate-limit slots. Floor is `60000` (1 min). Override if your agents do legitimately long research runs.

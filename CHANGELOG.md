# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  resolves to a private address`), including against the private-network
  warehouse planned for production.
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
- **AgentOS as the single source of truth for the builder** — the tool palette and the BYOK provider catalog are derived live from the AgentOS platform (`GET /platform/tools`, `GET /platform/models`); adding a tool or model provider to the platform is an AgentOS-side change with zero tackui code (not even env). The `BUILDER_TOOLS`/`CREDENTIAL_PROVIDERS` hardcodes are gone; the run gate is driven by the per-agent requirements snapshot captured at create/update time, and the builder's model/provider key-state badges derive from the same catalogs.
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

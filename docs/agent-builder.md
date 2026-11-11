# Agent Builder

> **Where the service lives:** the agent builder service's source is in
> THIS repo, under `agent-builder/` at the root (a Python/uv project,
> moved out of the old agent-warehouse monorepo — a location-only move,
> no functional change). Set up its venv with `cd agent-builder && uv
> sync --all-groups`, run its tests with `uv run pytest` (a Docker daemon
> is required — testcontainers Postgres), and deploy it as its own
> service (see the Dockerfile in that folder). The compose stacks run it
> as the `agent-builder` service with its own `db-builder` Postgres —
> both network-internal; the app is the only host-facing interface.

Phase 1 "create your own agents" — any signed-in org member can build an
agent on the agent builder service (identity/name, model picker, tool
palette, MCP connectors) without touching the admin `/agents` page. The
definition lives in the builder's shared multi-tenant store; tackui keeps
a normal agent row that resolves to it at run time. This doc covers the builder
subsystem: the two-place agent shape, the create/update flows, the run
gate, per-run dependency delivery, and the BYOK credentials + connector
stores. For the general registry mechanics see
[agent-registry.md](./agent-registry.md); run-path security in
[security.md](./security.md).

## The one rule

**The agent declares requirements; whoever runs it brings the
credentials — at run time, never stored in the definition.**

A builder agent's definition carries only *what it needs*: a model
(provider + id + platform tier + declared dep key + registry binding
name), tool names with their credential requirements, and connector
ids. Keys and tokens are never written into the definition. At run
time the runner's own BYOK keys (per-user `credentials` table) and the
org's connector config (`connectors` table) are resolved fresh and
delivered per-run as AG-UI context items. Nothing is cached agent-side,
and nothing is persisted on the AgentOS.

## Where an agent lives (two stores)

A builder agent exists in two stores at once:

1. **The AgentOS component store** — the versioned config the dispatcher
   rehydrates at run time (the "brain"). Lives in a separate service
   (the shared AgentOS). tackui is a client of
   this store over HTTP.
2. **tackui's `agents` table** — provenance + the org-facing row the
   sidebar lists. Carries `origin: "builder"`, `author_user_id`,
   `remote_agent_id` (the AgentOS-side component id), and a
   `requirements` JSONB snapshot.

**Trust boundary:** tackui = policy, AgentOS = execution. tackui decides
*who* runs *what* (auth, run gates, quota) and vouches for the runner's
identity with a JWT; the AgentOS executes and never persists
credentials — BYOK keys and connector tokens arrive per-run inside the
AG-UI `context` array and are read by the dispatcher for that run only.

## Platform configuration (`lib/config/agentos.ts`)

Boot-time consts (restart after env changes):

- `AGENTOS_ENABLED` — `!!AGENTOS_BASE_URL`. Unset ⇒ the builder is
  disabled: builder create/update routes return 503 and the UI shows a
  disabled state (see below). Stale builder agents (a self-hoster who
  removed the env) resolve to nothing rather than half-running.
- `AGENTOS_BASE_URL` — the agent builder deployment, no trailing slash.
- `AGENTOS_JWT_SECRET` — the shared HS256 secret both tackui (minting)
  and the AgentOS dispatcher (verifying) use. Required when the URL is
  set; the mismatch (`AGENTOS_MISCONFIGURED`) is surfaced as a loud boot
  warning (`logAgentosWarnings()`, called from instrumentation) instead
  of a throw, because non-builder agents are unaffected.
- `builderEndpoint(remoteAgentId)` — `{AGENTOS_BASE_URL}/agui/{id}`,
  `null` when disabled.

**No SSRF guard applies on builder routes** — the outbound URL is
platform config, not user-supplied (contrast the admin agent routes,
which run `assertSafeUrl`; see [security.md](./security.md#ssrf-guard)).

## Trust posture — nothing builder-shaped is client-trusted

The builder form sends names and ids only; everything security-relevant
is re-derived server-side at create/update time:

- **`platformTier`** is re-derived from the AgentOS models catalog
  (`GET /platform/models`). The client sends `model: {provider, id}`
  only. The flag is **dormant** for builder runs today (they are 100%
  BYOK — see the run gate), but it stays server-derived so Phase 3
  publishing (which wakes the platform-key free tier) never inherits a
  client-trusted input. A forged `platformTier: true` must never come
  from the wire.
- **Model `dep_key` and binding `name`** also come from the same catalog
  (server-side; the wire the client sends stays `model: {provider, id}`).
  A vendor may offer several API *doors* — agno's `openai` module ships
  the chat-completions class (`openai-chat`) and the Responses class
  (`openai-responses`), each under its own slug. Both doors share the
  vendor's single key (`dep_key` derives from the agno module, never the
  slug — slug math would demand an `openai-responses_api_key` nobody can
  save), and the same model id may exist under both doors: the stored
  component config carries `model: {id, name}` and agno's registry
  disambiguates same-id doors by the class name. Both fields are
  REQUIRED on the snapshot: a keyed model without a declared dep key is
  a stale snapshot — the schema rejects it at read time and the run gate
  refuses the run with a 402 telling the member to re-save the agent in
  the agent builder. The gate never guesses a dep key: slug math is
  exactly what breaks for door slugs, and a guess would demand a key
  nobody can save — or, worse, skip the demand entirely and let the
  platform's env-key fallback spend the platform's credential on a
  member run.
- **Tool `parameters`** (json-schema) come from the AgentOS tools
  catalog (`GET /platform/tools`); the client sends tool names only,
  validated against the live catalog at create/update time (an unknown
  name is a 400 — a stale client is user input).
- **Connector names** are validated against the org's connector store at
  create time (a typo'd name must not be storable); the run gate
  re-checks at run time. The stored config references connector **ids**
  — the platform connector registry's keys (see
  [security.md](./security.md#credentials--connectors-stores-builder-subsystem))
  — and the requirements snapshot carries **`{id, name}` pairs**: the id
  is the stable reference (ids are globally unique; names are org-scoped
  and collide across orgs) and the dispatcher matches the run wire's
  `mcp_connectors` keys against the config's id list. Snapshotting the id
  makes delete-and-recreate visible: a recreated connector gets a new id,
  the stored config still declares the old one, and the run gate 402s
  (demanding a re-save) instead of delivering a token the dispatcher will
  refuse mid-run. The run gate resolves the snapshot's ids with
  `getConnectorsByIds`; the PATCH route blocks a preserved connector whose
  id no longer resolves (409, "deleted or re-created… include connectors").
  Both routes also re-register the referenced
  connectors with the platform registry (belt-and-braces over the
  push-first sync at connector save — see
  [security.md](./security.md#credentials--connectors-stores-builder-subsystem)).

A note on concurrent first-time connector creates (accepted, document-only):
two simultaneous creates of the same-named connector in one org collapse to
a single local row — the store is an `ON CONFLICT (org_id, name)` upsert, so
the second write wins the row. Each request pushes its own registry entry
first (push-first ordering), so the losing request's registry entry can
linger under an id that nothing references. That orphan is harmless by
construction: registry entries are URL-only (tokens are per-run deliveries,
never stored there) and the dispatcher resolves attach URLs by the id the
local row carries, which is always the winner's. No code path reads a
registry id that isn't in a local row.

An unknown model (`provider:id` not in the catalog) is a
`BuilderValidationError` → 400. The picker is populated from the same
endpoint, so a mismatch means a stale client or tampering.

## Wire contract with the agent builder

JWT (HS256, proven in the phase-0 spike):

- **Service tokens** (`mintServiceToken()` in `lib/agents/builder.ts`) —
  minted per request, 600s TTL, `sub: "tackui-service"`,
  `scopes: ["app:superadmin"]`. Gates component CRUD + platform routes.
  AgentOS pins admin ownership to this fixed identity.
- **Run tokens** (minted in `lib/agents/registry.ts`) — per run,
  `sub` = the running user's id, `scopes: ["app:user"]` (the
  dispatcher's run-only scope). Gates `POST /agui/*`.

Component CRUD (Agno stock `/components` router):

| Call | Notes |
| --- | --- |
| `POST /components` `{name, component_id, component_type: "agent", description?, config, stage: "published", set_current: true}` | create → 201 ComponentResponse; `component_id` is tackui's `remoteAgentId` |
| `POST /components/{id}/configs` `{config, stage, set_current, guard: {latest_version}}` | publish a new config version; 409 = a concurrent edit landed first (reload + retry) |
| `PATCH /components/{id}` `(name/description)` + `guard: {current_version}` | metadata update with CAS guard |
| `DELETE /components/{id}` | soft-delete |
| `GET /components/{id}` + `GET /components/{id}/configs/current` | guard source + the instructions source for partial patches |

Stored config shape (the spike-proven contract — `model` is `{"id": ...}`
ONLY; extra fields break registry rehydration; the history flags must
always be present because sessions live Agno-side):

```json
{
  "id": "<component_id>",
  "name": "...",
  "model": { "id": "<model-id>" },
  "instructions": ["<system prompt>"],
  "add_history_to_context": true,
  "num_history_runs": 10,
  "tools": [{ "name": "...", "parameters": { "json-schema": "..." } }]
}
```

`agentosRequest()` is the single HTTP entry point: fresh service token
per call, 10s timeout (the AgentOS is same-host infrastructure — a hung
call should fail the builder request, not hold it), 502 on
unreachable/401/403, 503 when the platform is disabled, and AgentOS
error statuses otherwise (`AgentosError.status` drives the route
response).

**Error copy discipline:** `AgentosError.message` is always
end-user-safe — the platform is called "the agent builder," never
"AgentOS," with no method/path/status framing and no raw response
bodies — so every route may render it verbatim. The upstream
validation text rides in `AgentosError.detail` (parsed from the
FastAPI `detail` field), and only admin-gated routes surface it:
`/api/admin/platform/*` return `{error, detail}`, member routes return
`error` alone. The full upstream body is always logged server-side for
operators.

## Models & tools — the admin page (`/admin/platform`)

What the agent builder offers is a **deployment decision**, made in one
place with zero code: the platform admin lists model ids under providers
(a provider is enabled exactly when it lists at least one — there is no
separate toggle) and ticks toolkits on `/admin/platform`
(`components/platform-admin.tsx`,
gated to platform admins only — `role === "admin"`, identical to
`/admin`; org owners/admins must not set platform-wide policy, and the
catalog is global so who edits it must be too). Everything else on the
page is derived from the AgentOS's discovery
scan and rendered read-only (class names, credential contracts, function
lists), so nothing editable
can desynchronize the stack. Platform env-key state is **not** displayed
row-wise — builder runs are 100% BYOK, so "is `OPENAI_API_KEY` set?"
answers nothing an enabler cares about; it surfaces only at the Test
button (below), the one place the platform key does work. It returns as
a per-provider column when the Phase 3 tier/publishing wakes.

- ** tackui never talks to the AgentOS admin API from the browser** —
  the page goes through tackui's proxy routes (`GET/PUT
  /api/admin/platform/catalog`, `POST /api/admin/platform/test-model`),
  which mint the service token server-side. The AgentOS JWT secret
  never reaches the browser.
- **Model editing is a per-provider row editor** — each model id is its
  own input with inline Test/remove, `+ Add model id` appends, and
  multi-line pastes split into rows; `Clear all` empties a provider's
  rows in one click (rendered only when ids exist, no confirmation —
  nothing persists until Save). Grammar
  `model-id[:key=value …]` (bare ids inside a provider's own
  block). The UI no longer advertises the dormant `:tier` segment, but
  the parser still accepts it for Phase 3 publishing, and stored values
  round-trip exactly. The AgentOS validates entries against its own
  model classes (unknown attribute → 400); the platform's validation
  text reaches the admin through `AgentosError.detail` — rendered as a
  clean second line, no transport framing — while member surfaces only
  ever see the sanitized message.
- **A provider's enabled state is derived from its model ids** — the
  header shows a status dot + count label (● n models / ○ off; shape and
  text carry the state, not just color) instead of a checkbox. Adding
  the first id enables the provider, removing the last disables it, and
  the PUT body derives `enabled` from the rows — so the two states the
  backend guards reject (enabled with no ids; ids under a disabled
  provider) can't be constructed from this UI. The backend guards stay
  as defense-in-depth; the derivation lives in the pure helper
  `components/platform-admin-catalog.ts`.
- **Test button** — one "hi" completion straight to the provider through
  the platform's own env key, answering "does this model id exist and
  does the platform key work?" before the admin enables it. Disabled
  (with a tooltip) when the provider's platform env key isn't set —
  runner keys are unaffected either way (BYOK runs bring their own).
- **Full-state replace:** PUT sends every provider/toolkit row; writes
  bump the AgentOS catalog revision and the registry rebuilds on the
  next request — changes go live without a restart. Disabling an
  offering that still has enabled rows clears them; disabling a
  provider/toolkit the deployment can no longer produce (an agno
  upgrade dropped it) is accepted as the legit dead-row clear — enabling
  one is a 400. "No longer available" provider rows render non-editable
  and offer no "Add model id" — their ids can only be cleared (per-row
  ✕ or Clear all), which saves as `enabled: false` and clears the row.
- **Soft warnings on a successful save:** the PUT response can carry a
  `warnings` array — the platform's soft notes (skipped rows, normalized
  entries). Hard failures 400 with full detail; warnings are the
  in-between. The proxy passes them through, and the admin page renders
  them in an amber "Saved with notes" banner that stays until the admin
  dismisses it (or the next save) — a soft note the admin never saw
  would surface later as a member's agent failing to run.
- **Tool gating is deliverable-gated:** a toolkit whose credential envs
  have no delivery path (a cred-shaped env with no matching constructor
  arg) stays visible but can't be enabled.
- The underlying AgentOS surface is `GET /platform/available` (the
  discovery scan) + `GET/PUT /platform/catalog/{models,tools}` +
  `POST /platform/test/model` + the connector registry
  (`GET /platform/connectors`, `PUT|DELETE /platform/connectors/{id}`) —
  admin-scope only, documented in the service's README
  (`agent-builder/README.md`).

## The tool palette — the platform tools catalog

The tools a builder may attach are NOT hardcoded in tackui. They come
from the AgentOS `GET /platform/tools` catalog — **discovery-driven**:
the AgentOS scans its installed agno modules at boot and the platform
admin ticks checkboxes on `/admin/platform` (see
[Models & tools](#models--tools--the-admin-page-adminplatform) below). tackui proxies the
enabled subset to the browser via `GET /api/tools`. Adding a tool = an
agno import on the AgentOS + one checkbox — zero tackui code, not even
env.

Per tool the catalog carries `name`, `label`, `description`,
`requiresKey` (the AG-UI context dep key of the FIRST credential — null
for keyless toolkits), **`toolkit`** (the provider slug the credentials
are saved under), and **`credentials`** — the full credential contract:
`[{depKey, label}]`, one per constructor argument the toolkit takes.
Single-key toolkits (tavily) carry exactly one; multi-credential
toolkits (the X toolkit: consumer key/secret + access token/secret)
carry several. The dep keys follow the `<provider>_<field>` convention
and the credentials catalog (`lib/credentials/catalog.ts`) derives the
provider's saved-field list from them.

`platformFallback` (the AgentOS deployment carries an env key for the
tool) is still in the wire but **dormant**: builder runs are 100% BYOK
until Phase 3 publishing, so the run gate ignores it and a missing
runner key is a 402 regardless. The snapshot keeps storing what the
catalog said so the future needs no shape change.

Tackui never re-derives any of this — the snapshot stores what the
catalog said at create/update time, and the run gate reads only the
snapshot (see the run gate section). The builder UI loads the palette
per request; when the fetch fails the form disables rather than
validating against a stale palette.

`components/builder/builder-config.ts` mirrors the wire shape client-side
(`BuilderToolOption`, caps: max 10 tools, max 10 connectors); the server
re-validates with zod. There is no hardcoded tool list — `BUILDER_TOOLS`
was removed; the only constant left is `BUILDER_TOOLS_MAX`.

## Create flow — `POST /api/agents/builder`

Member-accessible (any signed-in org member; unlike the admin
`/api/agents` routes there is no `canManageAgents` gate). Rate-limited
via the `agentMutate` bucket. Order of checks:

1. Auth (401), `checkUserLimit` rate limit, JSON + zod validation (400).
2. **Plan enforcement (SaaS only):** `checkAgentCountLimit` — the org's
   agent cap counts builder agents like any other (free = 3). 402 with
   `PLAN_AGENT_LIMIT` on the cap.
3. **AgentOS round trips first** — models catalog + tools catalog
   fetched in parallel; failures here are 502/503 *before anything is
   written*. Then `resolveBuilderModel` (unknown model → 400) and
   connector existence (missing → 400).
4. **Two-phase create with compensation:** the local row is written
   first (provenance + the sidebar-facing record — endpoint =
   `builderEndpoint(remoteAgentId)`, `authMode: "jwt"`,
   `jwtScopes: ["app:user"]`, origin/author/remote/requirements), then
   the AgentOS component is created. If the AgentOS call fails, the
   local row is deleted (compensating) so a retried create doesn't
   orphan half an agent — AND a best-effort `DELETE /components/{id}`
   removes a possible platform-side orphan (the case where the POST
   actually succeeded server-side but the response timed out leaves a
   live component with no local trace). 502/503 surfaces via
   `agentosErrorResponse`.
5. Success → `201 { PublicAgent }`.

`requirements` is written at create from the definition tackui itself
built: `{ model: {provider, id, platformTier, requiresKey}, tools: [{name,
requiresKey, provider, platformFallback, credentials}], connectors:
[{id, name}] }` (`buildRequirements()`) — the tool rows carry the full
credential contract so the run gate can enforce all-or-nothing delivery
of multi-credential toolkits, and the model's `requiresKey: false` (a
keyless provider like ollama) tells the gate to demand no key at all —
the provider is excluded from the credentials catalog, so a demanded
key would be unsatisfiable. **The snapshot must survive the store's zod
round-trip** — `requirementsSchema` declares `model.requiresKey`
(optional, NOT defaulted: absent must stay absent so the gate's
"undefined = legacy = keyed" contract holds), and the store round-trip
test pins both directions. An undeclared key would be silently stripped
by zod on every write *and* read, turning the keyless fix into dead
code while every test stays green.

Generic `/api/agents/[id]` PATCH **rejects builder-origin rows**
(`AGENT_BUILDER_MANAGED`) — their runtime config lives in the AgentOS
component, so editing endpoint/authMode/jwtSecret here would write
fields the registry ignores while desyncing the local name/description
from the AgentOS component with no sync path. The builder route owns
every edit for these rows (strictly the author — no admin override). DELETE on the generic
route still works (it soft-deletes the remote component).

The run request routes through `runWithRunnerContext` whenever the gate
resolved a builder run (keyed on `reservedDepKeys`, not on whether any
items were delivered) — so even a keyless-model agent with an empty
stash gets the registry's exact-set strip of client-supplied reserved
dep keys, not just the mechanical regex layer.

The AgentOS stored config is the source of
truth; the snapshot only powers the pre-run gate so run requests need no
AgentOS round-trip.

## Update flow — `PATCH /api/agents/builder/[id]`

Author-only (`authorUserId === user.id` — no admin override; members can
READ via the org's `GET /api/agents`, only the author edits/deletes).
Non-builder agents and deleted components are not addressable here at
all (404, not 403 — no existence oracle for foreign rows).

- **Blank instructions preserve the stored ones.** Instructions live in
  the AgentOS component config, not the local row (the local GET
  response doesn't carry them), so the UI starts the field blank and
  only sends `instructions` when the user typed one — the same
  blank-preserve pattern as `agents.jwtSecret`. When instructions
  *aren't* in the patch, the route reads the current config from the
  AgentOS; if that config has no instructions (empty array — builder
  agents always carry a system prompt, min 1 char at create), PATCH
  returns **409** ("Cannot update the agent without its current
  instructions.") rather than silently wiping the prompt. An AgentOS
  read *failure* surfaces as 502/503 instead.
- Config changes (instructions/model/tools/connectors) re-derive the
  requirements snapshot — model tier, tool credential contracts +
  parameters (same trust posture as create); model, tools, connectors
  replace wholesale when present. If the agent's stored model has left
  the catalog, a config patch can't proceed without re-resolving it
  (400).
- **Two-phase update, local row first, compensating revert** when the
  AgentOS half fails — the local projection never leads the AgentOS.
  Config publishes are guarded with the component's `current_version`
  as `latest_version`; a 409 from the AgentOS means a concurrent edit
  landed first (reload + retry). One `GET /components/{id}` before any
  writes serves as the guard source for both writes. On a failed config
  publish the revert re-derives the requirements snapshot from the
  platform's CURRENT config (`deriveRequirementsFromConfig`,
  best-effort — falls back to the pre-patch snapshot when the platform
  is unreachable): after a 409 the platform serves the concurrent
  editor's config, and restoring the pre-patch snapshot would gate the
  wrong credential. The same derivation heals a snapshot-less row with
  the platform's actual config.
- Metadata changes (name/description) PATCH the component with a
  `current_version` guard.

## Delete flow — `DELETE /api/agents/builder/[id]`

Author-only (same 403/404 rules as PATCH). The AgentOS soft-delete is
**best-effort**: when it fails, the local row is still removed (the
registry stops resolving it → no more runs) and the orphaned component
is logged for platform-side cleanup; a 404 (already deleted) is fine.
Delete before AgentOS-vs-local ordering is inverted vs. create: the
AgentOS call comes first precisely because its failure is tolerable
here.

## Run gate — `lib/agents/run-gate.ts`

`checkBuilderRunGate(user, agentId)` is called by the copilotkit route
for **every** run request, before anything reaches a backend. Only
builder agents (`origin === "builder"` with a requirements snapshot) are
gated; anything else gets the empty resolution (catalog agents have
their own gates in `checkCatalogRunGates`). The gate runs in **two
phases** so refusal can never cost the user anything they didn't get:

### 1. Gate phase — one aggregated 402

All checkable blockers are collected into a **single** 402
(`AGENT_REQUIREMENTS_MISSING`, `error` = the joined human explanations)
so a user sees everything wrong at once. This phase consumes nothing:
a refused run burns no quota and holds no concurrent slot (the gate
runs before `acquireConcurrent`).

- **Model:** the runner has no key for the model's provider → "add your
  own {OpenAI|OpenRouter} key to run it."
- **Tool:** any field of the tool's **credential contract** is missing
  from the runner's saved fields → "add your own {Tavily} key / {X}
  credentials to run it." The contract is **all-or-nothing**: a partial
  match delivers nothing (a partial contract would pass the gate and
  fail mid-run). Snapshots written before multi-credential support
  treat the single `requiresKey` dep as the contract.
- **Connector:** a required org MCP connector is not configured →
  "an org admin needs to add it before it can run." Connectors resolve
  **by id** (snapshot `{id, name}` pairs): a connector that was deleted
  and re-created keeps its name but gets a new id, so the gate 402s and
  asks for the agent to be re-saved in the agent builder. A connector
  whose saved token can't be decrypted is also a blocker ("token can't
  be read — re-enter it") — it is never treated as tokenless. Missing
  connectors
  are always blockers — there is no platform fallback for connector
  credentials in any mode.

**TIER DORMANCY (wakes at Phase 3 publishing):** builder runs are 100%
BYOK. `requirements.model.platformTier` and tool `platformFallback`
stay in the snapshot but are **ignored** here — the platform env key
serves nothing today, so a tiered model without a runner key is a
blocker exactly like any other. The resolution's `platformKeyRun` flag
stays wired but is `const false`, so the quota phase below never fires
until publishing wakes it.

Requirement 402s apply in **both** SaaS and self-host modes. Only the
platform-key quota (phase 3) is SaaS-only.

### 2. Resolve dependencies — per-run AG-UI context

Collects the context items the run needs, shape `{description, value}`
(both strings — the AG-UI `Context` wire type). One item **per field of
each credential contract** — a multi-credential toolkit delivers all of
its dep keys:

| dep key | value |
| --- | --- |
| `openai_api_key` / `openrouter_api_key` | the runner's decrypted `api_key` field (when the model needs one) |
| `tavily_api_key` | the runner's Tavily `api_key` field (when a keyed tool runs) |
| `x_consumer_key`, `x_consumer_secret`, `x_access_token`, `x_access_token_secret` | the runner's X toolkit fields (one item each) |
| `mcp_connectors` | JSON string `{connector_id: {token}}` for the org's configured connectors referenced by the agent — **ids only, no URLs**; the platform resolves attach URLs from its own registry |

These keys are **server-resolved only** — the registry middleware strips
any client-sent context item with a reserved dep key before merging the
stash (see "Credential keys are server-authoritative" below). The gate
also returns the exact set of dep keys it delivered (`reservedDepKeys`);
the registry strips client items against that set on top of the
mechanical regex, so multi-field contract deps can't be forged either.
The AgentOS enforces the same boundary from its side: the dispatcher only
attaches wire `mcp_connectors` whose **ids** the component's stored config
declares, so the namespace stays closed even if a tackui bug reopens it.

**Keys are the runner's own — never the platform's.** A runner key is
delivered as a context item; platform env keys are NEVER injected as
context items. (Before the tier dormancy, platform fallbacks served
keyless runners; today the gate 402s instead — see phase 1.)
Dependencies resolve in both modes so BYOK delivery works everywhere.

### 3. Quota phase — consume the platform-key quota (DORMANT)

This phase runs **after** the copilotkit route has acquired a concurrent
slot (`acquireConcurrent`), not inside the gate. When the run is
platform-key, it counts against the org plan's `platformDailyQuota`
(see [saas-mode.md](./saas-mode.md#plan-enforcement-saas-only)). Over
quota → 402 `PLATFORM_QUOTA_EXCEEDED` with the reset countdown (free
plans get an "Upgrade to Pro for more usage." clause), and the route
releases the freshly-acquired slot before returning. On self-host the
quota check short-circuits entirely (the operator pays the platform key
bill themselves; the self-host sentinel is `null` anyway).

**The phase is dormant until Phase 3 publishing**: builder runs are
100% BYOK, `platformKeyRun` is always `false`, and `consumeBuilderRunQuota`
is a no-op for BYOK runs — so today this never fires. The wiring stays
so publishing wakes it with a one-line change.

The split exists because the two phases have different cost models: a
requirement 402 must be free (nothing consumed, nothing held), but the
quota must only burn once a run is actually admitted past the concurrent
cap — otherwise a user at their cap would 429 *and* lose a daily run.
Runs that fail mid-stream legitimately consume (the platform key was
spent).

## Registry integration — `lib/agents/registry.ts`

The builder branch of `getAgents()`:

- Recomputes the endpoint from `AGENTOS_BASE_URL` at run time (so a URL
  change takes effect without rewriting rows) and skips the agent
  entirely when the platform is disabled or the endpoint can't be built
  — stale builder agents resolve to nothing rather than half-running.
- Auth is the AGENTOS **user** token: minted per run, HS256 signed with
  `AGENTOS_JWT_SECRET`, `sub` = the running user, `scopes: ["app:user"]`.
  The stored row carries no `jwtSecret` for builder agents, so a
  platform secret rotation is transparent.
- Template live-resolution doesn't apply (builder rows have no
  `sourceTemplateId`), so the stored row's own fields are the resolved
  ones — with the endpoint/jwtSecret overridden from platform env as
  above.

**Context-injection middleware:** the `HttpAgent` middleware
(`agent.use()`) is synchronous, so the dependency resolution cannot
happen inside it. Instead the copilotkit route pre-resolves the items
(the run gate needs them anyway — they gate the run) and stashes them
via `runWithRunnerContext(user, contextItems, fn)`, a dedicated
`AsyncLocalStorage` (kept separate from the user ALS so "who is running"
and "what to inject" stay orthogonal). The middleware then reads the
stash synchronously inside the middleware callback and merges the items
into `RunAgentInput.context` (plus `forwardedProps.user_id` as for all
agents).

**Credential keys are server-authoritative.** Before merging, the
middleware strips any client-sent context item whose `description`
matches a reserved dep key — the mechanical namespaces (`mcp_connectors`,
`<provider>_api_key`) plus, inside a builder-run scope, the run gate's
exact delivered set (`getReservedDepKeys()`, which covers multi-field
contract deps like `x_consumer_key`). Those keys reach the backend as
dependencies the dispatcher trusts, so a client-supplied value would
bypass the run gate's org scoping entirely (SSRF / credential
injection). The stash is appended last, so server-resolved items win
collisions. Arbitrary non-reserved client context still flows. This
applies to EVERY agent, builder or not.

## Platform-key quota — `lib/ratelimit/platform-quota.ts`

`consumePlatformKeyQuota(userId, max)` — a per-user counter over the
same sliding-window store as every other limit (in-memory,
single-instance; swap for Redis when multi-instance). Rolling 24h
window (matches the catalog daily-quota window), stable key
`platformKeyDaily:{userId}` so it can't collide with a named limit.

- Consumed after the run is admitted past the concurrent cap — a run
  that fails mid-flight still counts (the platform key was spent); a run
  refused by the gate phase or 429'd at the concurrent cap does not
  (requirement checks run before slot acquisition, quota consumption
  after it).
- `max` comes from the plan's `platformDailyQuota` (null/unlimited is
  short-circuited by the caller).
- `resetAt` = when the oldest run in the window falls out; the 402
  surfaces it as a countdown.

## BYOK credentials — `lib/credentials/credential-store.ts`

The runner's per-user keys for LLM providers and keyed tools. This is
where the "one rule" is satisfied: agent definitions declare
requirements; runners keep their keys here.

- **Catalog — derived, never hardcoded** (`lib/credentials/
  catalog.ts`): the provider list comes from the agent builder service at
  request time. LLM providers are the distinct `provider`s in
  `GET /platform/models` (keyless providers like ollama are skipped —
  nothing to save); tool providers come from the tools catalog's
  **`toolkit` slug**, with the mechanical `<provider>_api_key` dep-key
  derivation as the fallback for slug-less shapes. Each entry carries
  `kind` (drives the run gate: llm keys satisfy model requirements, tool
  keys satisfy tool requirements), `keyName` (the first credential's
  AG-UI context dep key — the AgentOS dispatcher reads it), `label`
  (prettified from the slug — no hardcoded label map), and **`fields`**
  — the named constructor arguments the connect form renders
  (`{key, label}[]`; multi-credential toolkits list several, their dep
  keys follow `<provider>_<field>`). Adding a tool or model provider to
  the platform automatically adds it here. When the platform is
  unreachable, `fetchCredentialsCatalog` degrades to
  `{catalog: null, catalogError}` — never throws, so saved rows still
  render.
- **The store is catalog-agnostic:** it accepts any slug-shaped provider
  (`providerSchema` is a loose slug regex) and a `kind` the route passes
  from the catalog. This is what makes provider removal graceful — see
  the DELETE semantics below.
- **Write-only surface:** `GET /api/credentials` returns field NAMES
  only (`hasKey: true` + `fields: string[]` + `updatedAt`) alongside the
  live derived catalog (`catalog: null` + `catalogError` when the
  platform is unreachable — saved rows always render from the local DB,
  only new keys are blocked); the plaintext is accepted on `PUT` and
  never returned — same boundary discipline as `agents.jwtSecret` and
  connector tokens. `PUT` takes `{provider, fields: {name: value}}` and
  is **fail-closed** on three counts: the provider must exist in the
  LIVE catalog (a stale/offline platform → 503, no key saved), unknown
  field names are rejected (a typo would silently never deliver, even
  blank ones), and the saved map must cover the full contract — a
  partial contract would pass the run gate and fail mid-run. The save
  is all-or-nothing per provider. **Completeness is position-aware:**
  for a NEW provider every declared field must be submitted non-empty;
  for an UPDATE blank/omitted fields KEEP the stored values
  (`getCredentialDecrypted` provides the merge source — an undecryptable
  row is treated as absent, forcing full re-entry), so rotating one
  field of a toolkit doesn't require re-typing the rest. A wholly-blank
  update is rejected (the schema requires ≥1 non-blank value) — a no-op
  write would silently look like a rotation.
- **AES-256-GCM at rest** (`enc:v1:<iv>:<ciphertext>:<tag>` via
  `lib/crypto/encrypt.ts`, encrypted at the write boundary — same
  mechanism as agent JWT secrets; plaintext fallback exists only in solo
  mode (`AUTH_DISABLED=true`) — boot refuses without `DB_ENCRYPTION_KEY`
  everywhere else). A failed decrypt
  (rotated key) logs and treats the key as absent.
- **Per-run delivery:** the decrypted field maps (`getCredentialSecrets`
  → `Record<provider, Record<field, secret>>`) are consumed exclusively
  by the run path and delivered as AG-UI context items (one per contract
  dep key) — never persisted AgentOS-side, never cached agent-side.
  Rotating a credential = saving the fields again; the very next run
  uses the new values.
- **Per-user scoping:** rows are keyed `UNIQUE (user_id, provider)`;
  no FK to the Better Auth runtime table (same convention as
  `agents.org_id`), deletion cleanup is app-side.
- **Deletion never locks a key in:** `DELETE /api/credentials/[provider]`
  accepts ANY saved provider string — including one that has since left
  the platform catalog (the UI flags it "No longer supported" but the
  delete button stays active). 404 only when nothing is saved for that
  provider. The route is not gated on the platform being reachable —
  deletion is a local-DB operation.
- Rate-limited via the `credentialMutate` bucket (20/min).

The builder page surfaces the key state as badges (model/tool rows) and
inline connect forms — one password input per field of the provider's
contract, save gated on every field being filled (a partial contract
can't be saved). The dedicated **`/app/credentials` ("API keys") page**
(`components/credentials-page.tsx`, linked from the account menu) is the
management surface: saved rows always render (multi-field rows show the
field count) and carry an **Edit** button that opens the contract's form
in place (one row edits at a time; blank inputs mean "keep the current
value" — the row's Save enables once ≥1 field is filled; rows flagged
"No longer supported" hide Edit, since their contract no longer exists);
add-rows come from the live catalog per request (no cache) and also
include providers whose saved fields no longer cover the contract (the
platform added a field → "incomplete — add the missing fields"
re-connect path); when the platform is unreachable a banner explains
that saved keys are unaffected and only new keys are blocked; a saved
provider that left the catalog shows "No longer supported" and stays
deletable.

## Connectors — `lib/connectors/connector-store.ts`

The org-level MCP server registry ("connect an MCP server"). Admins
configure once per org; builder agents reference connectors **by stable
id** (`AgentRequirements.connectors` holds `{id, name}` pairs — the id is
the stable reference, the name is display-only), and
the run path delivers `{connector_id: {token}}` per-run as the
`mcp_connectors` context item — **no URLs on the wire**. Attach URLs
resolve server-side from the platform's connector registry
(`platform_connector`): the platform stores the id→URL mapping (pushed
and verified at save time), the wire carries only tokens, and a
connector id the component's config doesn't declare is refused
(fail-closed) — see `lib/agents/run-gate.ts` and the security docs.

- **Org-scoped:** rows keyed `UNIQUE (org_id, name)`. Writes are
  org-admin gated (`canManageAgents`); reads are member-accessible so
  the builder's connector palette can render. `GET /api/connectors`
  never returns tokens (`hasToken` booleans only).
- **Token semantics on PUT:** omitted → preserve the stored token
  (edit-URL-without-retyping-secret); `""` → clear it; string →
  encrypt + store. Implemented in the SQL upsert (CASE on the raw
  param); the admin form mirrors it (blank field = omit, "Clear token"
  checkbox = `""`).
- **Name vs id:** the org-facing **name** is the human reference
  (URL/payload-safe pattern `^[a-z0-9][a-z0-9_-]*$` (case-insensitive),
  max 100, immutable after creation — renames create a new connector). The
  **id** (server-generated 12-hex) is what agent configs, the wire
  payload, and the platform registry key on. Both the name and the URL
  schemas are single-sourced from the connector store and enforced at
  the route's input boundary (before the SSRF guard and the
  platform-registry push): a non-slug name or non-http(s) URL is a
  clean 400 with no side effects, never a completed push that the
  store then rejects (which would orphan a registry entry). URLs are
  http(s)-only
  (`file:`/`ftp:`/`data:` have no legitimate use — they're fetched by
  the AgentOS at run time) **and** must pass `assertSafeUrl` — private/
  internal addresses are a 400 (`ALLOW_PRIVATE_ENDPOINTS=true` opts out
  for self-host; SaaS mode hard-locks the guard on). The URL is also
  pushed to the platform registry (push-first, then the local commit).
- **Token encrypted at rest** (same AES-256-GCM mechanism); a failed
  decrypt degrades to "no auth" rather than failing the org. Tokens are
  never stored platform-side.
- **Delete** confirms the builder-agent breakage (the run-gate copy
  agents hit after a connector they use is removed: "an org admin needs
  to add it before it can run" — the gate 402s).
- Rate-limited: writes via the `connectorMutate` bucket (20/min), reads
  via `agentRead` (60/min).
- **AgentOS-side enforcement:** the builder also writes the referenced
  connector **ids** into the stored component config; the dispatcher
  refuses wire `mcp_connectors` keys outside that list (fail-closed,
  warning + skip). Config carries ids only — never URLs or tokens.
- **Upgrade note (pre-registry agents):** components created before the
  connector registry carry connector *names* in their stored config.
  After the registry redesign deploys, the wire carries ids and the
  dispatcher filters against the declared list — such agents silently
  run without their connectors until re-saved in the builder. If you
  upgrade a deployment that predates the registry, re-publish
  (re-save) every builder agent that uses connectors.

The admin UI is the Connectors section on `/agents`
(`components/connectors-admin.tsx`).

## Database (migrations `0013_agent_builder.sql` + `0014_credential_fields.sql`)

- `agents` additions: `origin` TEXT NOT NULL DEFAULT `'manual'`
  (`'manual' | 'template' | 'builder'`), `author_user_id` TEXT,
  `remote_agent_id` TEXT, `requirements` JSONB, plus a partial index on
  `remote_agent_id` where not null. `author_user_id` is attribution that
  survives membership changes.
- `credentials` table: `id` PK, `user_id` (no FK — Better Auth runtime
  table), `provider` (validated app-side by zod), `kind`,
  `UNIQUE (user_id, provider)`. Migration 0014 replaced the single
  `secret` column with a `fields` JSONB map (field name → AES-256-GCM
  ciphertext) — the multi-credential model: one row per provider, each
  field encrypted individually; the backfill wraps every existing secret
  as `{"api_key": <secret>}` via `jsonb_build_object` (the injection-safe
  literal build), then drops the column.
- `connectors` table: `id` PK, `org_id`, `name`, `url`, `token`
  (ciphertext, empty = no auth), `UNIQUE (org_id, name)`.

## UI surface

- **One management page: `/agents`** (`app/agents/page.tsx`). Three agent
  kinds, one surface, the correct form per kind:
  - **Builder agents** — created and edited via the embedded builder form
    (`components/builder/builder-form.tsx`, extracted from the old
    standalone page; the `/app/builder` routes were removed). The add
    panel defaults to "Create a new agent"; org admins can flip the panel
    to "Connect an existing agent" (custom endpoints). Members always get
    the builder form — building is member-accessible.
  - **Custom endpoint agents** — the endpoint/JWT inline form, org-admin
    gated (the backend `canManageAgents` on POST/PATCH/DELETE enforces
    the same line).
  - **Catalog installs** — curator-managed; no local edits ("Managed by
    catalog" in the Endpoint column). Builder rows show "Built with the
    agent builder" there; builder rows carry no Test button (no
    client-visible endpoint to probe).
- **Access model:** every signed-in member can open `/agents`, see the
  workspace's agents, and edit/delete **their own** builder agents
  (author-only — the backend PATCH/DELETE 403 anyone else; org admins
  get no override). Custom agents, connector management, and deletes are
  org-admin gated.
- The builder form: name/description/instructions + model picker
  (populated from `GET /api/models` — the server-side proxy to the
  AgentOS `/platform/models` catalog, grouped by provider, defaulting to
  the first model — builder runs are 100% BYOK, there is no
  platform-key preference) + tool palette (loaded from `GET /api/tools`
  — the server-side proxy to the AgentOS `/platform/tools` catalog —
  with key-state badges) + connector palette. `GET /api/credentials`
  and `GET /api/connectors` feed the badges.
- **Tool palette rows** (`BuilderToolRow` in the form component) are
  two-line: the first line carries the checkbox, the full untruncated
  tool name, and the key badge (pinned right, wrapping to its own line
  on narrow rows); the second carries the description clamped at two
  lines with a "Show more / Show less" toggle that renders only when
  the text actually overflows (the shared `ExpandableText`). Checked
  rows get a blue border — the same visual language as the
  platform-admin `ToolRow`. Each row is still one `<label>` (click
  anywhere toggles; the Show more/less and Connect buttons are
  interactive content, which label activation skips), and the checkbox
  carries an explicit `aria-label` so its accessible name is the tool
  name rather than the whole description read aloud.
- **Palette search + honest cap:** a search input filters the rendered
  rows (case-insensitive on label + description — descriptions carry
  the arg/return docs, so arg-name searches hit) with its own "No tools
  match" state, distinct from the empty-catalog copy. Filtering is
  display-only: selections live in the form state, so a row hidden by
  the search keeps its slot in the payload. The cap hint counts live
  ("3 of 10 selected"), and at the cap the unchecked checkboxes disable
  with an explanatory `title` instead of the click silently no-op'ing.
  Rows render in a deterministic `(toolkit, label)` order (`sortTools`)
  regardless of the upstream allowlist's append order.
- **Disabled state:** when `GET /api/models` or `GET /api/tools` fails
  because the platform is unreachable, the form renders a notice banner
  and disables submit — the definition would be validated against a
  stale palette otherwise.
- **Empty ≠ unreachable:** the platform catalogs are **empty by default**
  — the AgentOS exposes nothing until the platform admin enables
  providers/toolkits on `/admin/platform`, so a reachable-but-empty
  catalog is a *configuration* state with its own copy ("The agent
  builder has no tools yet — a platform admin enables them in Models &
  tools."), never the error banner. Create stays disabled
  while the model catalog is empty (the model field is required); edit
  is unaffected — the model is only sent when it changes. Copy always
  says "the agent builder", never "your" — SaaS end users don't own the
  builder infrastructure, and possessives imply they do.
- **Edit mode:** prefills from the requirements snapshot, including the
  **current instructions** — the instructions are never stored locally;
  GET /api/agents/[id] reads them back from the AgentOS component config
  for builder agents (best-effort: an unreachable platform omits the
  field, and the blank-preserve PATCH contract keeps the stored value).
  Instructions are not a secret — the owner sees and tweaks them like
  every other field. Non-author/non-builder agents can't reach the edit
  form (the /agents table only renders Edit for the author; the backend
  403s the same).
- **Plan-cap 402:** the create route's `PLAN_AGENT_LIMIT` 402 opens the
  upgrade dialog for admins (checkout is org-admin gated) and shows the
  error + a pointer to their org admin for members.
- A successful save navigates to `/app?agent={id}` — the agent is
  immediately runnable in chat (subject to the run gate). Delete stays
  on the page and refreshes the table.
- The chat sidebar has one agent entry point: a plus-glyph "Add agent"
  icon (member-visible) linking to `/agents?add=1` — the add panel open,
  builder form by default.
- **`/admin/platform`** (`app/admin/platform/page.tsx` +
  `components/platform-admin.tsx`) — the platform catalog admin page
  ("Models & tools"); platform-admin gated, linked from the builder
  (admin-only) and from `/admin`'s header. See the section below.

## Not in Phase 1

- **Publishing** — builder agents are org-scoped; there is no catalog
  publishing (making a builder agent installable by other orgs is
  Phase 3).
- **The platform-key free tier** — dormant until publishing: the tier
  flags, `platformFallback`, and the daily platform-key quota machinery
  all stay wired (snapshot fields, quota route wiring, plan limits) but
  builder runs are 100% BYOK today; the run gate ignores the tier
  fields and the quota phase never fires.
- **Knowledge** — attaching knowledge/data sources to builder agents is
  Phase 2.

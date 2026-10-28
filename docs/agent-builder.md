# Agent Builder

Phase 1 "create your own agents" — any signed-in org member can build an
agent on the platform AgentOS service (identity/name, model picker, tool
palette, MCP connectors) without touching the admin `/agents` page. The
definition lives on the shared multi-tenant AgentOS; tackui keeps a normal
agent row that resolves to it at run time. This doc covers the builder
subsystem: the two-place agent shape, the create/update flows, the run
gate, per-run dependency delivery, and the BYOK credentials + connector
stores. For the general registry mechanics see
[agent-registry.md](./agent-registry.md); run-path security in
[security.md](./security.md).

## The one rule

**The agent declares requirements; whoever runs it brings the
credentials — at run time, never stored in the definition.**

A builder agent's definition carries only *what it needs*: a model
(provider + id + platform tier), tool names with their credential
requirements, and connector names. Keys and tokens are never written
into the definition. At run time the runner's own BYOK keys (per-user
`credentials` table) and the org's connector config (`connectors`
table) are resolved fresh and delivered per-run as AG-UI context items.
Nothing is cached agent-side, and nothing is persisted on the AgentOS.

## Where an agent lives (two places, two repos)

A builder agent exists in two stores at once:

1. **The AgentOS component store** — the versioned config the dispatcher
   rehydrates at run time (the "brain"). Lives in a separate repo
   (`agent-warehouse`, `agents/platform-os/`). tackui is a client of
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
- `AGENTOS_BASE_URL` — the platform-os deployment, no trailing slash.
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
  only. This flag drives the run gate's platform-key quota exemption, so
  a forged `platformTier: true` would let a non-tier model run free on
  the platform key — it must never come from the wire.
- **Tool `parameters`** (json-schema) come from the AgentOS tools
  catalog (`GET /platform/tools`); the client sends tool names only,
  validated against the live catalog at create/update time (an unknown
  name is a 400 — a stale client is user input).
- **Connector names** are validated against the org's connector store at
  create time (a typo'd name must not be storable); the run gate
  re-checks at run time.

An unknown model (`provider:id` not in the catalog) is a
`BuilderValidationError` → 400. The picker is populated from the same
endpoint, so a mismatch means a stale client or tampering.

## Wire contract with the AgentOS

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

## The tool palette — the platform tools catalog

The tools a builder may attach are NOT hardcoded in tackui. They come
from the AgentOS `GET /platform/tools` catalog (env allowlist
`PLATFORM_TOOLS` merged with the registry function metadata), proxied to
the browser via `GET /api/tools`. Adding a tool = a registry import +
one allowlist line on the AgentOS — zero tackui code, not even env.

Per tool the catalog carries `name`, `label`, `description`,
`requiresKey` (the AG-UI context dep key the runner delivers — the
credentials store's provider id derives from it via the
`<provider>_api_key` convention), and `platformFallback` — computed
AgentOS-side: the tool declares a `fallback=ENV` entry AND that env key
is actually set on the deployment.

**`platformFallback` semantics:** the AgentOS deployment carries an env
key for the tool. When the runner has no key, the platform key serves
the run and the platform-key daily quota applies (SaaS) — or, on
self-host, the operator's env key serves it silently. `false` means the
runner MUST bring the key or the run gate 402s (both modes).

Tackui never re-derives `platformFallback` — the snapshot stores what
the catalog said at create/update time, and the run gate reads only the
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
   orphan half an agent. 502/503 surfaces via `agentosErrorResponse`.
5. Success → `201 { PublicAgent }`.

`requirements` is written at create from the definition tackui itself
built: `{ model: {provider, id, platformTier}, tools: [{name,
requiresKey}], connectors: [names] }` (`buildRequirements()`). The
AgentOS stored config is the source of truth; the snapshot only powers
the pre-run gate so run requests need no AgentOS round-trip.

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
- Config changes (instructions/model/tools/connectors) re-derive
  platformTier + tool parameters (same trust posture as create); model,
  tools, connectors replace wholesale when present. If the agent's
  stored model has left the catalog, a config patch can't proceed
  without re-resolving it (400).
- **Two-phase update, local row first, compensating revert** when the
  AgentOS half fails — the local projection never leads the AgentOS.
  Config publishes are guarded with the component's `current_version`
  as `latest_version`; a 409 from the AgentOS means a concurrent edit
  landed first (reload + retry). One `GET /components/{id}` before any
  writes serves as the guard source for both writes.
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
their own gates in `checkCatalogRunGates`). It does three things:

### 1. Gate — one aggregated 402

All checkable blockers are collected into a **single** 402
(`AGENT_REQUIREMENTS_MISSING`, `error` = the joined human explanations)
so a user sees everything wrong at once, and so a refused run never
consumes quota or a concurrent slot (the gate runs before quota
consumption and before `acquireConcurrent`):

- **Model:** the model is not platform-tier and the runner has no key
  for its provider → "add your own {OpenAI|OpenRouter} key to run it."
- **Tool:** a keyed tool with no runner key **and** no platform
  fallback → "add your own {Tavily} key to run it."
- **Connector:** a required org MCP connector is not configured →
  "an org admin needs to add it before it can run." Missing connectors
  are always blockers — there is no platform fallback for connector
  credentials in any mode.

Requirement 402s apply in **both** SaaS and self-host modes. Only the
platform-key quota (next section) is SaaS-only.

### 2. Resolve dependencies — per-run AG-UI context

Collects the context items the run needs, shape `{description, value}`
(both strings — the AG-UI `Context` wire type):

| dep key | value |
| --- | --- |
| `openai_api_key` / `openrouter_api_key` | the runner's decrypted BYOK key (when the model needs one) |
| `tavily_api_key` | the runner's Tavily key (when a keyed tool runs) |
| `mcp_connectors` | JSON string `{name: {url, token}}` for the org's configured connectors referenced by the agent |

These keys are **server-resolved only** — the registry middleware strips
any client-sent context item with a reserved dep key before merging the
stash (see "Credential keys are server-authoritative" below). The
AgentOS enforces the same boundary from its side: the dispatcher only
attaches wire `mcp_connectors` whose names the component's stored config
declares, so the namespace stays closed even if a tackui bug reopens it.

**Key precedence: the runner's stored key WINS.** A runner key is
delivered as a context item; the platform env key is only the fallback
when the runner has none (Tavily). Platform keys are NEVER injected as
context items — when the runner has no key, the AgentOS deployment's own
env fallback serves the dependency (e.g. `TAVILY_API_KEY` exists
AgentOS-side for tools; platform-tier "mini" models run on the platform
key, which is what makes them tier-flagged). Dependencies resolve in
both modes so BYOK delivery works everywhere.

### 3. Consume the platform-key quota (SaaS-only)

When the run is platform-key (some dependency resolves to the platform
key — a mini-tier model or a tool fallback), it counts against the
org plan's `platformDailyQuota` (see
[saas-mode.md](./saas-mode.md#plan-enforcement-saas-only)). Over quota →
402 `PLATFORM_QUOTA_EXCEEDED` with the reset countdown (free plans get
an "Upgrade to Pro for more usage." clause). **BYOK runs are exempt** —
they cost the platform ~nothing. The quota is consumed only when a
platform key is actually used: a runner key present for every dependency
⇒ exempt. On self-host the quota check short-circuits entirely (the
operator pays the platform key bill themselves; the self-host sentinel
is `null` anyway).

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
matches the reserved dep-key namespaces (`mcp_connectors`,
`<provider>_api_key`) — those keys reach the backend as dependencies the
dispatcher trusts, so a client-supplied value would bypass the run
gate's org scoping entirely (SSRF / credential injection). The stash is
appended last, so server-resolved items win collisions. Arbitrary
non-reserved client context still flows. This applies to EVERY agent,
builder or not.

## Platform-key quota — `lib/ratelimit/platform-quota.ts`

`consumePlatformKeyQuota(userId, max)` — a per-user counter over the
same sliding-window store as every other limit (in-memory,
single-instance; swap for Redis when multi-instance). Rolling 24h
window (matches the catalog daily-quota window), stable key
`platformKeyDaily:{userId}` so it can't collide with a named limit.

- Consumed at run start — a run that fails mid-flight still counts (the
  platform key was spent); a run blocked by the gate before it starts
  does not (the gate runs before quota consumption).
- `max` comes from the plan's `platformDailyQuota` (null/unlimited is
  short-circuited by the caller).
- `resetAt` = when the oldest run in the window falls out; the 402
  surfaces it as a countdown.

## BYOK credentials — `lib/credentials/credential-store.ts`

The runner's per-user keys for LLM providers and keyed tools. This is
where the "one rule" is satisfied: agent definitions declare
requirements; runners keep their keys here.

- **Catalog — derived, never hardcoded** (`lib/credentials/
  catalog.ts`): the provider list comes from the AgentOS platform at
  request time. LLM providers are the distinct `provider`s in
  `GET /platform/models`; tool providers derive from the tools catalog's
  `requiresKey` dep keys (the `<provider>_api_key` convention). Each
  entry carries `kind` (drives the run gate: llm keys satisfy model
  requirements, tool keys satisfy tool requirements), `keyName` (the
  AG-UI context dep key the AgentOS dispatcher reads), and `label`
  (prettified from the slug — no hardcoded label map). Adding a tool or
  model provider to the platform automatically adds it here. When the
  platform is unreachable, `fetchCredentialsCatalog` degrades to
  `{catalog: null, catalogError}` — never throws, so saved rows still
  render.
- **The store is catalog-agnostic:** it accepts any slug-shaped provider
  (`providerSchema` is a loose slug regex) and a `kind` the route passes
  from the catalog. This is what makes provider removal graceful — see
  the DELETE semantics below.
- **Write-only surface:** `GET /api/credentials` returns existence
  booleans only (`hasKey: true` + `updatedAt`) alongside the live
  derived catalog (`catalog: null` + `catalogError` when the platform
  is unreachable — saved rows always render from the local DB, only new
  keys are blocked); the plaintext is accepted on `PUT` and never
  returned — same boundary discipline as `agents.jwtSecret` and
  connector tokens. `PUT` is **fail-closed**: the provider must exist in
  the LIVE catalog (a stale/offline platform → 503, no key saved).
- **AES-256-GCM at rest** (`enc:v1:<iv>:<ciphertext>:<tag>` via
  `lib/crypto/encrypt.ts`, encrypted at the write boundary — same
  mechanism as agent JWT secrets; plaintext fallback when
  `DB_ENCRYPTION_KEY` is unset, with a loud warning). A failed decrypt
  (rotated key) logs and treats the key as absent.
- **Per-run delivery:** the decrypted key is consumed exclusively by the
  run path (`getCredentialSecrets` batch lookup) and delivered as an
  AG-UI context item — never persisted AgentOS-side, never cached
  agent-side. Rotating a key = setting it again; the very next run uses
  the new value.
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
inline "connect a key" rows — front-loading the run-gate 402s so the
user knows before the first run. The dedicated **`/app/credentials`
("API keys") page** (`components/credentials-page.tsx`, linked from the
account menu) is the management surface: saved rows always render;
add-rows come from the live catalog per request (no cache); when the
platform is unreachable a banner explains that saved keys are unaffected
and only new keys are blocked; a saved provider that left the catalog
shows "No longer supported" and stays deletable.

## Connectors — `lib/connectors/connector-store.ts`

The org-level MCP server registry ("connect an MCP server"). Admins
configure once per org; builder agents reference connectors **by name**
(`AgentRequirements.connectors`), and the run path resolves each name to
its URL + token and delivers them per-run as `mcp_connectors` JSON —
the AgentOS never stores connector config itself.

- **Org-scoped:** rows keyed `UNIQUE (org_id, name)`. Writes are
  org-admin gated (`canManageAgents`); reads are member-accessible so
  the builder's connector palette can render. `GET /api/connectors`
  never returns tokens (`hasToken` booleans only).
- **Token semantics on PUT:** omitted → preserve the stored token
  (edit-URL-without-retyping-secret); `""` → clear it; string →
  encrypt + store. Implemented in the SQL upsert (CASE on the raw
  param); the admin form mirrors it (blank field = omit, "Clear token"
  checkbox = `""`).
- **Name is the reference key:** URL/payload-safe pattern
  (`^[a-z0-9][a-z0-9_-]*$`), max 100 — it's used in agent definitions
  and the AG-UI context payload. Renames create a new connector and
  orphan the agents referencing the old name, so the name is immutable
  in edit mode (the admin form enforces this). URLs are http(s)-only
  (`file:`/`ftp:`/`data:` have no legitimate use — they're fetched by
  the AgentOS at run time) **and** must pass `assertSafeUrl` — private/
  internal addresses are a 400 (`ALLOW_PRIVATE_ENDPOINTS=true` opts out
  for self-host; SaaS mode hard-locks the guard on).
- **Token encrypted at rest** (same AES-256-GCM mechanism); a failed
  decrypt degrades to "no auth" rather than failing the org.
- **Delete** confirms the builder-agent breakage (the run-gate copy
  agents hit after a connector they use is removed: "an org admin needs
  to add it before it can run" — the gate 402s).
- Rate-limited: writes via the `connectorMutate` bucket (20/min), reads
  via `agentRead` (60/min).
- **AgentOS-side enforcement:** the builder also writes the referenced
  connector names into the stored component config; the dispatcher
  refuses wire `mcp_connectors` keys outside that list (fail-closed,
  warning + skip). Config carries names only — never URLs or tokens.

The admin UI is the Connectors section on `/agents`
(`components/connectors-admin.tsx`).

## Database (migration `0013_agent_builder.sql`)

- `agents` additions: `origin` TEXT NOT NULL DEFAULT `'manual'`
  (`'manual' | 'template' | 'builder'`), `author_user_id` TEXT,
  `remote_agent_id` TEXT, `requirements` JSONB, plus a partial index on
  `remote_agent_id` where not null. `author_user_id` is attribution that
  survives membership changes.
- `credentials` table: `id` PK, `user_id` (no FK — Better Auth runtime
  table), `provider` (validated app-side by zod), `kind`, `secret`
  (AES-256-GCM ciphertext), `UNIQUE (user_id, provider)`.
- `connectors` table: `id` PK, `org_id`, `name`, `url`, `token`
  (ciphertext, empty = no auth), `UNIQUE (org_id, name)`.

## UI surface

- `/app/builder` (create) and `/app/builder/[id]` (edit) —
  member-accessible pages (`app/app/builder/*`), both rendering
  `components/builder/builder-page.tsx` with `mode: "create" | "edit"`.
- The builder page: name/description/instructions + model picker
  (populated from `GET /api/models` — the server-side proxy to the
  AgentOS `/platform/models` catalog, grouped by provider, defaulting to
  a platform-tier model so the default selection needs no BYOK) + tool
  palette (loaded from `GET /api/tools` — the server-side proxy to the
  AgentOS `/platform/tools` catalog — with key-state badges) +
  connector palette. `GET /api/credentials` and `GET /api/connectors`
  feed the badges.
- **Disabled state:** when `GET /api/models` or `GET /api/tools` fails
  because the platform is unreachable, the page renders a notice banner
  and disables the form (submit disabled) — the definition would be
  validated against a stale palette otherwise.
- **Empty ≠ unreachable:** the platform catalogs are **empty by default**
  — the AgentOS exposes nothing until its operator sets
  `PLATFORM_MODELS`/`PLATFORM_TOOLS` (see the platform-os README), so a
  reachable-but-empty catalog is a *configuration* state with its own
  copy ("The agent platform exposes no tools yet. The platform operator
  can add them via PLATFORM_TOOLS…"), never the error banner. Create
  stays disabled while the model catalog is empty (the model field is
  required); edit is unaffected — the model is only sent when it
  changes. Copy always says "the agent platform", never "your" — SaaS
  end users don't own the platform, and possessives imply they do.
- **Edit mode:** prefills from the requirements snapshot; instructions
  start blank with "(leave blank to keep current)" semantics. Non-author
  / non-builder agents show a 404-style state (the backend PATCH/DELETE
  403/404s the same).
- The create page also lists the signed-in member's own builder agents
  ("Your agents", filtered to `origin === "builder" &&
  authorUserId === currentUserId`) with Edit links to `/app/builder/[id]`.
- **Plan-cap 402:** the create route's `PLAN_AGENT_LIMIT` 402 opens the
  upgrade dialog for admins (checkout is org-admin gated) and shows the
  error + a pointer to their org admin for members.
- A successful save redirects to `/app?agent={id}` — the agent is
  immediately runnable in chat (subject to the run gate).
- The chat sidebar links to `/app/builder` (a wrench-glyph "Create
  agent" button in the Agents header — member-accessible, mirroring the
  "+" admin link).

## Not in Phase 1

- **Publishing** — builder agents are org-scoped; there is no catalog
  publishing (making a builder agent installable by other orgs is
  Phase 3).
- **Knowledge** — attaching knowledge/data sources to builder agents is
  Phase 2.

# Security

The security model: SSRF guard, security headers, rate limiting, and the
related hardening details. Encryption-at-rest for agent JWT secrets is
covered in [agent-registry.md](./agent-registry.md#encryption-at-rest-for-agent-jwt-secrets);
auth internals in [auth-and-orgs.md](./auth-and-orgs.md).

## SSRF guard

`lib/net/safe-fetch.ts` — `assertSafeUrl()` blocks endpoints that resolve to
loopback/private/link-local/multicast IPs (IPv4 + IPv6, including
IPv4-mapped), preventing server-side requests to internal services or
cloud-metadata endpoints.

- **Applied on every route that accepts an endpoint URL:** `POST /api/agents`
  and `PATCH /api/agents/[id]` before persisting the endpoint; the
  reachability probe (`POST /api/agents/reachability-probe`) before fetching;
  catalog template create/PATCH. The install route does not re-check — it
  copies the endpoint from the already-validated template row.
- **Re-guarded at request time (tenant-supplied endpoints):** run-time
  traffic for manual/template agents goes through `fetchGuardedRedirects`
  (lib/net/safe-fetch.ts), which re-runs the guard on the request URL and
  follows redirects MANUALLY with the guard re-run on EVERY hop (capped at
  5). A public endpoint that 302s to an internal address must not turn a
  validated URL into a pass-through — Node's `fetch` follows redirects
  silently by default. A 3xx without a `Location` header is returned
  as-is. This is the per-run guarantee: network reality drifts (DNS
  rebinding, a template edited to a new endpoint) and every request is
  checked at the moment it is made. The listing path (`getAgents`)
  deliberately does NOT re-check — an agent whose endpoint became
  unresolvable must fail that run with an honest error, not vanish from
  the runtime's agent list (which crashed CopilotKit's `useAgent` on the
  whole chat page).
- **Builder agents are exempt from the run-time guard — by trust, not
  oversight.** The SSRF guard defends against TENANT-supplied URLs; a
  builder agent's endpoint is recomputed from `AGENTOS_BASE_URL` at
  resolution time — operator infrastructure, the same trust tier as the
  DB connection string. Under SaaS mode the platform lives on a PRIVATE
  network (Railway private service), which the force-on guard would
  refuse by design — routing builder runs through the guard made every
  builder run die with `UnsafeUrlError: hostname resolves to a private
  address`. Builder runs use plain `fetch`; manual/template agents keep
  the guarded wrapper. A tenant still cannot reach the private network
  through the guard: every URL they can influence (manual endpoints,
  template endpoints, probe URLs) is guarded at save time and at request
  time.
- **Fail-closed DNS:** an unresolvable hostname is REFUSED (`UnsafeUrlError`),
  not passed through — the old fail-open behavior was a rebinding window
  (an attacker's authoritative server can refuse the guard's lookup and
  resolve public for the real fetch).
- **Blocked ranges** (beyond RFC 1918/loopback/link-local/multicast):
  carrier-grade NAT 100.64.0.0/10 (cloud internal services), IETF protocol
  assignments 192.0.0.0/24, benchmark 198.18.0.0/15, TEST-NET documentation
  ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). IPv4-mapped IPv6
  is decoded in ANY textual form (dotted `::ffff:127.0.0.1` and hex
  `::ffff:7f00:1` alike) via a full 8-group expander; an unparseable IPv6
  literal is refused (fail-closed).
- **Opt-in:** `ALLOW_PRIVATE_ENDPOINTS=true` for self-hosters running backends
  on the same host. Defaults to `false`.
- **SaaS hard-locks it ON:** `SSRF_GUARD_FORCE_ON` (= `SAAS_MODE`) prevents a
  misconfigured `ALLOW_PRIVATE_ENDPOINTS` from exposing the host's private
  network to tenants. `SSRF_REJECTION_MESSAGE` is mode-aware: SaaS users get
  "not permitted on the hosted service", self-hosters get the opt-in hint.
- **PATCH semantics:** the guard only fires when the `endpoint` field is in
  the body — editing other fields on an existing private-endpoint agent works
  without the flag. The request-time guarding above applies the same rule
  to runs regardless of how the row was written.
- **Error masking:** probe error messages are masked in the response (raw DNS
  errors can leak internal hostnames); the full error is logged server-side.
- **AgentOS error sanitization:** `AgentosError` (lib/agents/builder.ts) never
  carries internal platform names, request framing, or raw response bodies in
  its `message` — SaaS users see "The agent builder is unavailable right now —
  please try again shortly." when the service is down, not "AgentOS is unreachable
  (fetch failed)". The upstream validation text rides in a separate `detail`
  field that only admin-gated routes (`/api/admin/platform/*`) surface; see
  docs/agent-builder.md for the contract tests.

## Credentials & connectors stores (builder subsystem)

The agent builder
([agent-builder.md](./agent-builder.md#the-one-rule)) introduces two
secret stores whose boundaries are worth stating explicitly:

- **BYOK credentials** (`lib/credentials/credential-store.ts`, migration
  0013) — per-user keys for LLM providers and keyed tools. **AES-256-GCM
  at rest** (`enc:v1:<iv>:<ciphertext>:<tag>` via `lib/crypto/encrypt.ts`,
  encrypted at the write boundary; plaintext fallback when
  `DB_ENCRYPTION_KEY` is unset, same mechanism as agent JWT secrets).
  **Write-only surface:** `GET /api/credentials` returns field NAMES
  only (plus a `hasKey` boolean); the plaintext is accepted on PUT and
  never returned — same boundary discipline as `agents.jwtSecret`. PUT
  update semantics mirror the connectors' position-aware merge: blank or
  omitted fields keep the stored values when a row exists; a new
  provider requires the full contract (all-or-nothing). The
  decrypted key is consumed exclusively by the run path and delivered
  per-run as an AG-UI context item — never persisted AgentOS-side, never
  cached agent-side. Rows are scoped `UNIQUE (user_id, provider)`; no FK
  to the Better Auth runtime table (same convention as `agents.org_id`).
- **Connectors** (`lib/connectors/connector-store.ts`) — org-scoped MCP
  server registry. Writes are org-admin gated (`canManageAgents`); reads
  are member-accessible (rate-limited via the `agentRead` bucket) so the
  builder's connector palette can render. Tokens are write-only
  (`hasToken` booleans in GET responses) and encrypted at rest (same
  AES-256-GCM mechanism). PUT token semantics: omitted → preserve the
  stored token, `""` → clear it, string → encrypt + store. The connector's
  server-generated **id** is the reference key in agent definitions and on
  the run wire (names are org-scoped and collide across orgs; ids are
  globally unique).
  **The connector URL runs `assertSafeUrl`** — an admin pointing a
  connector at a private/internal address is a 400 (the AgentOS fetches
  connector URLs at run time with the org's token attached; http(s)-only
  alone doesn't stop `https://169.254.169.254/`).

**The platform resolves MCP attach URLs from its own registry — never
from the run wire.** Connector create/edit **push-first-sync** the
endpoint (id + URL + label, never tokens) to the platform's connector
registry (`platform_connector` table, admin API
`GET/PUT/DELETE /platform/connectors[/{connector_id}]`, written only by
this server) BEFORE the local row is written — a failed push changes
nothing and surfaces the error, so the two stores only ever disagree in
the harmless direction (platform momentarily ahead). Deletes remove the
registry entry first too. The run wire therefore carries
`mcp_connectors: {connector_id: {token}}` — **no URLs**: a wire-supplied
URL would be an SSRF primitive (the dispatcher connecting to
attacker-chosen addresses from inside the deployment, with org tokens
attached). The dispatcher attaches via the registry's URL for the wire's
connector id, ignores any wire URL outright, and skips an unregistered
id loudly (the run proceeds without it). Agent saves re-register their
referenced connectors belt-and-braces (idempotent upserts) so a
restored platform DB can't leave saved configs pointing at lost ids.

## Run-gate 402s (builder agents)

Builder-agent runs are gated at the HTTP level in the copilotkit route
(`checkBuilderRunGate`, before anything reaches a backend and before a
concurrent slot is acquired):

- **Unsatisfiable requirements → 402** `AGENT_REQUIREMENTS_MISSING` —
  one aggregated response listing every blocker: a keyed model with no
  runner key (a keyless provider like ollama — the snapshot's
  `requiresKey: false` — never 402s; the provider is excluded from the
  credentials catalog, so demanding a key would be unsatisfiable), a
  keyed tool whose credential contract the runner can't fill, or a
  required org connector not configured. Requirement 402s apply in
  **both** SaaS and self-host modes.
- **Platform-key daily quota → 402** `PLATFORM_QUOTA_EXCEEDED` —
  SaaS-only and currently **dormant**: builder runs are 100% BYOK until
  Phase 3 publishing wakes the tier, so `platformKeyRun` is never true
  and no quota is consumed. When it wakes: runs where tackui delivers
  the platform key (instead of the runner's own) count against the
  plan's `platformDailyQuota` (see
  [saas-mode.md](./saas-mode.md#plan-enforcement-saas-only)); BYOK runs
  are exempt. Gate-blocked runs never consume quota; the quota is
  consumed only AFTER the concurrent slot is acquired (a run refused at
  the cap never burns a daily platform-key run; a run failing
  mid-flight still counts).

## SSRF guard scope on builder routes

The SSRF guard **intentionally does NOT apply** to the builder routes
(`POST/PATCH/DELETE /api/agents/builder*`) — there is no user-supplied
endpoint URL to validate. The outbound AgentOS URL is platform config
(`AGENTOS_BASE_URL`, `builderEndpoint(remoteAgentId)`), not user input,
so the guard's threat model (user-controlled URL reaching internal
services) doesn't apply. The guard still applies to every route where
the endpoint comes from the user (admin agent create/edit, the
reachability probe, catalog templates, **`PUT /api/connectors`**).

Two further lines of defense on the run path (both from the same
review that added the connector guard):

- **Credential namespace is server-authoritative** — the registry
  middleware strips any client-sent context item whose key matches a
  reserved dep key before merging in the server-resolved stash (stash
  wins collisions). Two layers: the mechanical `mcp_connectors` /
  `<provider>_api_key` namespaces (case-insensitive), plus — inside a
  gated builder run — the run gate's exact delivered dep-key set, which
  covers multi-field credential contract fields (`x_consumer_key`,
  `x_access_token`, …) the regex can't know about. A raw `context` item
  can therefore never inject a connector URL (SSRF) or a BYOK key
  (credential injection) that bypassed the run gate's org scoping —
  including under a declared name: the stash is appended last, so the
  server-resolved value for a declared connector always wins. The wire
  payload carries connector ids + tokens only (see the registry section
  above) — no URL exists on the wire to overwrite.
- **Config-declared connectors enforced AgentOS-side** — the builder
  writes the agent's connector **ids** into the stored component config;
  the dispatcher refuses wire `mcp_connectors` keys outside that list
  (fail-closed, warning + skip). Scope the claim precisely: the
  dispatcher enforces the *namespace*, not the payload — a token value is
  wire-trusted (it's the per-run credential), but the attach URL is NOT:
  it comes from the connector registry, so even a fully forged declared
  entry cannot aim the connection anywhere the org's admin didn't
  register. That's why the first wall (tackui's strip) matters less here
  than it did when URLs rode the wire — the registry closed the value
  half of the primitive.
- **Destructive runtime endpoints are unreachable** — the CopilotKit
  runtime exposes `POST /threads/clear`, which reaches the runner's
  `clearThreads()` and deletes every tenant's runs, run states, messages
  and metadata with no caller identity to scope by (the runner is
  server-side). The copilotkit route refuses it unconditionally — before
  auth, before rate-limit accounting — since nothing in the app calls it.
- **The live run stream is redacted like persistence** — the `RUN_STARTED`
  fill (emitted when the backend doesn't echo the input) copies
  `request.input`, whose context carries the gate-injected secrets; every
  live event now passes the same `redactReservedEvent` rule `storeRun`
  applies, before any subscriber sees it.

**Trust model:** org isolation is entirely tackui-side. The AgentOS is an
explicitly multi-tenant execution service with no org concept — any valid
`app:user` token can run any stored component. tackui is the policy
layer: org scoping, connector registration, run gates, and identity
minting all happen there. The dispatcher's per-run credential ContextVar
(set/reset per stream) and the session-write check (`assert_session_writable`)
keep tenants from touching each other's sessions or credentials, but the
org boundary itself — which agent belongs to whom — is tackui's job
exclusively.

## Security headers

`next.config.ts` — CSP (`'unsafe-inline'` scripts/styles, `'unsafe-eval'`
dev-only, `frame-ancestors 'none'`), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
(no geo/mic/cam/payment/usb), HSTS (prod only), `poweredByHeader: false`.

Other hardening in the same spirit:

- **`BETTER_AUTH_SECRET` enforcement** (`lib/auth/auth.ts`) — throws on boot
  if unset when `AUTH_DISABLED !== "true"` (see
  [auth-and-orgs.md](./auth-and-orgs.md#boot)).
- **Open-redirect fix** (`app/login/page.tsx`) — `safeRedirect()` validates
  the `redirect` query param is a same-origin relative path (starts with
  single `/`, not `//` or `/\`).
- **`/api/health`** (`app/api/health/route.ts`) — liveness check returning
  `200 { ok: true }`. Bypassed by `proxy.ts` cookie gate so orchestrators can
  probe without a session. Wired into `docker-compose.yml` healthcheck.
  `?deep=true` is the readiness variant: it round-trips Postgres and counts
  the applied `schema_migrations` rows (200 `{ok, db: true, migrations: n}`,
  503 `{ok: false, db: false}` when the DB is unreachable — generic error
  body, the detail is logged server-side). The proxy's flood-limit exemption
  is safe for liveness (no I/O) but not for the deep branch, so the deep
  probe rate-limits itself per client IP (30/min, `healthDeep` preset) — an
  anonymous flood of deep probes 429s like any other `/api` route. Boot
  fail-fast backs this up: migration or auth-table failure after the retry
  window exits non-zero, so a broken container reports unhealthy instead of
  serving 500s behind a green probe.
- **Session-cookie `secure` flag** pinned to `NODE_ENV === "production"`.

## Rate limiting

Two-layer rate limiting protects the server from abuse and floods.

### Layer 1 — Per-IP global flood protection (`proxy.ts`)

- 300 requests/min per IP on all `/api/*` routes (except `/api/health` which
  is unlimited, and `/api/auth/*` which has its own Better Auth limiter).
  The 300 preset is overridable at boot with `GLOBAL_IP_RATE_MAX` (a positive
  integer; see `lib/ratelimit/limits.ts` `maxFromEnv`) — for deployments where
  many humans share one public IP and the bucket sees the aggregate of all
  their traffic. Raising it weakens flood protection only for a trusted,
  single-IP deployment; there is no per-user bypass.
- Enforced in the proxy (pre-auth). IP resolution honors `CF-Connecting-IP`
  (set by Cloudflare to the real client IP — Traefik/Coolify overwrites
  `X-Forwarded-For` with the Cloudflare edge IP, splitting the counter across
  multiple edge IPs) ONLY when the topology is known to include Cloudflare:
  `SAAS_MODE=true`, or an explicit `TRUST_CF_CONNECTING_IP=true` for non-SaaS
  CF-fronted deploys. On any deployment without Cloudflare in front, the
  header is client-suppliable — an attacker hitting the origin directly could
  rotate it per request and get a fresh bucket in every IP-keyed limiter
  (flood cap, deep health probe, Better Auth's sign-in limiter) — so it is
  ignored there and resolution falls back to `X-Forwarded-For` with
  `TRUSTED_PROXY_HOPS` (the Nth-from-right entry, which a trusted proxy
  always appends the real IP to). Without the right hop count, a malicious
  client can prepend a fake IP to `X-Forwarded-For` and bypass the per-IP
  limit entirely. Better Auth's `ipAddressHeaders` mirrors the same
  conditional CF trust, so its sign-in limiter keys on the same resolved IP.
- Proxy runtime pinned to `nodejs` — the in-memory `Map` requires it.

### Layer 2 — Per-user route-level limits (`lib/ratelimit/`)

Enforced in route handlers, post-auth, keyed by `user.id`. Limits (see
`lib/ratelimit/limits.ts`):

| Route | Limit | Concurrent |
| --- | --- | --- |
| `/api/copilotkit/*` (POST runs only) | 20/min per user | 3 concurrent run streams per user |
| `/api/agents/reachability-probe` | 30/min per user | — |
| `/api/agents` POST + `/api/agents/[id]` PATCH/DELETE | 10/min per user | — |
| `/api/agents` GET + `/api/agents/[id]` GET | 60/min per user | — |
| `/api/threads/[id]` PATCH/DELETE | 30/min per user | — |
| `/api/auth/can-manage-agents` GET | 60/min per user (shares `agentRead` bucket) | — |
| `/api/credentials` GET + `/api/connectors` GET | 60/min per user (shares `agentRead` bucket) | — |
| `/api/credentials` PUT/DELETE | 20/min per user (`credentialMutate`) | — |
| `/api/connectors` PUT/DELETE | 20/min per user (`connectorMutate`) | — |
| `/api/billing/checkout` POST + `/api/billing/portal` POST | 10/min per user (`billingMutate`) — each creates an outbound Stripe session | — |
| `/api/billing/subscription` GET + `/api/org` GET | 60/min per user (`accountRead`) | — |

Under SaaS mode the copilotkit route derives per-plan caps instead of the
static presets (exact caps: [saas-mode.md](./saas-mode.md#plan-enforcement-saas-only)).

### Better Auth rate limiting

Sign-in: 10/min per IP. Sign-up: 5/min per IP. Configured via
`rateLimit.customRules` in the `betterAuth()` call. Disabled in solo mode.

Two properties of the built-in limiter are worth knowing before tuning:

- **The counter resets only after a quiet gap larger than the whole
  window** (`now - lastRequest > windowInMs`), not on a rolling schedule.
  Sustained sub-rate traffic (say, one sign-in every 7s) never accumulates
  a 60s quiet gap, so the counter climbs until it trips — stricter than a
  rolling window for brute-force purposes, but it means legitimate
  long-lived-but-slow traffic is not actually exempt.
- **Sign-in's max is boot-overridable** with `AUTH_SIGNIN_RATE_MAX` (a
  positive integer; see `lib/ratelimit/limits.ts` `maxFromEnv`) — the same
  override contract as `AGENT_READ_RATE_MAX`/`GLOBAL_IP_RATE_MAX` above.
  Sign-up stays fixed at 5: account creation is the higher-value target.

### Concurrent SSE stream cap

The `/api/copilotkit` route tracks in-flight **run** streams per user (not
connect/info/stop streams). The `isRunRequest` check in the route handler
distinguishes runs from control requests **run-shaped first**: a POST whose
path parses as a run (`/agent/<id>/run` or `/agent/<id>/suggest`, agent id
decodable) is a run — even when it ends in `/connect` or `/stop/`, which
are only exempt on non-run-shaped paths (`/agent/<id>/connect`,
`/agent/<id>/stop/<threadId>`). A run-shaped path that doesn't parse fails
closed with a 404 rather than being reclassified as exempt control
traffic. Only runs count toward the rate limit
(20/min) and the concurrent cap (3). Connect streams (POST
`/agent/*/connect`), stop requests (POST `/agent/*/stop/<threadId>`), info
fetches (GET `/info`), and thread listing (GET `/threads`) are exempt. Stop
requests must be exempt — otherwise stopping a run at the 3-concurrent cap
tries to acquire a 4th slot and 429s, making the run unstoppable. The aborted
run's own SSE stream close still fires `release()` via `wrapStreamWithRelease`,
which is what actually decrements the counter.

**Suggest counts as a run.** CopilotKit's runtime also exposes
`POST /agent/:id/suggest` — a stateless suggestion run that executes the
provider agent directly. Path attribution (`runAgentIdFromPath`) matches
both `run` and `suggest`, so the rate limit, plan gates, builder gate and
concurrent cap apply identically; a suggest path that skipped attribution
would be a real agent execution with every gate bypassed. The handler also
collapses duplicate slashes before attribution (`//run` would otherwise
slip past the gate regexes), and run/suggest-shaped paths that don't parse
(trailing segments, undecodable agent ids) fail closed with a 404.

The `wrapStreamWithRelease()` helper (in `lib/ratelimit/stream-wrap.ts`)
wraps the `Response` body `ReadableStream` so the concurrent-cap decrement
fires automatically on stream completion, error, or client disconnect — no
manual cleanup needed in route code. When a user exceeds the concurrent cap
(3), they get `429 { error: "Too many concurrent agent runs (3 max)..." }`
which surfaces in the CopilotKit chat UI.

### Concurrent-slot watchdog

`acquireConcurrent` (in `lib/ratelimit/middleware.ts`) sets a `setTimeout`
watchdog that force-releases the slot after `CONCURRENT_RUN_TIMEOUT_MS`
(default 10 min) if `release()` was never called. This is a SAFETY NET
against slot leaks when a client opens a run and drops TCP without triggering
`ReadableStream.cancel()` (the normal release path through
`wrapStreamWithRelease`). The actual SSE stream / agent execution is NOT
cancelled — only the rate-limit counter is decremented. Side effect: a
legitimate run longer than the watchdog timeout would have its counter
decremented early, so the user could start another run before the slow one
finishes (the cap becomes "soft"). Default 10 min is generous for
chat-style AG-UI token streaming; override via env for long-research
agents. The watchdog timer is `unref()`'d so it can't keep the event loop
alive on shutdown.

### Solo mode (`AUTH_DISABLED=true`)

Per-user limits are not enforced (everyone is `id: "local"`). This applies to
**all** per-user limits — the copilotkit run/concurrent caps, agent
mutations, agent reads, thread mutations, reachability probe, and the
can-manage-agents check. The guard is centralized in `checkUserLimit()` /
`acquireConcurrent()` in `lib/ratelimit/middleware.ts` (not in each route
handler). Per-IP flood protection from `proxy.ts` still applies.

### 429 responses

Include standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, and `Retry-After` headers.

### Multi-instance note

The in-memory store (`lib/ratelimit/store.ts`) is per-process. For
multi-instance deployments, replace it with a Redis-backed store — the
interface (`checkLimit` / `incrementConcurrent` / `decrementConcurrent`) stays
the same.

## Thread visibility (cross-tenant isolation)

Every thread path — list (`listThreads`), reads
(`getThreadMessages`/`getThreadEvents`/`getThreadState`), and mutations
(`stop`, `deleteThread`, `renameThread`) — applies ONE rule
(`PostgresAgentRunner.threadVisible`, lib/agents/pg-runner.ts). The two
async run paths enforce it too:

- **`startRun` (the write path)** resolves the thread's existence and
  ownership from PG (`getThreadOwnership` — `thread_metadata`, falling
  back to "has runs" for ownerless legacy rows) BEFORE any state changes.
  A thread that exists and is foreign is denied ("Thread not found" →
  RUN_ERROR to the caller); a thread that exists nowhere is creatable —
  the first runner becomes its owner. The thread cache can't arbitrate
  this: a NEW chat is a cache miss by design. Without the PG check, a
  caller who knew another tenant's thread id could mark it "running"
  (denying the owner's real runs) and append their own messages to the
  victim's persisted history.
- **`startConnect` (the async replay path)** gates on the same
  `threadVisible` rule as the sync readers — fail-closed on cache miss,
  denial reads identically to an unknown thread (empty replay, immediate
  complete) and fires BEFORE the history fetch, so a foreign thread's
  events are never even read into this process's caches.

The rule itself:

- **Exact org match** — the thread's `organizationId` must equal the
  caller's. The old `organizationId === ""` tolerance made metadata rows
  with no recorded org visible (and deletable/renameable/stoppable) by
  every user of every org.
- **Owner or empty owner** — the caller must be the thread's owner, OR the
  row carries no recorded owner (legacy rows written when the runner ALS
  was absent are org-shared, the org-mate semantics deleteThread already
  had). Empty tolerance never widens the org boundary, only the owner half.
- **Solo mode** (no runner user — `AUTH_DISABLED=true`) sees everything:
  one tenant, one operator.
- **Cache-miss is denied** for authenticated callers (fail-closed): the
  in-memory caches are the source of truth for what this process can serve;
  multi-instance SaaS needs the Redis migration the class doc describes.
  Denials return empty/null/false — indistinguishable from an unknown
  thread id, so nothing leaks either way.

Without this, a signed-in member of any org could read another tenant's
messages/events/state — or kill another tenant's in-flight run — by knowing
a thread id (leaked via logs, Sentry breadcrumbs, screenshots). Platform
admins do NOT bypass the rule: admin powers are limited to agent/user
management, not thread management.

## Future / extension points

- **Nonce-based CSP** — current CSP uses `'unsafe-inline'` for scripts
  (pragmatic v1). A nonce-based policy requires threading a per-request nonce
  through Next's middleware + script tags — stronger XSS defense.

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
- **Opt-in:** `ALLOW_PRIVATE_ENDPOINTS=true` for self-hosters running backends
  on the same host. Defaults to `false`.
- **SaaS hard-locks it ON:** `SSRF_GUARD_FORCE_ON` (= `SAAS_MODE`) prevents a
  misconfigured `ALLOW_PRIVATE_ENDPOINTS` from exposing the host's private
  network to tenants. `SSRF_REJECTION_MESSAGE` is mode-aware: SaaS users get
  "not permitted on the hosted service", self-hosters get the opt-in hint.
- **PATCH semantics:** the guard only fires when the `endpoint` field is in
  the body — editing other fields on an existing private-endpoint agent works
  without the flag. Once stored, the CopilotKit runtime fetches the endpoint
  during runs without re-checking (intentional — existing agents keep working
  even if the env var changes).
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
  never returned — same boundary discipline as `agents.jwtSecret`. The
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
  stored token, `""` → clear it, string → encrypt + store. The name is
  the reference key in agent definitions (URL/payload-safe pattern).
  **The connector URL runs `assertSafeUrl`** — an admin pointing a
  connector at a private/internal address is a 400 (the AgentOS fetches
  connector URLs at run time with the org's token attached; http(s)-only
  alone doesn't stop `https://169.254.169.254/`).

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
  server-resolved value for a declared connector always wins. Today the
  wire payload's URL/token values are org-store-sourced (tackui resolves
  them per run), not client-controlled.
- **Config-declared connectors enforced AgentOS-side** — the builder
  writes the agent's connector names into the stored component config;
  the dispatcher refuses wire `mcp_connectors` keys outside that list
  (fail-closed, warning + skip). Scope the claim precisely: the
  dispatcher enforces the *namespace*, not the payload — it checks names,
  not URL/token values. If tackui's strip (the first wall) ever broke,
  the name check would not stop a declared-name entry whose URL was
  overwritten; the values would again be wire-trusted. That's why the
  first wall is the one that matters, and the dispatcher check is
  defense in depth.

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
- **Session-cookie `secure` flag** pinned to `NODE_ENV === "production"`.

## Rate limiting

Two-layer rate limiting protects the server from abuse and floods.

### Layer 1 — Per-IP global flood protection (`proxy.ts`)

- 300 requests/min per IP on all `/api/*` routes (except `/api/health` which
  is unlimited, and `/api/auth/*` which has its own Better Auth limiter).
- Enforced in the proxy (pre-auth). IP resolution checks `CF-Connecting-IP`
  first (set by Cloudflare to the real client IP — Traefik/Coolify overwrites
  `X-Forwarded-For` with the Cloudflare edge IP, splitting the counter across
  multiple edge IPs), then falls back to `X-Forwarded-For` with
  `TRUSTED_PROXY_HOPS` for self-hosters not behind Cloudflare. Without the
  right hop count, a malicious client can prepend a fake IP to
  `X-Forwarded-For` and bypass the per-IP limit entirely.
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

Under SaaS mode the copilotkit route derives per-plan caps instead of the
static presets (exact caps: [saas-mode.md](./saas-mode.md#plan-enforcement-saas-only)).

### Better Auth rate limiting

Sign-in: 10/min per IP. Sign-up: 5/min per IP. Configured via
`rateLimit.customRules` in the `betterAuth()` call. Disabled in solo mode.

### Concurrent SSE stream cap

The `/api/copilotkit` route tracks in-flight **run** streams per user (not
connect/info/stop streams). The `isRunRequest` check in the route handler
distinguishes runs from control requests: a POST is a run only if it is NOT
to a `/connect` or `/stop/` sub-path. Only runs count toward the rate limit
(20/min) and the concurrent cap (3). Connect streams (POST
`/agent/*/connect`), stop requests (POST `/agent/*/stop/<threadId>`), info
fetches (GET `/info`), and thread listing (GET `/threads`) are exempt. Stop
requests must be exempt — otherwise stopping a run at the 3-concurrent cap
tries to acquire a 4th slot and 429s, making the run unstoppable. The aborted
run's own SSE stream close still fires `release()` via `wrapStreamWithRelease`,
which is what actually decrements the counter.

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

## Future / extension points

- **Nonce-based CSP** — current CSP uses `'unsafe-inline'` for scripts
  (pragmatic v1). A nonce-based policy requires threading a per-request nonce
  through Next's middleware + script tags — stronger XSS defense.

# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor bumps may include breaking changes).

## [Unreleased]

### Fixed
- **SaaS-mode pages baked at build time:** `/`, `/terms`, `/privacy`, `/pricing` read `SAAS_MODE`/`BILLING_ENABLED` at module load but had no dynamic data deps, so Next.js statically generated them at build time (when `SAAS_MODE` isn't set) and baked the `redirect("/app")` into the HTML. Added `export const dynamic = "force-dynamic"` to each — they now render at request time, reading the live env var. Also fixes `<CookieNotice/>` which was being baked out for the same reason.
- **Reachability probe scope:** reverted the `canManageAgents` gate (it broke the sidebar's status dots for org members — all dots went red because the probe 403'd). The `assertSafeUrl` SSRF guard alone closes the real vulnerability (any logged-in user making the server fetch private IPs / cloud-metadata). Members keep their status dots; admins + members both probe, but only safe (public) URLs.
- **Pricing page for logged-in users:** buttons now say "Go to app" for signed-in users instead of the misleading "Sign in to upgrade" (which redirected to `/login` even though the user was already authenticated).
- **Rate-limit IP resolution behind Cloudflare → Traefik:** `getClientIp` now checks `CF-Connecting-IP` first. Cloudflare sets this to the real client IP, but Traefik (Coolify) overwrites `X-Forwarded-For` with the Cloudflare edge IP — without the `CF-Connecting-IP` check, the rate-limit counter split across multiple edge IPs and never reached the 300 cap.
- **Removed redundant `agno` agent kind:** was identical to `agui` (both used `HttpAgent`). Dropdown now shows 2 labeled options with descriptions. Graph ID + LangSmith API Key fields only appear when `langgraph` is selected.
- **Agent admin form clarity:** kind dropdown now shows human-readable labels ("AG-UI / Generic", "LangGraph Platform") with a description explaining when to use each. LangGraph-only fields (Graph ID, LangSmith API Key) are now conditional — hidden when `agui` is selected.

### Added
- "Need an agent backend?" links on the admin page + chat empty state + README, pointing to the [AG-UI quickstart](https://docs.ag-ui.com/quickstart/server) + [19 integration packages](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations).

### Added
- `components/marketing-layout.tsx` — shared header/footer for SaaS marketing pages. Session-aware nav: "Go to app" for signed-in users, "Sign in" + "Sign up free" for signed-out.
- Landing page redesign — Linear/Vercel style with blue accent: radial glow, gradient headline, SVG feature icons, "Built on" trust section, final CTA. CSS animations (`fade-in-up`, `pulse-glow`) in `globals.css`.

### Security
- **SSRF guard on reachability probe:** `POST /api/agents/reachability-probe` now applies `assertSafeUrl`. Previously any logged-in user could make the server issue an outbound GET to any URL — including cloud-metadata endpoints. Any logged-in user can still probe (the sidebar's status dots need it for members too), but only public URLs are allowed.
- **Mask internal errors on agent POST:** `POST /api/agents` no longer returns raw `err.message` on non-23505 failures (could leak DB topology / schema details). Now returns a fixed message and logs the detail server-side.
- **Pin session-cookie `secure` flag:** `betterAuth()` now sets `advanced.defaultCookieAttributes.secure = NODE_ENV === "production"` explicitly, instead of relying on Better Auth's `secure: "auto"` default (which depends on proxy header forwarding).
- **Webhook orgId cross-check:** Stripe webhook handler now cross-checks `sub.metadata.orgId` against `getOrgIdByCustomerId(sub.customer)` and drops the event on mismatch — defense against Stripe-account compromise attempting to re-attribute a subscription to a different org.
- **`X-Forwarded-For` spoofing fix:** `proxy.ts` now takes the Nth-from-right entry (configurable via `TRUSTED_PROXY_HOPS`, default `1`) instead of the leftmost. A malicious client can no longer override the rate-limit client IP by prepending `X-Forwarded-For: fake-ip`.
- **Concurrent-run watchdog:** `acquireConcurrent` now force-releases the rate-limit slot after `CONCURRENT_RUN_TIMEOUT_MS` (default 10 min) if `release()` was never called. Prevents slot leaks when a client opens a run and drops TCP without triggering `ReadableStream.cancel()`. The actual SSE stream / agent run is NOT cancelled — only the counter is decremented.
- **Empty webhook secret → null:** `getWebhookSecret()` now treats empty-string `STRIPE_WEBHOOK_SECRET` as `null` (was `""`), preventing silent signature-verification failures + Stripe's infinite-retry storm.
- **Defensive solo-mode secret fallback:** `AUTH_SECRET` const makes the `"solo-mode-no-sessions"` fallback unreachable by construction when `AUTH_DISABLED !== true` — guards against a future refactor removing the boot-time throw.

### Added (OSS release)
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
- `.github/workflows/ci.yml` — lint + tsc + test on push/PR (pg-mem in-memory, no Postgres service)
- `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/bug.yml` + `feature.yml`, `.github/dependabot.yml`
- `package.json` metadata: `license`, `repository`, `author`, `engines`, `bugs`, `homepage`, `description`
- `CHANGELOG.md` (this file)

### Changed
- README "Adding Agents" example no longer shows a client-supplied `id` (the API rejects it — `id` is server-generated).

### Environment
- New optional env var: `TRUSTED_PROXY_HOPS` (default `1`) — number of reverse-proxy hops in front of the server, used to resolve the real client IP from `X-Forwarded-For`. Set to `2` for Cloudflare → Nginx → app, etc.
- New optional env var: `CONCURRENT_RUN_TIMEOUT_MS` (default `600000` = 10 min) — watchdog timeout for concurrent-run rate-limit slots. Floor is `60000` (1 min). Override if your agents do legitimately long research runs.

## [0.1.0] — 2026-08-18

Initial public release.

### Added
- **Streaming chat** — token streaming, multi-turn, cancel/resume (AG-UI protocol over SSE via CopilotKit)
- **Human-in-the-loop interrupts** — `useInterrupt` approval cards
- **Multi-agent switching** with per-agent threads (`AgentChat` wrapper keys `CopilotChat` by `agentId + threadId`)
- **Tool-call visualization** — `useRenderTool`
- **Postgres-backed thread runner** with conversation persistence (`PostgresAgentRunner` — extends `AgentRunner` from `@copilotkit/runtime/v2`, smart-replay `connect()` filters `RUN_ERROR` events, in-memory cache bridges the sync `LocalThreadEndpointRunner` interface to async PG)
- **Multi-conversation sidebar** — `useThreads` + auto-refetch on run completion, inline rename + delete (`PATCH/DELETE /api/threads/[id]`)
- **Dynamic agent registry** — DB-backed `getAgents()` factory + `/agents` admin UI with add/edit/delete + test connection + sidebar status dots. No restart needed when adding/editing/removing agents.
- **Collapsible sidebar** — icon-only mode with smooth width transition, persisted to localStorage
- **LangGraph + Agno + raw AG-UI backends** wired first
- **Authentication (Better Auth):** email/password, Google/GitHub OAuth, OIDC SSO (Keycloak/Authentik/Okta/Entra), admin/member roles, per-user + per-org thread scoping, `AUTH_DISABLED` solo mode, first-user-is-admin bootstrap, user management admin UI, personal-org pattern (every user gets a workspace on signup via the `organization` plugin)
- **Multi-tenant org scoping** — `org_id` NOT NULL on `agents` + `thread_metadata`, all queries scope by the user's active org, org-level agent management (`canManageAgents`), solo mode creates a real org row on boot
- **Workspace member management** — `/app/members` page: roster via `listMembers` with role badges; remove a member (inline confirm); change a member's role (member↔admin↔owner) via `updateMemberRole` — enables ownership transfer; cancel a pending invitation; self-leave via `removeMember`; non-admins see only the roster + their own Leave button
- **SaaS mode (`SAAS_MODE`)** — same codebase as OSS self-host, gated by one env var. SaaS-only paths are inert when unset.
- **Billing (Stripe flat subscriptions, SaaS-only):** Free / Pro / Team plans with per-plan agent + seat caps. Webhook receiver is signature-verified, bypasses the cookie gate, returns 500 on handler errors so Stripe retries transient failures.
- **Plan enforcement (SaaS-only):** `checkAgentCountLimit` (POST `/api/agents` 402s at cap), `checkMemberCountLimit` (invite path 402s at seat cap), `checkCanCreateOrg` (always allowed — workspace creation is free), plan-derived `runsPerMinute` + `concurrentRuns` overrides fed to the rate-limit middleware
- **Org switcher + invitations** — `org-switcher.tsx`, `invite-dialog.tsx`, `new-workspace-dialog.tsx`, `upgrade-dialog.tsx`, `/app/invitations` page
- **Marketing + legal pages (SaaS-only)** — `landing.tsx`, `/pricing`, `/terms`, `/privacy`, `cookie-notice.tsx`
- **Email verification + password reset** — env-gated via `RESEND_API_KEY`. `sendOnSignIn: false` (verification email not auto-sent on every login); login page catches the 403 "email not verified" error and shows a "Resend verification email" button
- **Error tracking** — `@sentry/nextjs` integration (server + client + edge configs). No-op when `SENTRY_DSN` is not set. Error boundaries call `Sentry.captureException`. Trace sampling via `SENTRY_TRACES_SAMPLE_RATE`.
- **Error boundaries** — `app/error.tsx` (child-segment errors) + `app/global-error.tsx` (root layout failures, replaces `<html>`/`<body>`)
- **Server-side structured logging** — `[copilotkit] handler error`, `[runner] run failed`, `[reachability-probe] fetch failed`, `[billing-webhook] ...`, `[ratelimit] watchdog force-released concurrent slot`
- **Security hardening:** `langsmithApiKey` stripped from all GET responses (`PublicAgent.hasLangsmithApiKey: boolean`); SSRF guard on agent create/edit (`lib/net/safe-fetch.ts` + `ALLOW_PRIVATE_ENDPOINTS` opt-in); security headers in `next.config.ts` (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, `poweredByHeader: false`); `BETTER_AUTH_SECRET` throws on boot if unset when auth enabled; open-redirect fix (`safeRedirect()` in login page); `/api/health` liveness endpoint (bypassed by proxy cookie gate); error-message masking on reachability probe
- **Rate limiting (two-layer):** per-IP global flood protection in `proxy.ts` (300/min) + per-user route-level limits in `lib/ratelimit/` (20 runs/min, 3 concurrent SSE streams, 10/min probe/mutations, 60/min reads). Better Auth `rateLimit` config (sign-in: 10/min, sign-up: 5/min per IP). 429 responses with standard `X-RateLimit-*` headers.
- **Dockerfile + docker-compose.yml** — multi-stage build, non-root user, standalone Next.js output, Postgres 16 with healthcheck, app healthcheck wired to `/api/health`
- **In-memory test suite** — vitest + `pg-mem` (no Docker required, no cleanup needed between runs). 324 tests covering API routes, stores, billing, ratelimit, SSRF, auth, email templates, plan enforcement.

### Security
- See the README [Security](./README.md#security) section for the full posture: SSRF guard, rate limiting, session-cookie flags, `BETTER_AUTH_SECRET` enforcement, open-redirect protection, security headers, secret handling, known limitations.

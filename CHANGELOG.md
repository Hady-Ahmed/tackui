# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor bumps may include breaking changes).

## [Unreleased]

### Added
- **Per-agent JWT auth (HS256)** — optional `authMode: "jwt"` per `agui` agent: the runtime mints a short-lived JWT (`sub` = the authenticated user's Better Auth id, `exp` +1h) signed with the agent's `jwtSecret` and sends it as `Authorization: Bearer <token>` on every run. Optional `jwtScopes` claim for backends with authorization (RBAC) enabled. `jwtSecret` is write-only (`PublicAgent.hasJwtSecret: boolean` replaces the raw value); stored plaintext in the `agents` table (encryption at rest is future work).
- **User identity forwarding** — the runtime injects the authenticated user's id into `input.forwardedProps.user_id` on every `agui` run (Agno's convention for per-user memory/sessions). Done server-side per-request in `lib/agents/registry.ts`; client-supplied `forwardedProps` are preserved. Sent in both auth modes — when a JWT is present the backend pins to `sub`, otherwise it uses `user_id`.
- **Optional Umami analytics** — self-hosted web analytics integration (no-op when unset); CSP `script-src` origin wired accordingly.
- **Branded icon set** — thumbtack favicon (`app/icon.svg`, theme-aware via `prefers-color-scheme`), generated apple-touch icon + OG/Twitter social-share cards via `next/og` (no committed binaries), `metadataBase` from `BETTER_AUTH_URL`; removed the dead `COPY public/` Dockerfile line that broke builds with an empty `public/`.
- **Social provider icons** on the Google/GitHub sign-in buttons.
- **Responsive UI** — drawer sidebar, mobile-friendly tables, compact back button on small screens; responsive landing navbar + hero.
- **Landing page expansion** — product mockup, bento grid, how-it-works section, scroll reveals; theme toggle added to the marketing header.
- **Active press feedback** on public-facing buttons.

### Changed
- **Tool-call rendering rewrite** — the `useRenderTool` wildcard now renders inline ChatGPT/Claude-style activity rows: status icon (spinner → ✓/✗), humanized tool name, inline arg preview; the expanded panel shows arguments as key-value rows and results as rendered markdown (`react-markdown` + `remark-gfm`), HTML tables (array-of-objects), pretty JSON, or plain text. Results that arrive JSON-escaped (literal `\n` / `\"` / `\uXXXX` — e.g. Agno/Tavily) are decoded first via `normalizeResultString` (conservative gate: zero real newlines + escape artifacts present). No size caps — only a visual height clip with Show all/Show less; `useMemo` + `React.memo` keep big results parsing once. Pure helpers live in `lib/tools/format.ts` (40 tests).

### Removed
- **`langgraph` agent kind** — the LangGraph Platform API integration (`LangGraphAgent` + Graph ID / LangSmith API Key fields) shipped in 1.0.0 without ever being smoke-tested against a real deployment. Removed rather than ship an admin-UI option that may silently not work; LangGraph users are served via `ag-ui-langgraph`. Migration 0008 deletes existing `kind='langgraph'` agent rows and drops the `graph_id` + `langsmith_api_key` columns (the langsmith secret's entire write-only stripping surface existed solely for this kind). Restore from git history when there's real demand (plus the missing smoke test).
- **Agent `kind` field removed entirely** — with `langgraph` gone, `kind` had exactly one legal value: a constant column, a single-value schema, and a one-case registry switch. Migration 0009 drops the `kind` column. POST/PATCH bodies that still send `kind` are accepted and discarded (zod strips unknown fields); the reachability probe no longer expects it (it was validated but never read); the admin sidebar no longer renders a kind badge. When a second kind is genuinely demanded, re-add the column + adapter in the same migration as its config fields.

### Fixed
- **Mobile marketing pages had no sign-in entry point** — the mobile nav in `MarketingLayout` rendered only a "Sign up" CTA when signed out ("Sign in" existed solely in the desktop nav), so mobile visitors had to go through the signup page to reach `/login`. A text "Sign in" link now sits beside the "Sign up" button on all four marketing pages (`/`, `/pricing`, `/terms`, `/privacy`).
- **Better Auth per-IP rate limiting behind proxies** — `ipAddress` headers configured so Better Auth's own limiter resolves the real client IP instead of the proxy's.
- **`/pricing` public under SaaS mode** — the proxy cookie gate now allows it (was redirecting signed-out visitors to `/login`).
- **AG-UI no longer breaks across lines** in landing page headings.
- **Arabic/Quranic glyphs** now render via the Amiri font fallback instead of falling back to a Latin font.

### Docs
- README cleanup + rename agent_frontend → tackui; Docker Compose V2 syntax + migration note; self-hosting note for same-host agent backends; placeholder GitHub links replaced with the actual repo URL; legal-page updates (account deletion claims, hardcoded "Last updated" date); AGENTS.md updates (Conventional Commits, branded icon set).

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

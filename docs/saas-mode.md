# SaaS Mode & Billing

The hosted SaaS instance is the *same codebase* as the OSS self-host product,
gated by a single env var. There is no separate repo — all SaaS-only code
paths are inert when `SAAS_MODE` is unset.

## Flags

`lib/config/saas.ts` — module-load consts:

- `SAAS_MODE` — set to `"true"` to enable the hosted mode.
- `BILLING_ENABLED` — `SAAS_MODE && STRIPE_SECRET_KEY`.
- `SSRF_GUARD_FORCE_ON` — `SAAS_MODE`, hard-locks the SSRF guard on (see
  [security.md](./security.md#ssrf-guard)).
- `SSRF_REJECTION_MESSAGE` — mode-aware SSRF rejection copy (see
  [security.md](./security.md#ssrf-guard)).

These are evaluated once at boot — env changes require a dev-server restart.

The full environment-variable reference lives in
[README.md](../README.md#environment-variables) and
[`.env.example`](../.env.example).

### Route layout

Root `app/page.tsx` is a SaaS-aware router — `SAAS_MODE` renders
`<Landing/>` (marketing), else redirects to `/app`. Chat lives at `/app` in
both modes. Auth pages (`/login`, `/signup`, …) stay at their paths.
`proxy.ts` makes `/`, `/catalog`, `/terms`, `/privacy`, `/pricing` public
under SaaS mode
(auth-gated under self-host, where `/` IS the chat). `/api/billing/webhook`
is bypassed by the cookie gate + per-IP rate limit (Stripe calls
server-to-server, signature-verified).

## Billing (Stripe flat subscriptions, SaaS-only)

- `lib/billing/plans.ts` — plan definitions (Free/Pro/Team) +
  `getPlanLimits(plan)` (returns the unlimited sentinel for self-host) +
  `planIdFromPriceId` (maps a Stripe Price ID → plan; the dollar amounts
  live in Stripe, only the price IDs are env-configured) +
  `priceIdForPlan` + `defaultPlan` (free when billing is enabled,
  self-host otherwise). `SAAS_PLANS` exported for the pricing page.
- `lib/billing/stripe.ts` — Stripe SDK singleton (null when
  `!BILLING_ENABLED`). `getStripe()` + `getWebhookSecret()` (empty-string
  `STRIPE_WEBHOOK_SECRET` is treated as `null` — a blank secret would
  silently reject all webhook signatures → Stripe infinite-retry storm).
- `lib/billing/subscription-store.ts` — async CRUD on the `subscriptions`
  table (zod-validated, `pg.Pool`-backed, mirrors `agent-store.ts`):
  `getSubscription`, `getOrgPlan` (stored plan or default),
  `upsertSubscription` (the webhook is the sole writer), `deleteSubscription`
  (downgrade to free), `getOrgIdByCustomerId` (resolve org from a Stripe
  customer id), `userHasTeamPlan` (checks if a user belongs to any Team-plan
  org), `getMembershipLimit` (seat cap for better-auth's `membershipLimit`).
- `lib/billing/checkout.ts` — `createCheckoutSession` (carries `orgId` in
  metadata so the webhook can route events to the right org; Team enforces
  min 2 seats at the route layer via zod `.refine`) +
  `createPortalSession` (Customer Portal).

Routes:

- `app/api/billing/checkout/route.ts` — POST (auth + `canManageAgents`)
  → Checkout URL.
- `app/api/billing/portal/route.ts` — POST (auth + `canManageAgents`)
  → Customer Portal URL.
- `app/api/billing/webhook/route.ts` — POST (no auth — signature-verified).
  Handles `checkout.session.completed` (upsert from metadata),
  `customer.subscription.updated`/`created` (upsert from the Subscription
  object — reads period-end from the subscription *item* in the current
  Stripe API version), `customer.subscription.deleted` (delete row →
  free). Returns 500 on handler errors so Stripe retries transient
  failures (DB down). The handler cross-checks `sub.metadata.orgId`
  against `getOrgIdByCustomerId` and drops mismatches (defense against
  Stripe-account compromise re-attributing subscriptions).
- `app/api/billing/subscription/route.ts` — GET (auth) → current plan +
  limits for the account-menu badge.
- `components/upgrade-dialog.tsx` — plan upgrade modal (Pro/Team options,
  Team seats input min 2) → POST `/api/billing/checkout` → Stripe Checkout.
  Shows which workspace is being upgraded + a tip suggesting creating a
  separate team workspace first if upgrading a personal one.
- Migration `0004_subscriptions.sql` — `subscriptions` table (`org_id` PK,
  `plan`/`status`/`seats`/`current_period_end`, indexes on Stripe IDs).
- Client hooks: `lib/billing/use-billing.ts` (`useBilling()` — one fetch per
  page load, cached in module state), `use-orgs.ts` (`useOrgs()` +
  `resetOrgsCache()`), `use-invitations.ts` (pending-invite badge via the
  better-auth client + `resetInvitationsCache()`).

## Plan enforcement (SaaS-only)

`lib/plans/enforcement.ts` — every function short-circuits to
"unlimited/allowed" when `!SAAS_MODE`:

- `getEnforcementLimits(orgId)` — returns `{ plan, limits }`. Self-host
  returns the unlimited sentinel without a DB call.
- `checkAgentCountLimit(orgId)` — POST `/api/agents` rejects (402) when
  the org is at its plan's agent cap (free ≤ 3). Pro/team unlimited.
- `checkMemberCountLimit(orgId, currentCount)` — invite path rejects
  (402) when at the seat cap. Free/pro = 1 (personal, no invites),
  team = `subscription.seats`.
- `checkCanCreateOrg(orgId)` — always returns null (allowed). Workspace
  creation is free and unrestricted (Vercel/GitHub model): a Free
  workspace has 3 agents max, 1 member, no invites — harmless. The Team
  plan gates *invites* (via `membershipLimit`), not workspace creation.

The rate-limit middleware (`lib/ratelimit/middleware.ts`) accepts an
optional `opts.max` override so the copilotkit route can feed plan-derived
`runsPerMinute` + `concurrentRuns` caps (free=10/min+1, pro=20/min+3,
team=20/min+5). The copilotkit route fetches `getEnforcementLimits` under
SaaS mode and passes the overrides; under self-host the static `LIMITS`
presets apply unchanged.

Catalog agents additionally carry per-template gates — `required_plan` +
daily quotas, enforced at install AND run time. See
[catalog.md](./catalog.md#monetization-gates-saas-only--short-circuit-on-saas_mode).

### Server-side org gates (better-auth `organization` plugin, wired in
`lib/auth/auth.ts`)

`allowUserToCreateOrganization` (always true — workspace creation is free;
the personal org auto-created on signup goes through the session hook, NOT
this gate, so signup always works) + `membershipLimit` (per-org seat cap:
free/pro = 1, team = `subscription.seats`) + `sendInvitationEmail`
(env-gated via `EMAIL_ENABLED` — sends an invitation email via Resend when
configured, no-op otherwise; the invitee discovers the invite via the
pending-invitations badge in the account menu). These enforce at the API
layer so direct calls can't bypass the plan.

## Marketing + legal pages (SaaS-only)

- `components/marketing-layout.tsx` — shared header/footer for SaaS
  marketing pages. Session-aware: calls `getCurrentUser()`, shows "Go to
  app" for signed-in users, "Sign in" + "Sign up free" for signed-out.
- `components/landing.tsx` + `app/page.tsx` (SaaS → `<Landing/>`) — hero
  with radial blue glow, gradient headline, feature cards with inline SVG
  icons, "Built on" trust section, final CTA. CSS animations in
  `globals.css` (`fade-in-up`, `pulse-glow`). Linear/Vercel style.
- `app/pricing/page.tsx` — Free/Pro/Team tier cards. The dollar amounts
  live in Stripe; the page shows feature gates only. Session-aware buttons
  ("Go to app" for signed-in users). Redirects to `/app` when
  `!BILLING_ENABLED`.
- `app/terms/page.tsx` + `app/privacy/page.tsx` — ToS + Privacy (SaaS
  data practices: Stripe, Resend, Better Auth, Sentry). Wrapped in
  `MarketingLayout`. Redirect to `/app` when `!SAAS_MODE`.
- All 5 public SaaS pages (`/`, `/catalog`, `/terms`, `/privacy`, `/pricing`)
  use `export const dynamic = "force-dynamic"` — they read `SAAS_MODE`/
  `BILLING_ENABLED` at request time (not baked at build time).
- `components/cookie-notice.tsx` — minimal EU cookie notice, rendered in
  the root layout only under SaaS mode, dismissible (localStorage).

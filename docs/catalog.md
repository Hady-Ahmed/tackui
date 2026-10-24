# Agent Catalog

A curated, platform-admin-managed catalog of **agent templates** that
any workspace can one-click install. The onboarding flow: share a
`/catalog#slug` link → visitor signs up → clicks "Add to workspace" →
the agent is running. No endpoints, no config.

## Model (template vs. installed copy — managed-plugin)

- `agent_templates` — global rows (NOT org-scoped), managed by platform
  admins (`role === "admin"` via the Catalog section on `/admin` or the
  `/api/catalog` REST API). Fields: `slug` (unique, shareable),
  `name`, `tagline` + `description` (both required — zod-enforced on
  create and PATCH, trimmed; blank catalog cards can't be published;
  the tagline is additionally single-line — `[\r\n]` rejected — since
  its job is a one-line summary, while descriptions are multi-line and
  render literal line breaks),
  `category`, `icon` (emoji),
  `endpoint`, `auth_mode`/`jwt_secret`/`jwt_scopes` (same machinery +
  encryption as agents — see [agent-registry.md](./agent-registry.md)), `required_plan`
  (nullable — `pro`/`team`), `free_daily_quota` + `paid_daily_quota`
  (nullable ints — per-tier rolling-24h run caps, see Monetization
  gates), `sort_order`, `is_active`.
- Installing creates an org-scoped `agents` row via `installTemplate()`
  — but the row is an **entitlement/reference, not a config copy**.
  The runtime resolves endpoint/auth **live from the template** on every
  request (`getTemplatesByIds` batch in `lib/agents/registry.ts`), so a
  template edit (endpoint fix, secret rotation, rename) propagates to
  every installed org with no user action.
- **Display copy propagates live too:** `annotateAgentTemplateState`
  (on `GET /api/agents`) stamps the live template's
  tagline/description/icon onto managed agents
  (`templateTagline`/`templateDescription`/`templateIcon` on
  `PublicAgent`) — the sidebar shows the fresh tagline (hover title:
  tagline + description) on the next fetch. Tombstones are the one
  snapshot case — the template row is gone, so clients fall back to the
  agent row's install-time `description` (and the first-letter avatar
  placeholder, since `templateIcon` is also unstamped). Paused agents
  keep live values (the template row still exists; freezing text during
  a pause would make un-pause a visible stale→live jump). The row's
  copied config (refreshed on every install call) is only the fallback
  that keeps history replay working after a template is deleted
  (tombstones). Provenance: `agents.source_template_id` +
  `installed_template_updated_at` (last-sync snapshot).
- **Fully locked:** any `PATCH` on an agent with `sourceTemplateId`
  returns 400 `AGENT_MANAGED` — name/description/endpoint all come from
  the template. Only Remove (DELETE) is offered. `GET /api/agents`
  **strips `endpoint` for managed agents** — the curator's backend URLs
  never leave the server (the sidebar skips probing them; the `/agents`
  table shows "Managed by catalog" + a Catalog badge). Tombstoned agents
  carry `templateRemovedAt` (see Lifecycle).

## Install semantics

`POST /api/catalog/[id]/install` gated by `canManageAgents` (installing
changes the org's agent list) → `checkTemplateInstall` (plan gate) →
`checkAgentCountLimit` (**skipped on re-install** — no new row) →
`installTemplate()`:

- **First install** creates the agent row → `201 { installed: true }`.
- **Re-install** refreshes the row's config snapshot from the template
  (id preserved) → `200 { installed: false, updated: bool }`. Invisible
  to users — the catalog card just shows "✓ Added to workspace" (live propagation
  means there is no user-facing update action).

Catalog card text clamping — tagline clamps to 2 lines and description
to 4 (`ExpandableText` in `components/expandable-text.tsx`: `line-clamp`
+ a Show more/less toggle rendered only when the text actually
overflows, measured at hydration/resize/font-load). Descriptions carry
`whitespace-pre-line` so literal line breaks typed in the admin form
render as breaks (newlines are stored verbatim; HTML just collapses
them in a plain `<p>` — single-line-enforced taglines don't need the
class). Applied on the in-app `/app/catalog` grid and the public
`/catalog` marketing page (server-rendered — the server emits the
clamped `<p>`, the client adds the toggle), so a 2000-char description
can't stretch cards into giant uneven rows. The `/admin` template form
surfaces the zod limits in-field (`maxLength` + live `n/200` and
`n/2000` counters in the hints).

## Monetization gates (SaaS-only — short-circuit on `!SAAS_MODE`)

- **`required_plan`** (`pro`/`team`): blocks install AND runs for lower
  plans (402 `PLAN_AGENT_LOCKED`). Run-time enforcement in
  `checkCatalogRunGates` catches orgs that downgrade AFTER installing.
- **Per-tier daily quotas** (`free_daily_quota` + `paid_daily_quota`,
  both nullable ints = uncapped): rolling-24h per-user run caps on
  catalog agents (402 `AGENT_QUOTA_EXCEEDED` with `resetsAt`).
  `checkCatalogRunGates` picks the cap by the org's plan — free →
  `free_daily_quota`, pro/team → `paid_daily_quota` (one shared paid
  value; Team members get Pro's personal allowance). Counted via
  `getRunUsage` — `agent_runs ⋈ thread_metadata` filtered by
  `user_id + agent_id + created_at >= now-24h` (no counter tables; the
  event log IS the counter). Counted fresh from the log on every run —
  **no cache, no pre-consumed slots**: the runner only persists runs
  that produced events (`storeRun` in pg-runner), so attempts that never
  reached the backend (backend down, instant fetch failure — no event
  ever emitted) don't consume quota; runs that errored mid-stream do
  (they reached the backend). **User-aborted runs count too** — the
  AG-UI client turns an abort into a persisted `RUN_ERROR` event
  (code: "abort"), so stop button / agent-switch mid-stream / send-
  while-streaming each leave a counted row. Don't be surprised when a
  quota trips "early" — check `agent_runs` for the extra row first.
  Free users are capped at 1 concurrent run (plan limit + "thread
  already running" guard), so turns are sequential — no burst window.
  Manually added agents are never gated.
- **Schema invariants** (zod refinements in `template-store.ts`): a
  plan-gated template has no free tier (`freeDailyQuota` is rejected
  alongside `requiredPlan`), but a paid cap IS allowed on gated
  templates (a Pro-only agent can cap its paid usage). On an ungated
  template, `paidDailyQuota` requires `freeDailyQuota` — without a free
  cap, paid users would be strictly worse off than free users
  (uncapped), which is never intended. And `paidDailyQuota` must exceed
  `freeDailyQuota` when both are set (Pro is the higher tier).
- **Sidebar chip for gated installs** — `annotateAgentTemplateState`
  copies the live template's `requiredPlan` onto
  `PublicAgent.templateRequiredPlan` (curator state, billing-free); the
  sidebar compares it against `useBilling()`'s plan (`planSatisfies`)
  and renders a 🔒 Pro/Team chip when unsatisfied (SaaS-only — self-host
  never gates; plan is null without billing). Covers gated-after-install
  AND downgrade-after-install (same run-time gate state). Sidebar chip
  precedence: Removed > Paused > plan-locked; plan-locked rows are NOT
  muted (recoverable by upgrading — Paused/Removed are curator actions),
  past chats stay viewable, and the run 402 ("Upgrade to keep using it")
  remains the explainer when they try.
- **Usage-limit copy policy (three rules):**
  1. The quota numbers are never stated in product copy — they appear
     only in the 402 JSON (debugging) and the `[quota]` server log.
  2. Maximal promises are banned — copy never says "unlimited" for
     catalog usage, because a cap added later would contradict what a
     subscriber saw when they paid (a null cap is simply uncapped, never
     described as infinite).
  3. Catalog cards never mention usage limits at all — the card
     describes the agent; the limit surfaces where it's actually
     encountered: the run 402 ("You've reached your usage limit for this
     agent — you can use it again in 5h 12m." + the free-tier-only
     "Upgrade to Pro for more usage." clause; the quota 402 banner also
     carries an inline Upgrade button that opens the upgrade dialog —
     the conversion ask lands at the paywall moment, not behind the
     account menu). The button only renders when an upgrade actually
     helps (free quota exhaustion or a plan-lock; paid plans share one
     quota cap, so pro users who exhaust it get the countdown without a
     button) and the pricing page (Free tier lists "Daily usage limits
     on catalog agents (enough to get a feel)"). Plan-gated cards DO
     state their gate ("Available on the Pro plan") — that's
     installability info, not a usage limit. The disclosure points are
     deliberate: the 402 arrives while the user is actively trying to
     use the agent, so the constraint, the reset countdown, and — on the
     free tier — the upgrade path all surface in the same message.

The chat UI surfaces 402s/410s like 429s (`AgentChat.onError` filter in
`chat-shell.tsx`); any other non-abort run failure surfaces a generic
"Agent failed to respond" banner (raw errors are never shown to users).

## Run gates (both modes — curator state, not billing)

`checkCatalogRunGates` (in `lib/plans/enforcement.ts`, called by the
copilotkit route on every run — including solo mode) applies the
curator-state gates in BOTH modes; the monetization gates above stay
SaaS-only:

1. **Tombstone** (template deleted, or a managed row whose template is
   missing) → 410 `AGENT_REMOVED` — "This agent was removed by its
   publisher. Past conversations remain viewable." The registry still
   resolves tombstoned agents (row config fallback) so connect/history
   replay works; only runs die, at the route, before any backend
   request. There is no ungated-orphan path: a run needs a live
   template or it's blocked.
2. **Deactivated template** (`is_active = false`) → 402
   `AGENT_UNPUBLISHED` — "unpublished by the curator." The reversible
   kill switch: re-show restores, history stays viewable throughout.
3. Then the SaaS-only plan + quota gates (above).

## Mode matrix

| Surface | SaaS | Self-host |
| --- | --- | --- |
| In-app catalog (`/app/catalog`) + install | ✓ | ✓ |
| Template admin (Catalog section on `/admin`) | platform admin | platform admin (first user) |
| Tombstone + deactivation run gates | ✓ | ✓ |
| Plan gate + per-tier quota enforcement | ✓ | ✗ (short-circuit) |
| Public `/catalog` marketing page | ✓ | redirects to `/app` |

## Lifecycle rules

- **Deleting a template tombstones every installed copy** — the rows
  stay (`agents.template_deleted_at`, migration 0011) so users keep
  browsing past conversations, with a "Removed" chip in the sidebar and
  an endpoint-less, non-runnable agent. The delete confirm fetches
  `GET /api/catalog/[id]` (`installCount`) and warns "N workspaces have
  installed it". Orgs clean up tombstones via the normal Remove (their
  own agent DELETE). Tombstones never count toward the plan's agent cap
  (`countAgents` excludes them). Kill switch for a bad template:
  `is_active = false` (immediate 402 on runs, reversible); deleting is
  the permanent move.
- **Live propagation cuts both ways** — a bad template edit reaches
  every org on their next run. Recovery: deactivate, fix, re-show.
  Secret rotation is painless for the same reason (no re-sync clicks).
- Catalog routes reuse the `agentMutate`/`agentRead` rate-limit
  buckets; template endpoints pass the same `assertSafeUrl` SSRF guard
  as agent create/edit (see [security.md](./security.md#ssrf-guard)).

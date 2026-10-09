import { NextResponse } from "next/server";
import { SAAS_MODE } from "@/lib/config/saas";
import { getOrgPlan, getSubscription } from "@/lib/billing/subscription-store";
import {
  getPlanLimits,
  planSatisfies,
  type PlanId,
  type PlanLimits,
} from "@/lib/billing/plans";
import { getAgent, countAgents } from "@/lib/agents/agent-store";
import { getTemplate, getRunUsage } from "@/lib/catalog/template-store";
import type { AgentTemplate } from "@/lib/catalog/catalog.config";
import type { RequestUser } from "@/lib/auth/request-context";

// The client catalog UI needs the same plan comparison — the canonical
// implementation lives in lib/billing/plans.ts (client-safe); re-exported
// here so server-side callers + tests import it from the enforcement
// layer.
export { planSatisfies };

/**
 * SaaS plan-enforcement layer.
 *
 * Every function here short-circuits to "unlimited/allowed" when
 * `!SAAS_MODE` — self-host deployments (solo or multi-user) are never
 * plan-limited. Only the hosted SaaS instance enforces plan caps.
 *
 * The enforcement reads the org's plan from the subscriptions table via
 * the subscription store (which falls back to the default plan — free
 * under SaaS, self-host otherwise — when no row exists).
 *
 * Limits are enforced on the WRITE path (agent creation, org creation,
 * invites) and on the RUN path (copilotkit rate + concurrent caps). Reads
 * (GET /api/agents, GET threads) are never plan-gated — users always see
 * their own data.
 */

/**
 * Resolve the effective limits for an org. Self-host returns the unlimited
 * sentinel without a DB call. SaaS reads the subscription row + falls back
 * to the free plan when no row exists.
 */
export async function getEnforcementLimits(
  orgId: string,
): Promise<{ plan: PlanId; limits: PlanLimits }> {
  if (!SAAS_MODE) {
    return { plan: "self-host", limits: getPlanLimits("self-host") };
  }
  const plan = await getOrgPlan(orgId);
  return { plan, limits: getPlanLimits(plan) };
}

/**
 * Check whether an org can create another agent. Returns null when
 * allowed, or a 402 NextResponse when the plan's agent cap is reached.
 * Called by POST /api/agents before persisting. Self-host always allows.
 *
 * We count the org's LIVE agents (manually-added + active catalog
 * installs) against the plan's maxAgents. Tombstones (deleted
 * templates, kept for history browsing) are dead weight and don't
 * consume the cap. `null` maxAgents = unlimited (pro / team).
 */
export async function checkAgentCountLimit(
  orgId: string,
): Promise<NextResponse | null> {
  if (!SAAS_MODE) return null;
  const { limits } = await getEnforcementLimits(orgId);
  if (limits.maxAgents === null) return null; // unlimited
  const current = await countAgents(orgId);
  if (current >= limits.maxAgents) {
    return NextResponse.json(
      {
        error: `Your plan allows up to ${limits.maxAgents} agent${limits.maxAgents === 1 ? "" : "s"}. Upgrade to add more.`,
        code: "PLAN_AGENT_LIMIT",
        limit: limits.maxAgents,
        current,
      },
      { status: 402 },
    );
  }
  return null;
}

/**
 * Check whether an org can invite another member. Returns null when
 * allowed, or a 402 NextResponse when the plan's seat cap is reached.
 * Called by the invite path. Self-host (multi-user) always allows.
 *
 * For the team plan, maxMembers is null — the cap is the subscription's
 * `seats` field (per-seat billing), not a fixed plan cap. We read seats
 * from the subscription row. For free/pro, maxMembers=1 (personal, no
 * invites) — enforced here too.
 */
export async function checkMemberCountLimit(
  orgId: string,
  currentMemberCount: number,
): Promise<NextResponse | null> {
  if (!SAAS_MODE) return null;
  const { limits } = await getEnforcementLimits(orgId);
  if (limits.maxMembers === 1) {
    if (currentMemberCount >= 1) {
      return NextResponse.json(
        {
          error: "Your plan is for a single member. Upgrade to Team to invite collaborators.",
          code: "PLAN_SEAT_LIMIT",
        },
        { status: 402 },
      );
    }
    return null;
  }
  // Team: per-seat cap from the subscription. self-host already returned
  // above (maxMembers null but we short-circuited on !SAAS_MODE).
  const sub = await getSubscription(orgId);
  const seats = sub?.seats ?? 1;
  if (currentMemberCount >= seats) {
    return NextResponse.json(
      {
        error: `Your team plan has ${seats} seat${seats === 1 ? "" : "s"}. Add more seats in the customer portal to invite more members.`,
        code: "PLAN_SEAT_LIMIT",
        seats,
        current: currentMemberCount,
      },
      { status: 402 },
    );
  }
  return null;
}

/**
 * Check whether a user can create a new org (team workspace).
 *
 * Creating workspaces is always allowed (Vercel/GitHub model): a Free
 * workspace has 3 agents max, 1 member, no invites — harmless. The Team
 * plan gates *invites* (via membershipLimit), not workspace creation.
 * Returns null (allowed) unconditionally. Kept as a function for future
 * use + self-host multi-user where a company might want to restrict org
 * creation to admins.
 */
export async function checkCanCreateOrg(
  _orgId: string,
): Promise<NextResponse | null> {
  void _orgId;
  return null;
}

/**
 * Check whether an org can install a catalog template. Returns null when
 * allowed, or a 402 NextResponse when the template's requiredPlan gate
 * blocks the org's plan. Called by the install route BEFORE creating the
 * agent — and ALSO on the re-sync path (a downgraded org must not be
 * able to refresh a gated agent). Self-host always allows.
 */
export async function checkTemplateInstall(
  template: AgentTemplate,
  orgId: string,
): Promise<NextResponse | null> {
  if (!SAAS_MODE) return null;
  if (!template.requiredPlan) return null;
  const { plan } = await getEnforcementLimits(orgId);
  if (!planSatisfies(plan, template.requiredPlan)) {
    return NextResponse.json(
      {
        error: `"${template.name}" requires the ${template.requiredPlan} plan. Upgrade to install it.`,
        code: "PLAN_AGENT_LOCKED",
        requiredPlan: template.requiredPlan,
      },
      { status: 402 },
    );
  }
  return null;
}

// 60s cache REMOVED: quota counting is a fresh query per run. The
// runner only persists runs that produced events (storeRun in
// pg-runner), so the event log is the exact truth — attempts that never
// reached the backend don't consume quota, and there's no cache
// staleness to explain away. Free users are capped at 1 concurrent run
// (plan limit + "thread already running" guard), so message turns are
// sequential and every check sees all prior rows — no burst to defend
// against. One indexed COUNT per free-plan catalog run is cheap.

/**
 * Human-friendly countdown for the quota 402 message. The product
 * never states the free tier's run number — copy shows the tier
 * difference ("Daily usage limit · unlimited on Pro") plus this
 * countdown; the exact cap stays a server-side tunable.
 */
function formatCountdown(ms: number): string {
  if (ms <= 60_000) return "less than a minute";
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Enforce the catalog run gates on an agent run. Called by the
 * copilotkit route for EVERY run request; returns null when the run is
 * allowed.
 *
 * Two layers, deliberately separated:
 *
 * 1. Curator state — applies in BOTH modes (it is not billing):
 *    - Tombstone (template deleted): the agent stays listed for history
 *      browsing but can never run again → 410 AGENT_REMOVED. Runs die
 *      here, before anything reaches a backend. A managed agent whose
 *      template is somehow missing (row without tombstone — legacy/
 *      drift) is treated the same: a copy without a live source must
 *      not run ungated.
 *    - Template deactivated (is_active = false): the reversible kill
 *      switch → 402 AGENT_UNPUBLISHED. History stays viewable; re-show
 *      restores.
 *
 * 2. Monetization — SaaS-only (short-circuits on !SAAS_MODE):
 *    - requiredPlan at run time (catches orgs that downgraded AFTER
 *      installing) → 402 PLAN_AGENT_LOCKED.
 *    - freeDailyQuota: rolling-24h per-user cap for free-plan orgs →
 *      402 AGENT_QUOTA_EXCEEDED with resetsAt.
 *
 * Runs of manually-added agents (no sourceTemplateId) are never gated.
 *
 * The 402 carries `resetsAt` (epoch ms) so the UI could show a
 * countdown; the `error` string already embeds it in words.
 * `quota`/`used` are included for server-side debugging/logs only —
 * never surfaced in product copy.
 */
export async function checkCatalogRunGates(
  user: RequestUser,
  agentId: string,
  orgPlan?: PlanId,
): Promise<NextResponse | null> {
  const agent = await getAgent(agentId, user.orgId);
  if (!agent?.sourceTemplateId) return null;
  const template = await getTemplate(agent.sourceTemplateId);

  // Tombstone (or un-tombstoned copy of a missing template) — dead.
  // 410 Gone, not 404: the agent exists, the resource is permanently
  // removed. History remains viewable via connect/threads paths.
  if (!template || agent.templateRemovedAt) {
    return NextResponse.json(
      {
        error:
          "This agent was removed by its publisher. Past conversations remain viewable.",
        code: "AGENT_REMOVED",
      },
      { status: 410 },
    );
  }

  // Reversible kill switch — curator deactivated the template.
  if (!template.isActive) {
    return NextResponse.json(
      {
        error: `"${template.name}" has been unpublished by the curator and can't be used right now.`,
        code: "AGENT_UNPUBLISHED",
      },
      { status: 402 },
    );
  }

  // Monetization gates below are SaaS-only.
  if (!SAAS_MODE) return null;

  const { plan } = orgPlan
    ? { plan: orgPlan }
    : await getEnforcementLimits(user.orgId);

  // Plan gate at run time (defense in depth — the install path already
  // blocks gated templates; this catches orgs that downgraded AFTER
  // installing).
  if (template.requiredPlan && !planSatisfies(plan, template.requiredPlan)) {
    return NextResponse.json(
      {
        error: `"${template.name}" requires the ${template.requiredPlan} plan. Upgrade to keep using it.`,
        code: "PLAN_AGENT_LOCKED",
        requiredPlan: template.requiredPlan,
      },
      { status: 402 },
    );
  }

  // Daily quota applies to free-plan orgs only (paid = unlimited).
  if (template.freeDailyQuota == null || plan !== "free") return null;

  // Count fresh from the event log on EVERY run — no cache, no
  // pre-consumed slots. The runner only persists runs that produced
  // events (storeRun in pg-runner), so attempts that never reached the
  // backend (backend down, instant failure) don't consume quota; runs
  // that errored mid-stream do (they reached the backend). Free users
  // are capped at 1 concurrent run (plan limit + "thread already
  // running" guard), so message turns are sequential and every check
  // sees all prior rows — no burst window, no cache staleness.
  const usage = await getRunUsage(user.id, agent.id, QUOTA_WINDOW_MS);
  if (usage.count < template.freeDailyQuota) return null;

  // Reset moment: the oldest run inside the window falls out of it in
  // exactly (oldestAt + window). Fallback (oldest missing) is 1 hour —
  // a conservative "try again soon" rather than a wrong promise.
  const oldest = usage.oldestAt ? new Date(usage.oldestAt).getTime() : null;
  const resetsAt = oldest ? oldest + QUOTA_WINDOW_MS : Date.now() + 3_600_000;
  console.warn("[quota] free daily limit hit", {
    userId: user.id,
    orgId: user.orgId,
    agentId: agent.id,
    templateId: template.id,
    used: usage.count,
    quota: template.freeDailyQuota,
  });
  return NextResponse.json(
    {
      error: `You've reached your daily usage limit for this agent. It resets in ${formatCountdown(resetsAt - Date.now())}. Upgrade to Pro for unlimited usage.`,
      code: "AGENT_QUOTA_EXCEEDED",
      resetsAt,
      quota: template.freeDailyQuota,
      used: usage.count,
    },
    { status: 402 },
  );
}

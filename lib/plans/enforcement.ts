import { NextResponse } from "next/server";
import { SAAS_MODE } from "@/lib/config/saas";
import { getOrgPlan, getSubscription } from "@/lib/billing/subscription-store";
import { getPlanLimits, type PlanId, type PlanLimits } from "@/lib/billing/plans";
import { listAgents } from "@/lib/agents/agent-store";

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
 * We count the org's current agents and compare to the plan's maxAgents.
 * `null` maxAgents = unlimited (pro / team).
 */
export async function checkAgentCountLimit(
  orgId: string,
): Promise<NextResponse | null> {
  if (!SAAS_MODE) return null;
  const { limits } = await getEnforcementLimits(orgId);
  if (limits.maxAgents === null) return null; // unlimited
  const current = await listAgents(orgId);
  if (current.length >= limits.maxAgents) {
    return NextResponse.json(
      {
        error: `Your plan allows up to ${limits.maxAgents} agent${limits.maxAgents === 1 ? "" : "s"}. Upgrade to add more.`,
        code: "PLAN_AGENT_LIMIT",
        limit: limits.maxAgents,
        current: current.length,
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

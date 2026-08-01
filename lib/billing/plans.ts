import { BILLING_ENABLED } from "@/lib/config/saas";

/**
 * Plan definitions for the hosted SaaS offering.
 *
 * Self-host (`!SAAS_MODE`): `getPlanLimits("self-host")` returns the
 * unlimited sentinel — every check short-circuits to "allowed". Self-hosters
 * (solo or multi-user) get full capability regardless of "plan".
 *
 * SaaS plans (when `SAAS_MODE`):
 *   - free  : 3 agents, 1 concurrent run, 10 runs/min, 1 member (personal)
 *   - pro   : unlimited agents, 3 concurrent runs, 20 runs/min, 1 member
 *   - team  : unlimited agents, 5 concurrent runs, 20 runs/min, per-seat
 *
 * Dollar amounts are NOT stored here — they live in Stripe. The Stripe Price
 * IDs (from env: STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM) are what the checkout
 * route sends to Stripe; Stripe renders the actual price to the customer.
 */

export type PlanId = "self-host" | "free" | "pro" | "team";

export interface PlanLimits {
  /** Max agents an org can configure. `null` = unlimited. */
  maxAgents: number | null;
  /** Max in-flight concurrent agent runs per user. */
  concurrentRuns: number;
  /** Max agent run requests per minute per user. */
  runsPerMinute: number;
  /** Max org members (seats). `null` = unlimited (self-host multi-user). */
  maxMembers: number | null;
  /** Can the user create additional orgs (team workspaces)? */
  canCreateOrg: boolean;
  /** Pretty name for UI badges. */
  label: string;
}

/** Sentinel: unlimited everything. Returned for self-host deployments. */
const SELF_HOST_LIMITS: PlanLimits = {
  maxAgents: null,
  concurrentRuns: 3,
  runsPerMinute: 20,
  maxMembers: null,
  canCreateOrg: true,
  label: "Self-hosted",
};

const PLAN_LIMITS: Record<Exclude<PlanId, "self-host">, PlanLimits> = {
  free: {
    maxAgents: 3,
    concurrentRuns: 1,
    runsPerMinute: 10,
    maxMembers: 1,
    canCreateOrg: false,
    label: "Free",
  },
  pro: {
    maxAgents: null,
    concurrentRuns: 3,
    runsPerMinute: 20,
    maxMembers: 1,
    canCreateOrg: false,
    label: "Pro",
  },
  team: {
    maxAgents: null,
    concurrentRuns: 5,
    runsPerMinute: 20,
    maxMembers: null, // governed by subscription.seats (per-seat billing)
    canCreateOrg: true,
    label: "Team",
  },
};

/**
 * The limits that apply to the given plan id. Self-host always returns the
 * unlimited sentinel — self-hosters are never plan-limited regardless of
 * how this function is called.
 */
export function getPlanLimits(plan: PlanId): PlanLimits {
  if (plan === "self-host") return SELF_HOST_LIMITS;
  return PLAN_LIMITS[plan];
}

/**
 * Default plan for an org with no subscription row (SaaS: free;
 * self-host: self-host). Used by the subscription store + enforcement
 * layer as the fallback when no row exists yet.
 */
export function defaultPlan(): PlanId {
  return BILLING_ENABLED ? "free" : "self-host";
}

/**
 * Map a Stripe Price ID back to a plan id. The price IDs come from env
 * (`STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`). Anything else (including
 * `undefined`) resolves to "free" — this is the safe default for the
 * webhook handler when a price doesn't match a known plan (e.g. an
 * archived price from a pre-launch test).
 */
export function planIdFromPriceId(priceId: string | null | undefined): PlanId {
  // Guard empty price ids first — an unset price must never match an unset
  // env var (`undefined === undefined` would otherwise wrongly return "team").
  if (!priceId) return "free";
  if (priceId === process.env.STRIPE_PRICE_TEAM) return "team";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  return "free";
}

/**
 * The Stripe Price ID to send to Checkout for the given paid plan.
 * Returns `null` for free / self-host (no checkout session) and when the
 * env var is missing (misconfiguration — the checkout route surfaces a
 * 500 rather than silently sending a null price to Stripe).
 */
export function priceIdForPlan(plan: "pro" | "team"): string | null {
  if (plan === "team") return process.env.STRIPE_PRICE_TEAM ?? null;
  if (plan === "pro") return process.env.STRIPE_PRICE_PRO ?? null;
  return null;
}

/** All SaaS plans, for the pricing page / landing. */
export const SAAS_PLANS: { id: PlanId; priceId: string | null }[] = [
  { id: "free", priceId: null },
  { id: "pro", priceId: process.env.STRIPE_PRICE_PRO ?? null },
  { id: "team", priceId: process.env.STRIPE_PRICE_TEAM ?? null },
];

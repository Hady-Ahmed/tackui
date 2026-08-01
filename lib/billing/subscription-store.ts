import { query } from "@/lib/db/pg";
import { z } from "zod";
import { defaultPlan, type PlanId } from "./plans";
import { BILLING_ENABLED } from "@/lib/config/saas";

/**
 * Async CRUD for the `subscriptions` table (zod-validated, pg.Pool-backed).
 * Mirrors the agent-store.ts conventions. The webhook handler is the sole
 * writer; reads happen from the plan-enforcement layer
 * (lib/plans/limits.ts) which caches per-request.
 *
 * An org with no row is treated as the default plan (free under SaaS,
 * self-host when !SAAS_MODE). getOrgPlan / getSubscription return null
 * for missing rows; callers apply the default via defaultPlan().
 */

const planSchema = z.enum(["free", "pro", "team"]);

/** Row shape stored in the `subscriptions` table. */
export interface SubscriptionRow {
  orgId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  plan: PlanId;
  status: string;
  seats: number;
  currentPeriodEnd: Date | null;
}

/** Shape returned to the client (no Stripe IDs leak to the browser). */
export interface PublicSubscription {
  plan: PlanId;
  status: string;
  seats: number;
  currentPeriodEnd: number | null; // unix seconds, or null
}

function rowToSubscription(row: SubscriptionRow): SubscriptionRow {
  return {
    orgId: row.orgId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    plan: row.plan,
    status: row.status,
    seats: row.seats,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

function toPublic(row: SubscriptionRow): PublicSubscription {
  return {
    plan: row.plan,
    status: row.status,
    seats: row.seats,
    currentPeriodEnd: row.currentPeriodEnd
      ? Math.floor(row.currentPeriodEnd.getTime() / 1000)
      : null,
  };
}

interface SubscriptionDbRow {
  org_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: string;
  status: string;
  seats: number;
  current_period_end: Date | null;
}

function dbRowToRow(r: SubscriptionDbRow): SubscriptionRow {
  return {
    orgId: r.org_id,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    plan: planSchema.parse(r.plan),
    status: r.status,
    seats: r.seats,
    currentPeriodEnd: r.current_period_end,
  };
}

/**
 * Get the subscription row for an org, or null if no row exists. Callers
 * apply the default plan (free / self-host) when this returns null.
 */
export async function getSubscription(
  orgId: string,
): Promise<SubscriptionRow | null> {
  const result = await query<SubscriptionDbRow>(
    `SELECT org_id, stripe_customer_id, stripe_subscription_id, plan, status, seats, current_period_end
     FROM subscriptions WHERE org_id = $1`,
    [orgId],
  );
  return result.rows[0] ? dbRowToRow(result.rows[0]) : null;
}

/**
 * Resolve the effective plan for an org: the stored plan, or the default
 * (free under SaaS, self-host when !SAAS_MODE) when no row exists. This
 * is the read path used by the enforcement layer — it never returns null.
 *
 * Note: the self-host "unlimited" short-circuit lives in the enforcement
 * layer (it gates on SAAS_MODE before calling this), not here. This fn
 * just reports what the subscriptions table says + the default fallback.
 */
export async function getOrgPlan(orgId: string): Promise<PlanId> {
  const sub = await getSubscription(orgId);
  return sub?.plan ?? defaultPlan();
}

/**
 * Resolve the effective subscription for an org, with the default plan
 * filled in for missing rows. Used by the GET /api/billing/subscription
 * route to render the account-menu badge.
 */
export async function getOrgSubscription(
  orgId: string,
): Promise<{ plan: PlanId; public: PublicSubscription }> {
  const sub = await getSubscription(orgId);
  if (!sub) {
    return {
      plan: defaultPlan(),
      public: {
        plan: defaultPlan(),
        status: "active",
        seats: 1,
        currentPeriodEnd: null,
      },
    };
  }
  return { plan: sub.plan, public: toPublic(sub) };
}

/** Input shape for upsertSubscription — what the webhook handler writes. */
export const upsertSubscriptionSchema = z.object({
  orgId: z.string().min(1),
  stripeCustomerId: z.string().min(1),
  stripeSubscriptionId: z.string().min(1),
  plan: planSchema,
  status: z.string().min(1),
  seats: z.number().int().min(1).max(1000),
  currentPeriodEnd: z.date().nullable(),
});
export type UpsertSubscriptionInput = z.infer<typeof upsertSubscriptionSchema>;

/**
 * Insert-or-update a subscription row, keyed by `org_id`. Called by the
 * webhook handler on checkout.session.completed + customer.subscription.updated.
 * Returns the stored row.
 */
export async function upsertSubscription(
  input: UpsertSubscriptionInput,
): Promise<SubscriptionRow> {
  const parsed = upsertSubscriptionSchema.parse(input);
  const result = await query<SubscriptionDbRow>(
    `INSERT INTO subscriptions
       (org_id, stripe_customer_id, stripe_subscription_id, plan, status, seats, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (org_id) DO UPDATE SET
       stripe_customer_id     = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       plan                   = EXCLUDED.plan,
       status                 = EXCLUDED.status,
       seats                  = EXCLUDED.seats,
       current_period_end     = EXCLUDED.current_period_end,
       updated_at             = now()
     RETURNING org_id, stripe_customer_id, stripe_subscription_id, plan, status, seats, current_period_end`,
    [
      parsed.orgId,
      parsed.stripeCustomerId,
      parsed.stripeSubscriptionId,
      parsed.plan,
      parsed.status,
      parsed.seats,
      parsed.currentPeriodEnd,
    ],
  );
  return rowToSubscription(dbRowToRow(result.rows[0]));
}

/**
 * Delete a subscription row (downgrade to free). Called by the webhook
 * handler on customer.subscription.deleted. Returns true if a row was
 * deleted.
 */
export async function deleteSubscription(orgId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM subscriptions WHERE org_id = $1`,
    [orgId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Look up an org id by Stripe customer id. Used by the webhook handler to
 * resolve which org a subscription event belongs to (Stripe events carry
 * the customer id, not our org id).
 */
export async function getOrgIdByCustomerId(
  stripeCustomerId: string,
): Promise<string | null> {
  const result = await query<{ org_id: string }>(
    `SELECT org_id FROM subscriptions WHERE stripe_customer_id = $1`,
    [stripeCustomerId],
  );
  return result.rows[0]?.org_id ?? null;
}

/**
 * Whether a user is a member of any org that's on the Team plan. Used by
 * the SaaS org-creation gate (`allowUserToCreateOrganization`): only
 * team-plan users can create additional workspaces. Self-host returns
 * true unconditionally — multi-user self-host allows unlimited orgs.
 *
 * Joins `member` (better-auth's org memberships) to `subscriptions`.
 */
export async function userHasTeamPlan(userId: string): Promise<boolean> {
  if (!BILLING_ENABLED) return true;
  const result = await query<{ exists: number }>(
    `SELECT 1 AS exists
     FROM member m
     JOIN subscriptions s ON s.org_id = m."organizationId"
     WHERE m."userId" = $1 AND s.plan = 'team'
     LIMIT 1`,
    [userId],
  );
  return result.rows.length > 0;
}

/**
 * The membership cap for an org, as a number (Infinity when unlimited).
 * Used by better-auth's `membershipLimit` option for server-side seat
 * enforcement. Self-host returns Infinity. SaaS: free/pro = 1 (personal,
 * no invites), team = subscription.seats.
 */
export async function getMembershipLimit(
  orgId: string,
): Promise<number> {
  if (!BILLING_ENABLED) return Infinity;
  const sub = await getSubscription(orgId);
  if (!sub) return 1; // free default = personal
  if (sub.plan === "team") return sub.seats;
  return 1; // pro = personal too
}

export { toPublic };

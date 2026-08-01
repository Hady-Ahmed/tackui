import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { getOrgSubscription } from "@/lib/billing/subscription-store";
import { getPlanLimits, type PlanId } from "@/lib/billing/plans";

/**
 * GET /api/billing/subscription — the current org's plan + limits. Read by
 * the account-menu badge and any client code that needs to gate features
 * on plan. Available to any authenticated user in the org (members need
 * to see the plan too — e.g. to know whether they can invite people).
 *
 * Returns 404 when billing isn't configured (self-host / SaaS-without-Stripe).
 * In that case the client treats the response as "no badge".
 */
export async function GET() {
  if (!BILLING_ENABLED) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { plan, public: sub } = await getOrgSubscription(user.orgId);
  const limits = getPlanLimits(plan as PlanId);
  return NextResponse.json({
    plan: sub.plan,
    status: sub.status,
    seats: sub.seats,
    currentPeriodEnd: sub.currentPeriodEnd,
    limits,
  });
}

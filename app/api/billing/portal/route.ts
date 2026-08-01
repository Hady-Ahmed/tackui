import { NextResponse } from "next/server";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { createPortalSession } from "@/lib/billing/checkout";

/**
 * POST /api/billing/portal — start a Stripe Customer Portal session so the
 * org owner/admin can manage their subscription (update card, cancel,
 * change seats). Only org owners/admins can open the portal
 * (canManageAgents).
 *
 * Returns 404 when billing isn't configured (self-host / SaaS-without-Stripe)
 * and 404 when the org has no subscription to manage.
 */
export async function POST() {
  if (!BILLING_ENABLED) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await canManageAgents(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await createPortalSession(user.orgId);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }
  return NextResponse.json(result);
}

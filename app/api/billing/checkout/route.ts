import { NextResponse } from "next/server";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { createCheckoutSession } from "@/lib/billing/checkout";
import { z } from "zod";

/**
 * POST /api/billing/checkout — start a Stripe Checkout session for a paid
 * plan upgrade. Only org owners/admins can upgrade (canManageAgents). The
 * org id comes from the session, never the body.
 *
 * Returns 404 when billing isn't configured (self-host, or SaaS without
 * Stripe). The body picks the plan + optional seat count (team only).
 */
const bodySchema = z.object({
  plan: z.enum(["pro", "team"]),
  seats: z.number().int().min(1).max(1000).optional(),
});

export async function POST(request: Request) {
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
  if (!user.email) {
    return NextResponse.json(
      { error: "An email is required to start a subscription." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await createCheckoutSession(user.orgId, parsed.data.plan, {
    customerEmail: user.email,
    seats: parsed.data.seats,
  });
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json(result);
}

import { getStripe } from "./stripe";
import { priceIdForPlan } from "./plans";

/**
 * Stripe Checkout + Customer Portal session helpers.
 *
 * Both are auth-gated at the route layer — these functions assume the
 * caller has already verified the user owns the org they're checking out
 * for. The org id is threaded into Stripe via `metadata` so the webhook
 * handler can route events back to the right org without a DB lookup on
 * the happy path.
 */

/** Create a Stripe Checkout Session for a paid plan upgrade. */
export async function createCheckoutSession(
  orgId: string,
  plan: "pro" | "team",
  opts: { customerEmail: string; seats?: number },
): Promise<{ url: string } | { error: string }> {
  const stripe = getStripe();
  if (!stripe) return { error: "Billing is not configured." };
  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    return { error: `No Stripe price configured for the ${plan} plan.` };
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price: priceId,
        // Per-seat plans (team) use quantity = seats; flat plans (pro) keep 1.
        quantity: plan === "team" ? Math.max(1, opts.seats ?? 1) : 1,
      },
    ],
    // Carry the org id through the redirect so the webhook can attribute
    // the checkout to the right org without guessing from the customer.
    metadata: { orgId },
    subscription_data: {
      metadata: { orgId },
    },
    customer_email: opts.customerEmail,
    success_url: `${process.env.BETTER_AUTH_URL}/app?upgraded=${plan}`,
    cancel_url: `${process.env.BETTER_AUTH_URL}/app?upgrade_cancelled=1`,
  });

  if (!session.url) return { error: "Stripe returned no checkout URL." };
  return { url: session.url };
}

/** Create a Stripe Customer Portal session for managing an existing subscription. */
export async function createPortalSession(
  orgId: string,
): Promise<{ url: string } | { error: string }> {
  const stripe = getStripe();
  if (!stripe) return { error: "Billing is not configured." };

  // Resolve the Stripe customer id from our subscriptions table. We don't
  // trust a client-supplied customer id — always look it up by org.
  const { getSubscription } = await import("./subscription-store");
  const sub = await getSubscription(orgId);
  if (!sub) {
    return { error: "No active subscription to manage." };
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${process.env.BETTER_AUTH_URL}/app`,
  });
  return { url: session.url };
}

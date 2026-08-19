import { NextResponse } from "next/server";
import { getStripe, getWebhookSecret } from "@/lib/billing/stripe";
import type { Stripe } from "@/lib/billing/stripe";
import {
  upsertSubscription,
  deleteSubscription,
  getOrgIdByCustomerId,
} from "@/lib/billing/subscription-store";
import { planIdFromPriceId, type PlanId } from "@/lib/billing/plans";

/**
 * POST /api/billing/webhook — Stripe webhook receiver.
 *
 * This route is EXCLUDED from the proxy cookie gate and the per-IP rate
 * limit (Stripe calls it server-to-server with no session cookie). It
 * verifies the Stripe signature on every request, so a forged request
 * without the signing secret is rejected before any DB write.
 *
 * Handles three events:
 *   - checkout.session.completed      → upsert row (org id from metadata)
 *   - customer.subscription.updated    → upsert row (plan/seats/status)
 *   - customer.subscription.deleted    → delete row (downgrade to free)
 *
 * For updated/deleted we resolve the org id by looking up the customer id
 * in the subscriptions table (the row was created on checkout). Returns
 * 200 for handled + safely-ignored events so Stripe doesn't retry.
 */

export async function POST(request: Request) {
  const stripe = getStripe();
  const secret = getWebhookSecret();
  if (!stripe || !secret) {
    // Billing not configured — nothing to do. 200 so Stripe doesn't retry.
    return NextResponse.json({ received: false, reason: "not-configured" });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[billing-webhook] signature verification failed", { error: msg });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(stripe, event);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        await handleSubscriptionChange(event.data.object as Stripe.Subscription);
        break;
      }
      case "customer.subscription.deleted": {
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      }
      default:
        // Unhandled event type — acknowledge so Stripe doesn't retry, but
        // log at debug so we can spot a misconfigured webhook sending
        // events we don't expect.
        console.log("[billing-webhook] ignored event", { type: event.type });
    }
  } catch (err) {
    // A 500 makes Stripe retry with exponential backoff. We only want
    // retries for transient failures (DB down), not for bad data — but
    // surfacing the error message in logs is enough to diagnose.
    console.error("[billing-webhook] handler error", {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(
  stripe: Stripe,
  event: Stripe.Event,
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const orgId = session.metadata?.orgId;
  if (!orgId) {
    console.error("[billing-webhook] checkout has no orgId metadata", {
      sessionId: session.id,
    });
    return;
  }
  // Expand the subscription to read plan + seats + period. The checkout
  // session's `subscription` field is an id; retrieve it.
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : null;
  if (!subscriptionId) {
    console.error("[billing-webhook] checkout has no subscription", {
      sessionId: session.id,
    });
    return;
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await writeSubscriptionRow(orgId, session.customer, subscription);
}

async function handleSubscriptionChange(sub: Stripe.Subscription): Promise<void> {
  // Resolve the org id. Prefer subscription.metadata (set at checkout);
  // fall back to a customer-id lookup (row created on checkout).
  // Cross-check: if both sources exist and disagree, someone tampered
  // with the Stripe-side metadata (e.g. a Stripe-account compromise) to
  // re-attribute the subscription to a different org. Drop the event
  // rather than writing a paid-plan row for an org that never paid.
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? "";
  const metadataOrgId = sub.metadata?.orgId as string | undefined;
  const customerOrgId = await getOrgIdByCustomerId(customerId);
  const orgId = metadataOrgId ?? customerOrgId;
  if (!orgId) {
    console.error("[billing-webhook] subscription has no resolvable orgId", {
      subscriptionId: sub.id,
    });
    return;
  }
  if (metadataOrgId && customerOrgId && metadataOrgId !== customerOrgId) {
    console.error("[billing-webhook] orgId mismatch — dropping event", {
      subscriptionId: sub.id,
      metadataOrgId,
      customerOrgId,
    });
    return;
  }
  await writeSubscriptionRow(orgId, sub.customer, sub);
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? "";
  const metadataOrgId = sub.metadata?.orgId as string | undefined;
  const customerOrgId = await getOrgIdByCustomerId(customerId);
  // Same cross-check as handleSubscriptionChange — refuse to act on a
  // tampered metadata value.
  if (metadataOrgId && customerOrgId && metadataOrgId !== customerOrgId) {
    console.error("[billing-webhook] orgId mismatch on delete — dropping", {
      subscriptionId: sub.id,
      metadataOrgId,
      customerOrgId,
    });
    return;
  }
  const orgId = metadataOrgId ?? customerOrgId;
  if (!orgId) return;
  await deleteSubscription(orgId);
}

/** Upsert a subscription row from a Stripe Subscription object. */
async function writeSubscriptionRow(
  orgId: string,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  sub: Stripe.Subscription,
): Promise<void> {
  // customer can be an id string, an expanded Customer, or a DeletedCustomer.
  const customerId =
    typeof customer === "string" ? customer : customer?.id ?? "";
  if (!customerId) {
    console.error("[billing-webhook] subscription has no customer id", {
      subscriptionId: sub.id,
    });
    return;
  }
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;
  const plan = planIdFromPriceId(priceId) as PlanId;
  const seats = item?.quantity ?? 1;
  // In the current Stripe API version, the billing period lives on the
  // subscription *item*, not the subscription itself.
  const periodEnd = item?.current_period_end ?? null;

  await upsertSubscription({
    orgId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    plan: plan === "self-host" ? "free" : plan,
    status: sub.status,
    seats,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
  });
}

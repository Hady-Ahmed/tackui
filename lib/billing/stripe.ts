import Stripe from "stripe";
import { BILLING_ENABLED } from "@/lib/config/saas";

/**
 * Stripe SDK singleton.
 *
 * `null` when `!BILLING_ENABLED` (self-host, or SaaS without a Stripe key
 * configured). Every billing route checks `getStripe()` and returns 404 /
 * 503 when null — the import is side-effect-free (Stripe's constructor
 * doesn't make network calls), so it's safe to load in self-host mode; we
 * just choose not to so the dependency never initializes there.
 *
 * Read at module load so a missing key is loud at boot (the singleton is
 * null and every consumer must handle null), not deferred to first use.
 */
let singleton: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!BILLING_ENABLED) return null;
  if (singleton) return singleton;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  singleton = new Stripe(key, {
    // Pin the API version to match @types/stripe. Stripe is strict about
    // this — bumping the SDK without bumping this breaks type-checks by
    // design (forces us to review breaking API changes).
    apiVersion: "2026-07-29.dahlia" as Stripe.LatestApiVersion,
    appInfo: {
      name: "AG-UI Chat",
    },
  });
  return singleton;
}

/** Webhook signing secret (from Stripe CLI or the dashboard). */
export function getWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET ?? null;
}

export type { Stripe };

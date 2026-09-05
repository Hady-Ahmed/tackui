/**
 * SaaS mode feature flags.
 *
 * This file is the single source of truth for whether the deployment is the
 * hosted SaaS instance (`SAAS_MODE=true`) or a self-host
 * deployment (the default — `SAAS_MODE` unset).
 *
 * All SaaS-only behaviour (billing, plan enforcement, landing page, legal
 * pages, forced SSRF guard) reads from these flags so self-hosters never
 * touch SaaS code paths. There is no separate codebase — one repo, two
 * modes, gated by env.
 *
 * Module-level constants are evaluated once at boot (same convention as
 * proxy.ts, lib/auth/auth.ts, lib/net/safe-fetch.ts). Restart the server
 * after changing these in `.env.local`.
 */

/**
 * True only on the hosted SaaS instance. Self-hosters leave this unset.
 * Drives: landing page at `/`, chat at `/app`, legal pages, billing UI,
 * plan enforcement, and the forced-on SSRF guard (see SSRF_GUARD_FORCE_ON).
 */
export const SAAS_MODE = process.env.SAAS_MODE === "true";

/**
 * True when SaaS mode is on AND a Stripe secret key is configured.
 * Billing UI / routes only mount when this is true. Lets you run SaaS
 * mode without Stripe during initial bring-up (everything except
 * checkout works — users sit on the Free plan).
 */
export const BILLING_ENABLED = SAAS_MODE && !!process.env.STRIPE_SECRET_KEY;

/**
 * True when the SSRF guard must always run, ignoring the
 * `ALLOW_PRIVATE_ENDPOINTS` opt-in. Hard-locked ON under SaaS mode so a
 * misconfigured env var can never expose the shared host's private network
 * to a tenant. Self-hosters keep the opt-in (single-tenant — they own the
 * network they'd be reaching).
 *
 * See lib/net/safe-fetch.ts — `assertSafeUrl` reads this directly.
 */
export const SSRF_GUARD_FORCE_ON = SAAS_MODE;

/**
 * The error message returned to the user when the SSRF guard rejects an
 * endpoint. Self-hosters get the opt-in hint; SaaS users get a clear
 * "not allowed here" message (no env-var leakage).
 */
export const SSRF_REJECTION_MESSAGE = SSRF_GUARD_FORCE_ON
  ? "Private/internal endpoints are not permitted on the hosted service. Use a publicly reachable endpoint."
  : "Endpoint resolves to a private or internal address. Set ALLOW_PRIVATE_ENDPOINTS=true if this is intentional (e.g. agent backend running on the same host).";

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { getPlanLimits, type PlanId } from "@/lib/billing/plans";
import { MarketingLayout } from "@/components/marketing-layout";
import { getCurrentUser } from "@/lib/auth/context";

/**
 * Pricing page — SaaS mode only. Self-host deployments redirect to `/app`.
 *
 * Lists the Free / Pro / Team tiers with their feature gates. Copy leads
 * with outcomes (not limits): the tier names what you get, the catalog
 * usage limits surface where they're actually encountered — the run 402
 * and the rolling-window footnote below (see the usage-limit copy policy
 * in AGENTS.md).
 *
 * The dollar amounts shown here are marketing prices that must match the
 * Stripe Prices configured via STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM —
 * Stripe is the source of truth at checkout, so update both together.
 * Paid tiers link to /signup (so the user signs up, then upgrades from
 * the account menu's "Manage subscription" → Stripe Customer Portal /
 * Checkout).
 */
const TIERS: { id: PlanId; tagline: string; price: string; features: string[] }[] = [
  {
    id: "free",
    tagline: "Try it out. See what agents can actually do.",
    price: "$0",
    features: [
      "Run any agent from the catalog",
      "Daily usage limits on catalog agents (enough to get a feel)",
      "Connect up to 3 agents — from the catalog or your own",
      "1 agent running at a time",
      "Standard rate limits",
    ],
  },
  {
    id: "pro",
    tagline: "For when one agent isn't enough.",
    price: "$10/mo",
    features: [
      "Much higher usage on every catalog agent",
      "Unlimited agents",
      "3 agents running at a time",
      "Higher rate limits",
      "Priority support",
    ],
  },
  {
    id: "team",
    tagline: "For teams running agents together.",
    price: "$15/seat/mo",
    features: [
      "Everything in Pro, for every seat",
      "Shared workspace with invites",
      "5 agents running at a time",
      "Per-seat billing",
    ],
  },
];

// Force request-time rendering — BILLING_ENABLED is a runtime env var.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing — TackUI",
  description:
    "Run real AI agents in your browser. Free to start — no setup required.",
};

export default async function PricingPage() {
  if (!BILLING_ENABLED) redirect("/app");

  const user = await getCurrentUser();

  return (
    <MarketingLayout>
      <div className="py-16">
        <h1 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
          Run real AI agents in your browser.
        </h1>
        <p className="mt-2 text-center text-zinc-600 dark:text-zinc-400">
          Start free — no setup required.
        </p>

        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          {TIERS.map((tier) => {
            const limits = getPlanLimits(tier.id);
            const isFree = tier.id === "free";
            // Logged-in users get "Go to app" on every tier — plan
            // management lives in the account menu, not here. Logged-out
            // users get "Sign up free" (free tier) or "Sign in to
            // upgrade" (paid tiers).
            const label = user
              ? "Go to app"
              : isFree
                ? "Sign up free"
                : "Sign in to upgrade";
            const href = user ? "/app" : isFree ? "/signup" : "/login?redirect=/app";
            return (
              <div
                key={tier.id}
                className={`flex flex-col rounded-xl border p-6 ${
                  tier.id === "pro"
                    ? "border-blue-300 ring-1 ring-blue-300 dark:border-blue-700 dark:ring-blue-700"
                    : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold">{limits.label}</h2>
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {tier.price}
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-500">{tier.tagline}</p>
                {tier.id === "pro" && (
                  <span className="mt-2 self-start rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
                    Popular
                  </span>
                )}
                <ul className="mt-4 flex-1 space-y-2 text-sm">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-blue-600 dark:text-blue-400">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={href}
                  className={`mt-6 block rounded-lg px-4 py-2 text-center text-sm font-medium transition-all ${
                    isFree && !user
                      ? "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 active:scale-[0.98]"
                      : "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200 active:scale-[0.98]"
                  }`}
                >
                  {label}
                </Link>
              </div>
            );
          })}
        </div>

        <div className="mt-12 text-center text-sm text-zinc-500">
          <p>
            Catalog usage allowances are per agent and reset on a rolling
            24-hour window. They apply to catalog agents only — agents you
            connect yourself are not part of the catalog.
          </p>
        </div>

        <div className="mt-12 text-center text-sm text-zinc-500">
          <p>
            Prefer to host it yourself?{" "}
            <a
              href="https://github.com/Hady-Ahmed/tackui"
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              TackUI is source available (Elastic License 2.0)
            </a>{" "}
            — self-host with unlimited everything.
          </p>
        </div>
      </div>
    </MarketingLayout>
  );
}

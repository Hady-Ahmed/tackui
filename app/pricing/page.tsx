import Link from "next/link";
import { redirect } from "next/navigation";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { getPlanLimits, type PlanId } from "@/lib/billing/plans";

/**
 * Pricing page — SaaS mode only. Self-host deployments redirect to `/app`.
 *
 * Lists the Free / Pro / Team tiers with their feature gates. The actual
 * dollar amounts live in Stripe (the plan *structure* is code; the price
 * is Stripe's job). Paid tiers link to /signup (so the user signs up, then
 * upgrades from the account menu's "Manage subscription" → Stripe
 * Customer Portal / Checkout).
 */
const TIERS: { id: PlanId; tagline: string; features: string[] }[] = [
  {
    id: "free",
    tagline: "Try it out. Connect up to 3 agents.",
    features: [
      "3 agents",
      "1 concurrent run",
      "Standard rate limits",
      "Community support",
    ],
  },
  {
    id: "pro",
    tagline: "For individuals with many agents.",
    features: [
      "Unlimited agents",
      "3 concurrent runs",
      "Higher rate limits",
      "Priority support",
    ],
  },
  {
    id: "team",
    tagline: "Collaborate with per-seat workspaces.",
    features: [
      "Everything in Pro",
      "5 concurrent runs",
      "Team workspaces + invites",
      "Per-seat billing",
      "Priority support",
    ],
  },
];

export default function PricingPage() {
  if (!BILLING_ENABLED) redirect("/app");

  return (
    <div className="mx-auto max-w-5xl px-6 py-16 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
        Pricing
      </h1>
      <p className="mt-2 text-center text-zinc-600 dark:text-zinc-400">
        Free to start. Upgrade when you need more agents or team seats.
      </p>

      <div className="mt-12 grid gap-6 sm:grid-cols-3">
        {TIERS.map((tier) => {
          const limits = getPlanLimits(tier.id);
          const isFree = tier.id === "free";
          return (
            <div
              key={tier.id}
              className={`flex flex-col rounded-xl border p-6 ${
                tier.id === "pro"
                  ? "border-blue-300 ring-1 ring-blue-300 dark:border-blue-700 dark:ring-blue-700"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <h2 className="text-lg font-semibold">{limits.label}</h2>
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
                href={isFree ? "/signup" : "/login?redirect=/app"}
                className={`mt-6 block rounded-lg px-4 py-2 text-center text-sm font-medium transition-colors ${
                  isFree
                    ? "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    : "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                }`}
              >
                {isFree ? "Sign up free" : "Sign in to upgrade"}
              </Link>
            </div>
          );
        })}
      </div>

      <div className="mt-12 text-center text-sm text-zinc-500">
        <p>
          Prefer to host it yourself?{" "}
          <a
            href="https://github.com/"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            AG-UI Chat is open source (Apache-2.0)
          </a>{" "}
          — self-host with unlimited everything.
        </p>
      </div>

      <div className="mt-8 text-center">
        <Link
          href="/"
          className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← Back to home
        </Link>
      </div>
    </div>
  );
}

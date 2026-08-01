"use client";

import { useState } from "react";
import { useBilling } from "@/lib/billing/use-billing";

/**
 * Upgrade dialog — lets a user start a Stripe Checkout session for a paid
 * plan. Opens from the account menu's "Upgrade plan" button.
 *
 * Shows the Pro + Team options. The user's current plan is marked as
 * "current" (greyed). Pro→ checkout with quantity 1; Team → checkout with
 * a seats input (defaults to 1, min 1). On success the browser is sent to
 * the Stripe-hosted Checkout URL; the webhook then upserts the
 * subscription row and the account-menu badge updates on next load.
 *
 * Only renders under SaaS mode with billing configured — the parent
 * (account-menu) gates on `billing` being non-null before mounting this.
 */
export function UpgradeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { billing } = useBilling();
  const [seats, setSeats] = useState(1);
  const [submitting, setSubmitting] = useState<null | "pro" | "team">(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const currentPlan = billing?.plan ?? "free";

  async function checkout(plan: "pro" | "team") {
    setSubmitting(plan);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          plan === "team" ? { plan, seats: Math.max(1, seats) } : { plan },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to start checkout");
        setSubmitting(null);
        return;
      }
      // Hard redirect to Stripe-hosted Checkout.
      if (data.url) window.location.assign(data.url);
    } catch {
      setError("Network error — please try again");
      setSubmitting(null);
    }
  }

  const tiers: { id: "pro" | "team"; name: string; price: string; features: string[] }[] = [
    {
      id: "pro",
      name: "Pro",
      price: "Unlimited agents · 3 concurrent runs",
      features: ["Unlimited agents", "3 concurrent runs", "Higher rate limits", "Priority support"],
    },
    {
      id: "team",
      name: "Team",
      price: "Per seat · 5 concurrent runs",
      features: ["Everything in Pro", "5 concurrent runs", "Team workspaces + invites", "Per-seat billing"],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Upgrade plan
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          You&apos;re currently on the {billing?.limits?.label ?? currentPlan} plan.
        </p>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-3">
          {tiers.map((tier) => {
            const isCurrent = currentPlan === tier.id;
            return (
              <div
                key={tier.id}
                className={`rounded-lg border p-4 ${
                  isCurrent
                    ? "border-zinc-200 opacity-60 dark:border-zinc-800"
                    : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">{tier.name}</p>
                    <p className="text-xs text-zinc-500">{tier.price}</p>
                  </div>
                  {isCurrent ? (
                    <span className="text-xs font-medium text-zinc-500">Current</span>
                  ) : (
                    <button
                      onClick={() => checkout(tier.id)}
                      disabled={submitting !== null}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {submitting === tier.id ? "Redirecting…" : `Upgrade to ${tier.name}`}
                    </button>
                  )}
                </div>
                {tier.id === "team" && !isCurrent && (
                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <label className="text-zinc-600 dark:text-zinc-400" htmlFor="seats">
                      Seats
                    </label>
                    <input
                      id="seats"
                      type="number"
                      min={1}
                      max={1000}
                      value={seats}
                      onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))}
                      className="w-20 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                    <span className="text-xs text-zinc-500">
                      You can add more later in the customer portal.
                    </span>
                  </div>
                )}
                <ul className="mt-3 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5">
                      <span className="text-blue-600 dark:text-blue-400">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

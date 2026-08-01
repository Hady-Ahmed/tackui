"use client";

import { useEffect, useState } from "react";

export interface BillingState {
  plan: string;
  status: string;
  seats: number;
  currentPeriodEnd: number | null;
  limits: {
    maxAgents: number | null;
    concurrentRuns: number;
    runsPerMinute: number;
    maxMembers: number | null;
    canCreateOrg: boolean;
    label: string;
  };
}

let cached: BillingState | null = null;
let inflight: Promise<BillingState | null> | null = null;

async function fetchBilling(): Promise<BillingState | null> {
  try {
    const res = await fetch("/api/billing/subscription");
    // 404 = billing not configured (self-host / SaaS-without-Stripe).
    if (!res.ok) return null;
    return (await res.json()) as BillingState;
  } catch {
    return null;
  }
}

/**
 * Fetches /api/billing/subscription once per page load and caches the
 * result in module state (same pattern as useCanManageAgents). Returns the
 * current org's plan + limits, or null when billing isn't configured
 * (self-host, SaaS-without-Stripe, or the request failed).
 *
 * Used by the account menu to render the plan badge + "Manage
 * subscription" link, and by feature-gating client code that needs the
 * plan (e.g. the invite dialog's seat counter).
 */
export function useBilling(): { billing: BillingState | null; loading: boolean } {
  const [billing, setBilling] = useState<BillingState | null>(cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    if (!inflight) inflight = fetchBilling();
    inflight
      .then((b) => {
        if (cancelled) return;
        if (b) cached = b;
        setBilling(b);
        setLoading(false);
      })
      .finally(() => {
        inflight = null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { billing, loading };
}

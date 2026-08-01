"use client";

import { useEffect, useState } from "react";

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface OrgsState {
  orgs: OrgMembership[];
  activeOrgId: string;
  canCreateOrg: boolean;
  /** Seat cap for the active org. null = unlimited (self-host). */
  seats: number | null;
  memberCount: number;
}

let cached: OrgsState | null = null;
let inflight: Promise<OrgsState | null> | null = null;

async function fetchOrgs(): Promise<OrgsState | null> {
  try {
    const res = await fetch("/api/org");
    if (!res.ok) return null;
    return (await res.json()) as OrgsState;
  } catch {
    return null;
  }
}

/**
 * Fetches /api/org once per page load and caches the result in module
 * state (same pattern as useBilling / useCanManageAgents). Returns the
 * user's orgs + roles, the active org, whether org creation is allowed
 * (SaaS Team plan / self-host), and the active org's seat info — used by
 * the org switcher and the invite dialog.
 *
 * Call `refreshOrgs()` after an org switch / create / invite to reload
 * seat counts.
 */
export function useOrgs(): OrgsState & { refresh: () => void } {
  const [state, setState] = useState<OrgsState>(
    cached ?? { orgs: [], activeOrgId: "", canCreateOrg: false, seats: null, memberCount: 0 },
  );

  useEffect(() => {
    let cancelled = false;
    if (!inflight) inflight = fetchOrgs();
    inflight
      .then((o) => {
        if (cancelled || !o) return;
        cached = o;
        setState(o);
      })
      .finally(() => {
        inflight = null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function refresh() {
    inflight = fetchOrgs().then((o) => {
      if (o) {
        cached = o;
        setState(o);
      }
      return o;
    });
  }

  return { ...state, refresh };
}

/** Reset the cache — used after sign-out / org switch to force a refetch. */
export function resetOrgsCache() {
  cached = null;
  inflight = null;
}

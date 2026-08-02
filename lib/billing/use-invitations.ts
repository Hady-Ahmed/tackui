"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth/auth-client";

/**
 * Fetches the user's pending org invitations via better-auth's client and
 * caches the count in module state (same pattern as useBilling /
 * useCanManageAgents). Returns the pending count + an array of invitation
 * summaries so the account-menu badge can render.
 *
 * The actual accept/reject flow lives on /app/invitations. This hook is
 * just for the badge + "you have pending invitations" indicator.
 *
 * Returns count: 0 when unauthenticated or when better-auth returns an
 * error — the badge never renders in those cases.
 */
export interface InvitationSummary {
  id: string;
  organizationName: string;
  role: string;
}

let cachedCount = 0;
let cachedInvitations: InvitationSummary[] = [];
let inflight: Promise<void> | null = null;

async function fetchInvitations(): Promise<void> {
  try {
    const { data, error } = await authClient.organization.listUserInvitations({});
    if (error || !data) return;
    // better-auth returns organizationName as a top-level string field
    // (the `organization` object is Omit'd from the response). Same for
    // inviterId — just a UUID, no expanded user object.
    const list = (Array.isArray(data) ? data : []) as Array<{
      id: string;
      role: string;
      organizationName?: string;
    }>;
    cachedInvitations = list.map((inv) => ({
      id: inv.id,
      organizationName: inv.organizationName ?? "a workspace",
      role: inv.role,
    }));
    cachedCount = cachedInvitations.length;
  } catch {
    // Network or auth error — leave cached values at their defaults (0).
  }
}

export function useInvitations(): {
  count: number;
  invitations: InvitationSummary[];
  refresh: () => void;
} {
  const [count, setCount] = useState(cachedCount);
  const [invitations, setInvitations] = useState(cachedInvitations);

  useEffect(() => {
    let cancelled = false;
    if (!inflight) inflight = fetchInvitations();
    inflight.finally(() => {
      if (cancelled) return;
      setCount(cachedCount);
      setInvitations(cachedInvitations);
      inflight = null;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function refresh() {
    inflight = fetchInvitations().then(() => {
      setCount(cachedCount);
      setInvitations(cachedInvitations);
    });
  }

  return { count, invitations, refresh };
}

export function resetInvitationsCache() {
  cachedCount = 0;
  cachedInvitations = [];
  inflight = null;
}

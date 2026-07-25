"use client";

import { useEffect, useState } from "react";

let cachedCanManage: boolean | null = null;
let inflight: Promise<boolean | null> | null = null;

async function fetchCanManage(): Promise<boolean | null> {
  try {
    const res = await fetch("/api/auth/can-manage-agents");
    if (!res.ok) return null;
    const data = await res.json();
    return data.canManage === true;
  } catch {
    return null;
  }
}

/**
 * Fetches /api/auth/can-manage-agents once per page load and caches the
 * result in module state (same pattern as useAuthConfig). Returns whether
 * the current user can manage agents in their active org — true for
 * platform admins and org owners/admins, false for org members and
 * non-members. In solo mode, the synthetic admin is a platform admin so
 * this returns true.
 *
 * Used by the sidebar (show/hide "Manage agents" link), the chat shell
 * (empty-state CTA), and the /agents page (redirect if false).
 */
export function useCanManageAgents(): {
  canManage: boolean | null;
  loading: boolean;
} {
  const [canManage, setCanManage] = useState<boolean | null>(cachedCanManage);
  const [loading, setLoading] = useState(!cachedCanManage);

  useEffect(() => {
    if (cachedCanManage) return;
    let cancelled = false;
    if (!inflight) inflight = fetchCanManage();
    inflight
      .then((c) => {
        if (cancelled) return;
        if (c !== null) cachedCanManage = c;
        setCanManage(c);
        setLoading(false);
      })
      .finally(() => {
        inflight = null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { canManage, loading };
}

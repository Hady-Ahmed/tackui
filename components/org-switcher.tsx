"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
import { useOrgs } from "@/lib/billing/use-orgs";

/**
 * Org switcher dropdown — lets a user switch between workspaces.
 *
 * Self-renders only when the user belongs to >1 org (so users with a
 * single personal workspace never see it). This happens when they've
 * created additional workspaces (via the account menu's "New workspace"
 * button) or been invited to someone else's team.
 *
 * Creating workspaces lives OUTSIDE this component (in the account menu's
 * "New workspace" button + dialog) so it's reachable even when the user
 * has only one org and the switcher is hidden.
 *
 * Switching calls better-auth's setActiveOrganization then hard-navigates
 * to /app so server components + the runner re-scope to the new org.
 */
export function OrgSwitcher() {
  const { data: orgs, isPending: orgsLoading } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { orgs: orgsWithRoles } = useOrgs();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const list = orgs ?? orgsWithRoles ?? [];
  // Wait for both data sources before rendering. better-auth's
  // useListOrganizations and our useOrgs load at different speeds —
  // rendering during that gap causes a brief flash. After both resolve,
  // self-hide when there's only one org (single-personal-workspace users).
  const ready = !orgsLoading && orgsWithRoles.length > 0;
  if (!ready) return null;
  if (list.length <= 1) return null;

  async function switchTo(orgId: string) {
    setOpen(false);
    const { error } = await authClient.organization.setActive({
      organizationId: orgId,
    });
    if (error) {
      setError(error.message ?? "Failed to switch workspace");
      return;
    }
    router.refresh();
    window.location.assign("/app");
  }

  const activeName = activeOrg?.name ?? orgsWithRoles.find((o) => o.id === (activeOrg?.id ?? ""))?.name ?? "Workspace";
  const activeOrgInfo = orgsWithRoles.find((o) => o.id === (activeOrg?.id ?? ""));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-zinc-200 text-xs font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
          {(activeName || "?").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {activeName}
          </p>
          <p className="truncate text-xs text-zinc-400">
            {activeOrgInfo?.plan === "team"
              ? `Team · ${activeOrgInfo.memberCount}/${activeOrgInfo.seats ?? "?"} seats`
              : activeOrgInfo?.plan === "pro"
                ? "Pro"
                : "Free"}
          </p>
        </div>
        <svg className="h-4 w-4 shrink-0 text-zinc-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          <div className="max-h-60 overflow-y-auto">
            {list.map((org) => {
              const info = orgsWithRoles.find((o) => o.id === org.id);
              const plan = info?.plan ?? "free";
              return (
                <button
                  key={org.id}
                  onClick={() => switchTo(org.id)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <div className="min-w-0 flex-1">
                    <span className="truncate">{org.name}</span>
                    <span className="ml-2 text-xs text-zinc-400">
                      {plan === "team"
                        ? `Team · ${info?.memberCount ?? 0}/${info?.seats ?? "?"} seats`
                        : plan === "pro"
                          ? "Pro"
                          : "Free"}
                    </span>
                  </div>
                  {org.id === (activeOrg?.id ?? "") && (
                    <span className="ml-2 shrink-0 text-xs text-blue-600 dark:text-blue-400">active</span>
                  )}
                </button>
              );
            })}
          </div>

          {error && (
            <div className="border-t border-zinc-200 px-3 py-2 text-xs text-red-600 dark:border-zinc-800 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

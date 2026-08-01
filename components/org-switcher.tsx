"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
import { useOrgs } from "@/lib/billing/use-orgs";

/**
 * Org switcher dropdown — lets a user switch between their workspaces and
 * create a new one.
 *
 * Tier-agnostic by design: it self-renders only when the user belongs to
 * more than one org (so Free/Pro users on a single personal org never see
 * it). The "Create workspace" affordance inside it is gated by the team
 * plan via useOrgs().canCreateOrg (which reads checkCanCreateOrg — SaaS
 * Team only, self-host multi-user always).
 *
 * Solo mode (AUTH_DISABLED) never reaches this component — the account
 * menu renders the synthetic admin branch before mounting the switcher.
 *
 * Switching calls better-auth's setActiveOrganization then hard-refreshes
 * so the new org's agents/threads/scoping takes effect across the app.
 */
export function OrgSwitcher() {
  const { data: orgs, isPending: orgsLoading } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { orgs: orgsWithRoles, canCreateOrg, seats, memberCount } = useOrgs();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
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
  // Self-hide when there's only one org (or zero — loading).
  if (!orgsLoading && list.length <= 1 && !canCreateOrg) return null;

  async function switchTo(orgId: string) {
    setOpen(false);
    const { error } = await authClient.organization.setActive({
      organizationId: orgId,
    });
    if (error) {
      setError(error.message ?? "Failed to switch workspace");
      return;
    }
    // Hard refresh so server components + the runner re-scope to the new org.
    router.refresh();
    window.location.assign("/app");
  }

  async function createOrg() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    const { error } = await authClient.organization.create({
      name: newName.trim(),
      slug: newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    });
    setCreating(false);
    if (error) {
      setError(
        error.code === "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION"
          ? "Upgrade to the Team plan to create workspaces."
          : error.message ?? "Failed to create workspace",
      );
      return;
    }
    setNewName("");
    setOpen(false);
    router.refresh();
    window.location.assign("/app");
  }

  const activeName = activeOrg?.name ?? orgsWithRoles.find((o) => o.id === (activeOrg?.id ?? ""))?.name ?? "Workspace";

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
            {canCreateOrg && seats ? `Team · ${memberCount}/${seats} seats` : "Workspace"}
          </p>
        </div>
        <svg className="h-4 w-4 shrink-0 text-zinc-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          <div className="max-h-60 overflow-y-auto">
            {list.map((org) => (
              <button
                key={org.id}
                onClick={() => switchTo(org.id)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <span className="truncate">{org.name}</span>
                {org.id === (activeOrg?.id ?? "") && (
                  <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">active</span>
                )}
              </button>
            ))}
          </div>

          {canCreateOrg && (
            <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
              {newName === "" ? (
                <button
                  onClick={() => setNewName(" ")}
                  className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  + New workspace
                </button>
              ) : (
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={newName.trim()}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createOrg();
                      if (e.key === "Escape") setNewName("");
                    }}
                    placeholder="Workspace name"
                    className="min-w-0 flex-1 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <button
                    onClick={createOrg}
                    disabled={creating || !newName.trim()}
                    className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {creating ? "…" : "Create"}
                  </button>
                </div>
              )}
            </div>
          )}

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

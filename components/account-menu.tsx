"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useBilling } from "@/lib/billing/use-billing";
import { useInvitations } from "@/lib/billing/use-invitations";
import { OrgSwitcher } from "@/components/org-switcher";
import { InviteDialog } from "@/components/invite-dialog";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { NewWorkspaceDialog } from "@/components/new-workspace-dialog";

export function AccountMenu({ collapsed = false }: { collapsed?: boolean } = {}) {
  const { data: session, isPending } = authClient.useSession();
  const { config } = useAuthConfig();
  const { billing } = useBilling();
  const { canManage } = useCanManageAgents();
  const { count: pendingInvites } = useInvitations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [popupPos, setPopupPos] = useState<{ left: number; bottom: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Only redirect to /login when auth is actually enabled. In solo mode
  // (AUTH_DISABLED=true) there's no real session — render the synthetic
  // admin identity from /api/auth/config instead of bouncing to /login.
  useEffect(() => {
    if (!isPending && !session && !config?.authDisabled) {
      router.push("/login");
    }
  }, [session, isPending, router, config?.authDisabled]);

  if (isPending || (!session && !config?.authDisabled)) {
    return <div className="h-8" />;
  }

  // Solo mode: render the synthetic admin identity. No sign-out button
  // since there's no real session to sign out of.
  if (!session && config?.authDisabled) {
    const synth = config.user;
    const initials = (synth?.name || "?").charAt(0).toUpperCase();
    if (collapsed) {
      return (
        <div className="flex h-9 w-9 items-center justify-center" title={synth?.name ?? "Local user"}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-medium text-white">
            {initials}
          </div>
        </div>
      );
    }
    return (
      <div className="rounded-lg px-2 py-1.5">
        <div className="flex w-full items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-medium text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {synth?.name ?? "Local user"}
            </p>
            <span className="text-xs font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400">
              Admin
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <button
        onClick={() => router.push("/login")}
        className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        Sign in
      </button>
    );
  }

  const initials = (session.user.name || session.user.email || "?")
    .charAt(0)
    .toUpperCase();

  const handleToggle = () => {
    if (!open && collapsed && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPopupPos({ left: rect.right + 8, bottom: window.innerHeight - rect.top + 4 });
    }
    setOpen((v) => !v);
  };

  const popupClassName = collapsed
    ? "fixed z-50 w-64 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
    : "absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950";
  const popupStyle = collapsed && popupPos ? { left: popupPos.left, bottom: popupPos.bottom } : undefined;

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        onClick={handleToggle}
        className={`${collapsed ? "flex h-9 w-9 items-center justify-center" : "flex w-full items-center gap-2 px-2 py-1.5"} rounded-lg text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800`}
        title={collapsed ? session.user.name : undefined}
        aria-label={collapsed ? session.user.name : undefined}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-medium text-white">
          {initials}
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {session.user.name}
            </p>
            <p className="truncate text-xs text-zinc-400">
              {session.user.email}
            </p>
          </div>
        )}
      </button>

      {createPortal(
        <>
          <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
          <UpgradeDialog open={upgradeOpen} onClose={() => setUpgradeOpen(false)} />
          <NewWorkspaceDialog open={newWorkspaceOpen} onClose={() => setNewWorkspaceOpen(false)} />
        </>,
        document.body,
      )}

      {open && (
        <div className={popupClassName} style={popupStyle}>
          <div className="px-1 py-1">
            <OrgSwitcher />
          </div>
          {pendingInvites > 0 && (
            <button
              onClick={() => {
                router.push("/app/invitations");
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <span>Pending invitations</span>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-medium text-white">
                {pendingInvites}
              </span>
            </button>
          )}
          {canManage && (billing === null || billing.limits?.maxMembers === null) && (
            <button
              onClick={() => {
                setInviteOpen(true);
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Invite member
            </button>
          )}
          {/* Manage members — roster + remove + role change + cancel
              invites. Gated identically to "Invite member" (self-host
              or team plan, where multi-member workspaces exist). Free/pro
              personal orgs have maxMembers === 1, so there's no one to
              manage but yourself — hidden there, same as the invite
              button. */}
          {canManage && (billing === null || billing.limits?.maxMembers === null) && (
            <button
              onClick={() => {
                router.push("/app/members");
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Manage members
            </button>
          )}
          {/* New workspace — always available on SaaS. Lives here (not in
              the org switcher) so it's reachable even when the user has
              only one org and the switcher is hidden. Free workspaces
              start with 3 agents, 1 member, no invites. */}
          {billing && (
            <button
              onClick={() => {
                setNewWorkspaceOpen(true);
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              New workspace
            </button>
          )}
          {session.user.role === "admin" && (
            <span className="block px-3 py-1 text-xs font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400">
              Admin
            </span>
          )}
          {billing && (
            <>
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Plan
                </span>
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  {billing.limits?.label ?? billing.plan}
                </span>
              </div>
              {/* Upgrade CTA — shown for free + pro (team users manage via
                  the portal instead). One-way upgrades only; the portal
                  toggle "change plans" stays off to block unsafe
                  downgrades (Team→Pro leaves orphaned members). */}
              {(billing.plan === "free" || billing.plan === "pro") && canManage && (
                <button
                  onClick={() => {
                    setUpgradeOpen(true);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
                >
                  Upgrade plan
                </button>
              )}
              {billing.plan !== "free" && canManage && (
                <button
                  onClick={async () => {
                    const res = await fetch("/api/billing/portal", {
                      method: "POST",
                    });
                    if (res.ok) {
                      const { url } = await res.json();
                      if (url) window.location.assign(url);
                    }
                  }}
                  className="block w-full px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Manage subscription
                </button>
              )}
            </>
          )}
          <button
            onClick={async () => {
              await authClient.signOut();
              router.push("/login");
              router.refresh();
            }}
            className="block w-full px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

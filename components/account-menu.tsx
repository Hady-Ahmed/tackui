"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useBilling } from "@/lib/billing/use-billing";
import { OrgSwitcher } from "@/components/org-switcher";
import { InviteDialog } from "@/components/invite-dialog";

export function AccountMenu() {
  const { data: session, isPending } = authClient.useSession();
  const { config } = useAuthConfig();
  const { billing } = useBilling();
  const { canManage } = useCanManageAgents();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-medium text-white">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {session.user.name}
          </p>
          <p className="truncate text-xs text-zinc-400">
            {session.user.email}
          </p>
        </div>
      </button>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          <div className="px-1 py-1">
            <OrgSwitcher />
          </div>
          {canManage && (
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
              <button
                onClick={async () => {
                  const res = await fetch("/api/billing/portal", {
                    method: "POST",
                  });
                  if (res.ok) {
                    const { url } = await res.json();
                    if (url) window.location.href = url;
                  }
                }}
                className="block w-full px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Manage subscription
              </button>
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

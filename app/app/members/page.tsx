"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useOrgs } from "@/lib/billing/use-orgs";
import { useBilling } from "@/lib/billing/use-billing";
import { resetInvitationsCache } from "@/lib/billing/use-invitations";
import { authClient } from "@/lib/auth/auth-client";
import { BackToChat } from "@/components/back-to-chat";
import {
  listMembers,
  removeMember,
  updateMemberRole,
  listInvitations,
  cancelInvitation,
  type OrgMember,
  type SentInvitation,
  type OrgMemberError,
} from "@/lib/org-members";

/**
 * Workspace member management — roster + remove + role change + cancel
 * pending invites. Reached from the account menu's "Manage members"
 * link (org owners/admins only).
 *
 * Uses better-auth's organization client via lib/org-members.ts. The
 * server-side permission checks (owner/admin can remove; sole owner
 * can't leave; non-admins blocked) are enforced by better-auth — this
 * page only hides the controls for non-admins, the backstop is
 * server-side.
 *
 * Solo mode (AUTH_DISABLED=true) redirects to /app — there's no
 * multi-user meaning when everyone is the single synthetic admin.
 */
const ONLY_OWNER_CODE = "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER";

export default function MembersPage() {
  const { config, loading: configLoading } = useAuthConfig();
  const { canManage } = useCanManageAgents();
  const { orgs, activeOrgId, refresh: refreshOrgs } = useOrgs();
  const { billing } = useBilling();
  const { data: session } = authClient.useSession();
  const router = useRouter();

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<SentInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioning, setActioning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  const myId = session?.user?.id;
  // Whether the current user is an owner of the active org, and how many
  // owners the org has — used to gate actions the server would reject:
  // only owners can remove/leave-as-owner, and the sole owner can't
  // leave (no one to take over). Computed from the roster so it stays
  // correct after every mutation.
  const myMember = members.find((m) => m.userId === myId);
  const amOwner = myMember?.role
    .split(",")
    .map((r) => r.trim())
    .includes("owner");
  const ownerCount = members.filter((m) =>
    m.role.split(",").map((r) => r.trim()).includes("owner"),
  ).length;
  // Effective member cap for the active org — null = unlimited
  // (self-host, or team per-seat uses billing.seats). Used by the
  // over-limit banner: surfaces the post-cancellation state where a
  // downgraded Team org has more members than the Free 1-member cap.
  const memberCap =
    billing === null
      ? null
      : (billing.limits.maxMembers ?? billing.seats);
  const overMemberCap =
    canManage && memberCap !== null && members.length > memberCap;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [m, inv] = await Promise.all([listMembers(), listInvitations()]);
    if (m.error || inv.error) {
      setError(m.error?.message ?? inv.error?.message ?? "Failed to load");
    } else {
      setMembers(m.data ?? []);
      setInvitations(inv.data ?? []);
    }
    setLoading(false);
  }, []);

  // Redirect in solo mode (no multi-user meaning). Mirrors the account
  // menu's gating — the link to this page is hidden in solo mode, but a
  // direct navigation should bounce.
  useEffect(() => {
    if (!configLoading && config?.authDisabled) {
      router.replace("/app");
    }
  }, [configLoading, config?.authDisabled, router]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (config?.authDisabled) return;
    loadRef.current();
  }, [config?.authDisabled]);

  function messageFor(err: OrgMemberError, fallback: string): string {
    if (err.code === ONLY_OWNER_CODE) {
      return "You're the only owner — transfer ownership or delete the workspace first.";
    }
    if (
      err.code === "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER" ||
      err.code === "UNAUTHORIZED"
    ) {
      return "You don't have permission to do that.";
    }
    return err.message ?? fallback;
  }

  async function onRemove(member: OrgMember) {
    if (confirming !== member.id) {
      setConfirming(member.id);
      return;
    }
    setActioning(member.id);
    setConfirming(null);
    const res = await removeMember(member.id);
    setActioning(null);
    if (res.error) {
      setError(messageFor(res.error, "Failed to remove member"));
      return;
    }
    setNotice("Member removed.");
    refreshOrgs();
    await load();
  }

  async function onLeave(member: OrgMember) {
    setActioning(member.id);
    const res = await removeMember(member.id);
    setActioning(null);
    if (res.error) {
      setError(messageFor(res.error, "Failed to leave workspace"));
      return;
    }
    // Leaving clears the active org server-side; reload orgs + bounce
    // to /app so the active-org context rehydrates.
    refreshOrgs();
    router.push("/app");
    router.refresh();
  }

  async function onRoleChange(member: OrgMember, role: "member" | "admin" | "owner") {
    setActioning(member.id);
    const res = await updateMemberRole(member.id, role);
    setActioning(null);
    if (res.error) {
      setError(messageFor(res.error, "Failed to update role"));
      return;
    }
    setNotice("Role updated.");
    await load();
  }

  async function onCancel(inv: SentInvitation) {
    setActioning(inv.id);
    const res = await cancelInvitation(inv.id);
    setActioning(null);
    if (res.error) {
      setError(messageFor(res.error, "Failed to cancel invitation"));
      return;
    }
    setNotice("Invitation cancelled.");
    resetInvitationsCache();
    refreshOrgs();
    await load();
  }

  if (configLoading) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black">
        <div className="mx-auto max-w-2xl px-4 py-6 md:px-6 md:py-10 text-sm text-zinc-500">
          Loading…
        </div>
      </div>
    );
  }
  if (config?.authDisabled) {
    return null;
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-2xl px-4 py-6 md:px-6 md:py-10 text-zinc-900 dark:text-zinc-100">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Members
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {activeOrg
                ? `${activeOrg.name}${activeOrg.seats !== null ? ` · ${activeOrg.memberCount}/${activeOrg.seats} seats` : ""}`
                : "Workspace members."}
            </p>
          </div>
          <BackToChat />
        </header>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
          {notice}
        </div>
      )}

      {loading ? (
        <p className="mt-8 text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Over-limit banner — surfaces the post-cancellation state
              where a downgraded Team org has more members than the
              Free 1-member cap. Informational only; nothing breaks,
              the server blocks new invites until the owner removes
              members or upgrades. */}
          {overMemberCap && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              Your workspace is over the {billing!.limits.label} plan&apos;s{" "}
              {memberCap}-member limit. Remove {members.length - memberCap}{" "}
              member{members.length - memberCap === 1 ? "" : "s"} or upgrade in
              the account menu.
            </div>
          )}

          {/* Members roster */}
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Members
          </h2>
          {members.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No members found.</p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
              {members.map((m) => {
                const isMe = m.userId === myId;
                const isOwner = m.role
                  .split(",")
                  .map((r) => r.trim())
                  .includes("owner");
                return (
                  <li
                    key={m.id}
                    className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {m.name || m.email || "Unknown"}
                        {isMe && (
                          <span className="ml-2 text-xs text-zinc-400">(you)</span>
                        )}
                      </p>
                      <p className="truncate text-sm text-zinc-500">
                        {m.email}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium capitalize text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {m.role}
                      </span>

                      {/* Role change — hidden on self; on owner rows
                          only shown to other owners (server blocks
                          admins from touching owners). Includes the
                          "Owner" option only when the viewer is an
                          owner, enabling ownership transfer: promote
                          someone to owner, then Leave (appears once
                          ownerCount > 1). */}
                      {canManage && !isMe && (!isOwner || amOwner) && (
                        <select
                          value={
                            m.role.split(",").includes("owner")
                              ? "owner"
                              : m.role.split(",").includes("admin")
                                ? "admin"
                                : "member"
                          }
                          onChange={(e) =>
                            onRoleChange(
                              m,
                              e.target.value as "member" | "admin" | "owner",
                            )
                          }
                          disabled={actioning === m.id}
                          className="rounded-lg border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                          {amOwner && <option value="owner">Owner</option>}
                        </select>
                      )}

                      {/* Leave (self) — hidden for the sole owner (the
                          server blocks it with the only-owner error; no
                          point offering a dead button). */}
                      {isMe && !(isOwner && ownerCount <= 1) && (
                        <button
                          onClick={() => onLeave(m)}
                          disabled={actioning === m.id}
                          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          {actioning === m.id ? "Leaving…" : "Leave"}
                        </button>
                      )}

                      {/* Remove (admin/owner only, not self, not an owner
                          unless the viewer is also an owner — the server
                          blocks admins from removing owners). */}
                      {canManage && !isMe && (!isOwner || amOwner) && (
                        <button
                          onClick={() => onRemove(m)}
                          disabled={actioning === m.id}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                            confirming === m.id
                              ? "border-red-500 bg-red-600 text-white"
                              : "border-red-300 text-red-600 dark:border-red-800 dark:text-red-400"
                          }`}
                        >
                          {confirming === m.id
                            ? "Confirm remove"
                            : actioning === m.id
                              ? "Removing…"
                              : "Remove"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Pending invitations */}
          {invitations.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Pending invitations
              </h2>
              <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
                {invitations.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{inv.email}</p>
                      <p className="text-sm text-zinc-500">
                        Invited as {inv.role}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        pending
                      </span>
                      {canManage && (
                        <button
                          onClick={() => onCancel(inv)}
                          disabled={actioning === inv.id}
                          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          {actioning === inv.id
                            ? "Cancelling…"
                            : "Cancel invite"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      </div>
    </div>
  );
}

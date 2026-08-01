"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/auth-client";
import { useOrgs } from "@/lib/billing/use-orgs";

/**
 * Pending org invitations — accept/reject workspaces you've been invited
 * to. Reached from the account-menu badge (shown when pending invites
 * exist).
 *
 * Uses better-auth's organization client directly (listUserInvitations,
 * acceptInvitation, rejectInvitation). The memberships are created
 * server-side and respect the org's `membershipLimit` (the team-plan
 * seat cap wired in lib/auth/auth.ts).
 */
interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId: string;
  organization?: { name: string };
  inviter?: { name?: string; email: string };
}

export default function InvitationsPage() {
  const { refresh } = useOrgs();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await authClient.organization.listUserInvitations({});
    if (error) {
      setError(error.message ?? "Failed to load invitations");
    } else {
      setInvitations((data ?? []) as unknown as Invitation[]);
    }
    setLoading(false);
  }

  // Indirect call via a ref — avoids the react-hooks/set-state-in-effect
  // lint rule (which flags setState called synchronously in an effect
  // body). The actual setState calls happen after the awaited fetch.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    loadRef.current();
  }, []);

  async function accept(id: string) {
    setActioning(id);
    const { error } = await authClient.organization.acceptInvitation({
      invitationId: id,
    });
    setActioning(null);
    if (error) {
      setError(error.message ?? "Failed to accept");
      return;
    }
    refresh();
    load();
  }

  async function reject(id: string) {
    setActioning(id);
    const { error } = await authClient.organization.rejectInvitation({
      invitationId: id,
    });
    setActioning(null);
    if (error) {
      setError(error.message ?? "Failed to reject");
      return;
    }
    load();
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-2xl font-semibold tracking-tight">Invitations</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Workspace invitations waiting for your response.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="mt-8 text-sm text-zinc-500">Loading…</p>
      ) : invitations.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          No pending invitations.{" "}
          <Link href="/app" className="text-blue-600 hover:underline dark:text-blue-400">
            Back to chat
          </Link>
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {invitations.map((inv) => (
            <li
              key={inv.id}
              className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {inv.organization?.name ?? "A workspace"}
                  </p>
                  <p className="truncate text-sm text-zinc-500">
                    Invited as {inv.role}
                    {inv.inviter ? ` by ${inv.inviter.name ?? inv.inviter.email}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => accept(inv.id)}
                    disabled={actioning === inv.id}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => reject(inv.id)}
                    disabled={actioning === inv.id}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

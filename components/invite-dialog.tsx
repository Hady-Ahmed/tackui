"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/auth-client";
import { useOrgs } from "@/lib/billing/use-orgs";

/**
 * Invite-by-email dialog for org owners/admins. Opens from the account
 * menu.
 *
 * The seat cap is enforced server-side by better-auth's `membershipLimit`
 * (wired in lib/auth/auth.ts to read the subscription's seats). This
 * dialog additionally shows a live seats-remaining counter from /api/org
 * so the UI can disable the invite + show an upgrade CTA before the
 * request is made. Both gates agree: inviting past the cap returns
 * ORGANIZATION_MEMBERSHIP_LIMIT_REACHED from better-auth.
 *
 * Self-host multi-user: seats is null (unlimited), no cap shown.
 */
export function InviteDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { seats, memberCount, refresh } = useOrgs();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!open) return null;

  const seatsRemaining =
    seats === null ? Infinity : Math.max(0, seats - memberCount);
  const atCap = seats !== null && seatsRemaining <= 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || atCap) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    const { error: err } = await authClient.organization.inviteMember({
      email: email.trim(),
      role,
    });
    setSubmitting(false);
    if (err) {
      setError(
        err.code === "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED"
          ? "Seat limit reached. Add seats in the customer portal to invite more members."
          : err.message ?? "Failed to send invitation",
      );
      return;
    }
    setSuccess(true);
    setEmail("");
    refresh();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Invite member
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          {seats === null
            ? "Anyone invited will join this workspace."
            : `Team seats: ${memberCount}/${seats} used`}
        </p>

        {atCap ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            You&apos;ve used all {seats} seat{seats === 1 ? "" : "s"}. Add more
            in the customer portal to invite additional members.
          </div>
        ) : success ? (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
            Invitation sent to {email || "the invitee"}.
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-3">
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "admin")}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            {error && (
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting || !email.trim()}
                className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send invite"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

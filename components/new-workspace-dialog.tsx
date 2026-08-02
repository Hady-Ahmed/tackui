"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/auth-client";

/**
 * "New workspace" dialog — creates a new org (team workspace).
 *
 * Creating workspaces is always available and free (Vercel/GitHub model).
 * A Free workspace has 3 agents max, 1 member, no invites — harmless.
 * Upgrade it to Team from the account menu's "Upgrade plan" button after
 * switching to it.
 *
 * On success, better-auth makes the new org active and the dialog
 * hard-navigates to /app so server components + the runner re-scope.
 *
 * Reached from the account menu's "New workspace" button, which is shown
 * on SaaS mode (when billing is configured) so a user with only one
 * personal workspace can reach creation without the org switcher (which
 * self-hides at 1 org).
 */
export function NewWorkspaceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    const { error: err } = await authClient.organization.create({
      name: name.trim(),
      slug: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    });
    setSubmitting(false);
    if (err) {
      setError(err.message ?? "Failed to create workspace");
      return;
    }
    setName("");
    onClose();
    // Hard navigate so the new active org takes effect across the app.
    window.location.assign("/app");
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
          New workspace
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Workspaces start on the Free plan. Switch to a workspace and upgrade it to Team for collaboration.
        </p>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <input
            type="text"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create workspace"}
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
      </div>
    </div>
  );
}

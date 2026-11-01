"use client";

/**
 * Org connector admin — the org-scoped MCP connectors builder agents
 * reference by name. Org-admin gated (the same gate as the agent form on
 * /agents); the builder's connector palette is member-readable but only
 * admins can add/remove them.
 *
 * Token semantics surface here (PUT /api/connectors): omit the field →
 * preserve the stored token, "" → clear it, a string → replace it. The
 * form mirrors that: blank field = omit, "Clear token" checkbox = "".
 *
 * Wire contracts (see lib/connectors/connector-store.ts): the upsert key
 * is the connector NAME — renames create a new connector and orphan the
 * agents that reference the old name, so the name is immutable in edit
 * mode; the delete confirms the builder-agent breakage ("an org admin
 * needs to add it before the agent can run" is the run-gate copy agents
 * hit after a connector they use is removed).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { PublicConnector } from "@/lib/connectors/connector-store";
import { extractErrorMessage } from "@/components/builder/builder-config";

interface FormState {
  name: string;
  url: string;
  token: string;
  clearToken: boolean;
  editing: PublicConnector | null;
}

export function ConnectorsAdmin() {
  const [connectors, setConnectors] = useState<PublicConnector[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/connectors");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(extractErrorMessage(data, `Failed to load connectors (${res.status})`));
      setLoading(false);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Wrapper indirection satisfies react-hooks/set-state-in-effect (load
    // sets state after its fetch resolves — same pattern as users-admin).
    const loadOnce = async () => {
      await load();
    };
    loadOnce();
  }, [load]);

  const openEdit = (connector: PublicConnector) => {
    setForm({
      name: connector.name,
      url: connector.url,
      token: "",
      clearToken: false,
      editing: connector,
    });
    setFieldErrors({});
    setError(null);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    // Client-side validation mirrors the store's zod schemas.
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = "Name is required";
    if (!/^[\w-]+$/.test(form.name.trim())) errors.name = "Name must be a-z, 0-9, - or _";
    if (!form.url.trim()) errors.url = "URL is required";
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const res = await fetch("/api/connectors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectorUpsertPayload(form)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(extractErrorMessage(data, `Failed to save the connector (${res.status})`));
        return;
      }
      setForm(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (connector: PublicConnector) => {
    if (!confirm(`Delete connector "${connector.name}"? Builder agents that reference it will stop running until it is re-added.`)) return;
    const res = await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(extractErrorMessage(data, `Failed to delete the connector (${res.status})`));
      return;
    }
    await load();
  };

  return (
    <section id="connectors" className="scroll-mt-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Connectors</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Org MCP servers that builder agents reference by name. Deleting or renaming
            one breaks agents that reference it — an org admin needs to add it back
            before the agent can run.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setForm({ name: "", url: "", token: "", clearToken: false, editing: null });
            setFieldErrors({});
          }}
          className="shrink-0 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Add connector
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {form && (
        <form
          onSubmit={save}
          className="mb-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              error={fieldErrors.name}
              hint={
                form.editing
                  ? "Names are referenced by builder agents — renaming creates a new connector and orphans agents that reference the old name."
                  : "Lowercase letters, digits, hyphens or underscores — builder agents reference connectors by name."
              }
            >
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className={inputClass(Boolean(form.editing))}
                placeholder="github"
                disabled={Boolean(form.editing)}
              />
            </Field>
            <Field label="URL" error={fieldErrors.url}>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                className={inputClass()}
                placeholder="https://mcp.example.com"
              />
            </Field>
          </div>
          <Field
            label="Token"
            hint="Bearer token sent to the connector. Leave blank to keep the stored token."
          >
            <input
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              className={inputClass()}
              placeholder="Bearer token (optional)"
            />
          </Field>
          {form.editing?.hasToken && (
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={form.clearToken}
                onChange={(e) => setForm({ ...form, clearToken: e.target.checked })}
                className="h-4 w-4 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
              />
              Clear the stored token
            </label>
          )}
          {form.clearToken && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              The stored token will be cleared on save.
            </p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save connector"}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {(connectors ?? []).map((c) => (
            <li
              key={c.name}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-50">{c.name}</p>
                <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{c.url}</p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    c.hasToken
                      ? "rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-950 dark:text-green-300"
                      : "rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  }
                >
                  {c.hasToken ? "token ✓" : "no token"}
                </span>
                <button
                  type="button"
                  onClick={() => openEdit(c)}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(c)}
                  className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
          {(connectors ?? []).length === 0 && (
            <li className="rounded-xl border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              No connectors yet.{" "}
              <Link
                href="/agents?add=1"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                Build an agent
              </Link>{" "}
              to reference them by name.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * The PUT /api/connectors body. Token semantics: a blank token field omits
 * the field entirely (preserve), the "Clear token" checkbox sends "" to
 * clear it, and a typed value replaces it.
 */
export function connectorUpsertPayload(form: {
  name: string;
  url: string;
  token: string;
  clearToken: boolean;
}): { name: string; url: string; token?: string } {
  if (form.clearToken) return { name: form.name.trim(), url: form.url.trim(), token: "" };
  if (form.token.trim()) return { name: form.name.trim(), url: form.url.trim(), token: form.token.trim() };
  return { name: form.name.trim(), url: form.url.trim() };
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </span>
      {children}
      {error && (
        <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">{error}</span>
      )}
      {hint && !error && (
        <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>
      )}
    </label>
  );
}

function inputClass(disabled = false): string {
  return [
    "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition-colors",
    "focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50",
    disabled ? "opacity-60" : "",
  ].join(" ");
}

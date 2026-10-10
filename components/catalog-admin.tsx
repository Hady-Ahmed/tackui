"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicAgentTemplate, RequiredPlan, TemplateAuthMode } from "@/lib/catalog/catalog.config";
import {
  TEST_HELP,
  TestBadge,
  useTestResults,
  type TestStatus,
} from "@/components/test-connection";

/**
 * Catalog admin — platform-admin-only section on the /admin page for
 * curating the global agent catalog (agent templates). Distinct from
 * org-scoped agent management: templates are cross-org, so the gate is
 * `session.user.role === "admin"` (platform admin), not canManageAgents.
 *
 * The form mirrors the agent form's conventions: jwtSecret is
 * write-only (blank submit preserves the stored value), clearable
 * optional fields send explicit nulls, and "Test connection" reuses the
 * reachability probe.
 */

type FormState = {
  name: string;
  slug: string;
  slugTouched: boolean;
  tagline: string;
  description: string;
  category: string;
  icon: string;
  endpoint: string;
  authMode: TemplateAuthMode;
  jwtSecret: string;
  jwtScopes: string;
  requiredPlan: "" | RequiredPlan;
  freeDailyQuota: string;
  sortOrder: string;
  isActive: boolean;
};

const emptyForm: FormState = {
  name: "",
  slug: "",
  slugTouched: false,
  tagline: "",
  description: "",
  category: "",
  icon: "",
  endpoint: "",
  authMode: "none",
  jwtSecret: "",
  jwtScopes: "",
  requiredPlan: "",
  freeDailyQuota: "",
  sortOrder: "0",
  isActive: true,
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Build a user-facing error message from a route error response. Zod
 * rejections come back as `{ error: "Validation failed", details: {
 * fieldErrors: { field: [msgs] } } }` — surface the per-field messages
 * ("slug: Use lowercase letters…") instead of the bare header.
 */
function extractErrorMessage(
  data: unknown,
  fallback: string,
): string {
  if (typeof data !== "object" || data === null) return fallback;
  const d = data as {
    error?: unknown;
    details?: { fieldErrors?: Record<string, unknown> };
  };
  const fieldErrors = d.details?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === "object") {
    const parts = Object.entries(fieldErrors)
      .filter(([, msgs]) => Array.isArray(msgs) && (msgs as string[]).length > 0)
      .map(([field, msgs]) => `${field}: ${(msgs as string[]).join(", ")}`);
    if (parts.length > 0) return parts.join(" · ");
  }
  return typeof d.error === "string" && d.error ? d.error : fallback;
}

export function CatalogAdmin() {
  const [templates, setTemplates] = useState<PublicAgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingHasJwtSecret, setEditingHasJwtSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { formTest, rowTests, runFormTest, runRowTest, resetFormTest } =
    useTestResults();
  const [formOpen, setFormOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/catalog?all=1");
    if (res.ok) setTemplates(await res.json());
    setLoading(false);
  }, []);

  const fetchRef = useRef(fetchTemplates);
  useEffect(() => {
    fetchRef.current = fetchTemplates;
  }, [fetchTemplates]);

  useEffect(() => {
    fetchRef.current();
  }, []);

  // Bring the form into view when it opens or when the edit target
  // changes while it's already open.
  useEffect(() => {
    if (formOpen) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [formOpen, editingId]);

  const updateForm = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    resetFormTest();
  };

  const startEdit = (template: PublicAgentTemplate) => {
    setEditingId(template.id);
    setEditingHasJwtSecret(template.hasJwtSecret);
    setForm({
      name: template.name,
      slug: template.slug,
      slugTouched: true,
      tagline: template.tagline,
      description: template.description,
      category: template.category ?? "",
      icon: template.icon ?? "",
      endpoint: template.endpoint,
      authMode: template.authMode,
      // Never pre-fill secrets — blank submit preserves (see agents form).
      jwtSecret: "",
      jwtScopes: template.jwtScopes?.join(", ") ?? "",
      requiredPlan: template.requiredPlan ?? "",
      freeDailyQuota: template.freeDailyQuota != null ? String(template.freeDailyQuota) : "",
      sortOrder: String(template.sortOrder),
      isActive: template.isActive,
    });
    setError(null);
    resetFormTest();
    setFormOpen(true);
  };

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setEditingHasJwtSecret(false);
    setError(null);
    resetFormTest();
    setFormOpen(false);
  };

  // Header-button toggle: opening from closed starts a clean form;
  // closing (Cancel path) resets any in-progress edit.
  const toggleForm = () => {
    if (formOpen) {
      resetForm();
    } else {
      setError(null);
      setFormOpen(true);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    // Clearable optional fields send explicit null when empty (blank
    // means "remove"), except jwtSecret which blank-preserves.
    const payload: Record<string, unknown> = {
      name: form.name,
      slug: form.slug,
      tagline: form.tagline,
      description: form.description,
      category: form.category || null,
      icon: form.icon || null,
      endpoint: form.endpoint,
      authMode: form.authMode,
      ...(form.jwtSecret ? { jwtSecret: form.jwtSecret } : {}),
      jwtScopes: form.jwtScopes.split(",").map((s) => s.trim()).filter(Boolean),
      requiredPlan: form.requiredPlan || null,
      freeDailyQuota:
        !form.requiredPlan && form.freeDailyQuota
          ? Number(form.freeDailyQuota)
          : null,
      sortOrder: Number(form.sortOrder) || 0,
      isActive: form.isActive,
    };

    try {
      const url = editingId ? `/api/catalog/${editingId}` : "/api/catalog";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(extractErrorMessage(data, `Request failed (${res.status})`));
        return;
      }
      await fetchTemplates();
      resetForm();
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (template: PublicAgentTemplate) => {
    const res = await fetch(`/api/catalog/${template.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !template.isActive }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(extractErrorMessage(data, "Failed to update publish state"));
      return;
    }
    await fetchTemplates();
  };

  const handleDelete = async (template: PublicAgentTemplate) => {
    // Fetch the blast radius first — installed copies are NOT deleted by
    // the server; the confirm should say so.
    let installs = 0;
    try {
      const detail = await fetch(`/api/catalog/${template.id}`);
      if (detail.ok) installs = (await detail.json()).installCount ?? 0;
    } catch {
      // Proceed with the generic confirm if the count fetch fails.
    }
    const suffix =
      installs > 0
        ? ` ${installs} workspace${installs === 1 ? " has" : "s have"} installed it — their installed copies will be removed from those workspaces (past chats stay viewable).`
        : "";
    if (!confirm(`Delete catalog template "${template.name}"?${suffix}`)) return;
    const res = await fetch(`/api/catalog/${template.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(extractErrorMessage(data, "Delete failed"));
      return;
    }
    if (editingId === template.id) resetForm();
    await fetchTemplates();
  };

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Catalog templates (platform admin)
      </h2>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        Curated agents every workspace can one-click install from{" "}
        <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-900">/app/catalog</code>.
        Installed agents run live off this template — edits here (endpoint, auth, name)
        propagate to every installed workspace automatically, no user action needed.
        Deleting a template tombstones installed copies (past chats stay viewable);
        unpublishing hides the card and pauses runs (reversible).
      </p>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Published templates ({templates.length})
        </h3>
        <button
          type="button"
          onClick={toggleForm}
          className="shrink-0 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {formOpen ? "Close" : "+ New template"}
        </button>
      </div>

      {formOpen && (
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="mb-6 scroll-mt-4 space-y-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <input
              value={form.name}
              onChange={(e) =>
                updateForm({
                  name: e.target.value,
                  ...(form.slugTouched ? {} : { slug: slugify(e.target.value) }),
                })
              }
              required
              className={inputClass()}
              placeholder="Flight Finder"
            />
          </Field>
          <Field label="Slug" required hint="URL-safe id for shareable links (/catalog#slug)">
            <input
              value={form.slug}
              onChange={(e) => updateForm({ slug: e.target.value, slugTouched: true })}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Lowercase letters, numbers, and dashes"
              className={inputClass()}
              placeholder="flight-finder"
            />
          </Field>
        </div>

        <Field label="Tagline" required hint="One-line pitch shown on the catalog card">
          <input
            value={form.tagline}
            onChange={(e) => updateForm({ tagline: e.target.value })}
            required
            className={inputClass()}
            placeholder="Find cheap flights across airlines"
          />
        </Field>

        <Field label="Description" required>
          <textarea
            value={form.description}
            onChange={(e) => updateForm({ description: e.target.value })}
            rows={2}
            required
            className={inputClass()}
            placeholder="What the agent does, what to expect."
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Category" hint="Optional grouping label">
            <input
              value={form.category}
              onChange={(e) => updateForm({ category: e.target.value })}
              className={inputClass()}
              placeholder="Travel"
            />
          </Field>
          <Field label="Icon" hint="Optional emoji shown on the card">
            <input
              value={form.icon}
              onChange={(e) => updateForm({ icon: e.target.value })}
              className={inputClass()}
              placeholder="✈️"
            />
          </Field>
        </div>

        <Field label="Endpoint" required hint="full URL including port">
          <input
            value={form.endpoint}
            onChange={(e) => updateForm({ endpoint: e.target.value })}
            required
            type="url"
            className={inputClass()}
            placeholder="https://agents.example.com/flight-finder"
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Auth mode"
            hint={
              form.authMode === "jwt"
                ? "Runtime mints a short-lived JWT per run, signed with the secret below"
                : "No auth — user id is forwarded via forwardedProps.user_id"
            }
          >
            <select
              value={form.authMode}
              onChange={(e) => {
                const authMode = e.target.value as TemplateAuthMode;
                updateForm({ authMode, jwtSecret: "", jwtScopes: "" });
              }}
              className={inputClass()}
            >
              <option value="none">None (anonymous)</option>
              <option value="jwt">JWT (HS256)</option>
            </select>
          </Field>
          {form.authMode === "jwt" && (
            <>
              <Field
                label="JWT secret"
                hint={
                  editingId && editingHasJwtSecret
                    ? "Key set ✓ — leave blank to keep existing, type a new value to replace"
                    : "Shared HS256 secret (≥32 chars) — same value as the backend's JWT verification key."
                }
              >
                <input
                  value={form.jwtSecret}
                  onChange={(e) => updateForm({ jwtSecret: e.target.value })}
                  type="password"
                  minLength={32}
                  className={inputClass()}
                  placeholder={
                    editingId && editingHasJwtSecret ? "(unchanged)" : "at least 32 characters"
                  }
                />
              </Field>
              <Field
                label="JWT scopes"
                hint="Comma-separated. Only when the backend has authorization=True."
              >
                <input
                  value={form.jwtScopes}
                  onChange={(e) => updateForm({ jwtScopes: e.target.value })}
                  className={inputClass()}
                  placeholder="agents:run"
                />
              </Field>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Required plan" hint="Gate the agent to a paid tier">
            <select
              value={form.requiredPlan}
              onChange={(e) =>
                // Picking a plan gate means there's no free tier — clear
                // the quota field visually so a stale value can't be
                // misread as "kept" (the payload clears it either way).
                updateForm({
                  requiredPlan: e.target.value as FormState["requiredPlan"],
                  freeDailyQuota: "",
                })
              }
              className={inputClass()}
            >
              <option value="">All plans</option>
              <option value="pro">Pro and up</option>
              <option value="team">Team only</option>
            </select>
          </Field>
          <Field
            label="Free daily quota"
            hint={
              form.requiredPlan
                ? "Not applicable — plan-gated agents have no free tier"
                : "Runs per user per rolling 24h on the Free plan (SaaS). Blank = unlimited."
            }
          >
            <input
              value={form.freeDailyQuota}
              onChange={(e) => updateForm({ freeDailyQuota: e.target.value })}
              type="number"
              min={1}
              disabled={!!form.requiredPlan}
              className={inputClass(!!form.requiredPlan)}
              placeholder="unlimited"
            />
          </Field>
          <Field label="Sort order" hint="Lower numbers appear first">
            <input
              value={form.sortOrder}
              onChange={(e) => updateForm({ sortOrder: e.target.value })}
              type="number"
              min={0}
              className={inputClass()}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => updateForm({ isActive: e.target.checked })}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Published (visible in the catalog)
        </label>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Saving..." : editingId ? "Update template" : "Publish template"}
          </button>
          <button
            type="button"
            onClick={resetForm}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => runFormTest(form.endpoint)}
            disabled={formTest.status === "loading" || !form.endpoint}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title={TEST_HELP}
          >
            {formTest.status === "loading" ? "Testing..." : "Test connection"}
          </button>
          <TestBadge result={formTest} />
        </div>
      </form>
      )}

      {loading ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 px-6 py-8 text-center dark:border-zinc-800">
          <p className="text-sm text-zinc-400">
            No templates yet — publish one to make it installable from{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-900">/app/catalog</code>.
          </p>
          {!formOpen && (
            <button
              type="button"
              onClick={toggleForm}
              className="mt-3 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Publish your first template
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Endpoint</th>
                <th className="px-4 py-2">Gate</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {templates.map((template) => {
                const rowTest = rowTests[template.id] ?? { status: "idle" as TestStatus };
                return (
                  <tr key={template.id} className="bg-white dark:bg-zinc-950">
                    <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {template.slug}
                    </td>
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                      {template.icon && <span className="mr-1">{template.icon}</span>}
                      {template.name}
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {template.endpoint}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {template.requiredPlan
                        ? template.requiredPlan === "pro"
                          ? "Pro+"
                          : "Team"
                        : template.freeDailyQuota != null
                          ? "Free: daily limit"
                          : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {template.isActive ? (
                        <span className="text-green-600 dark:text-green-400">published</span>
                      ) : (
                        <span className="text-zinc-400">unpublished</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button
                        onClick={() => startEdit(template)}
                        className="mr-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleToggleActive(template)}
                        className="mr-2 text-xs font-medium text-zinc-600 hover:underline dark:text-zinc-400"
                        title={
                          template.isActive
                            ? "Unpublish — hides from the catalog and pauses runs for everyone (reversible; past chats stay viewable)"
                            : "Publish — makes it installable and resumes runs"
                        }
                      >
                        {template.isActive ? "Unpublish" : "Publish"}
                      </button>
                      <button
                        onClick={() => runRowTest(template.id, template.endpoint)}
                        disabled={rowTest.status === "loading"}
                        className="mr-2 text-xs font-medium text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
                        title={TEST_HELP}
                      >
                        {rowTest.status === "loading" ? "Testing..." : "Test"}
                      </button>
                      <button
                        onClick={() => handleDelete(template)}
                        className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                      >
                        Delete
                      </button>
                      <TestBadge result={rowTest} inline />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>}
    </label>
  );
}

function inputClass(disabled = false): string {
  return [
    "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors",
    "focus:border-blue-500 focus:ring-1 focus:ring-blue-500",
    "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50",
    disabled ? "opacity-60" : "",
  ].join(" ");
}

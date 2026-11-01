"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PublicAgent, AgentAuthMode } from "@/lib/agents/agents.config";
import { BackToChat } from "@/components/back-to-chat";
import { BuilderForm } from "@/components/builder/builder-form";
import { ConnectorsAdmin } from "@/components/connectors-admin";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useBilling } from "@/lib/billing/use-billing";
import {
  TEST_HELP,
  TestBadge,
  useTestResults,
  type TestResult,
} from "@/components/test-connection";

type FormState = {
  name: string;
  description: string;
  endpoint: string;
  authMode: AgentAuthMode;
  jwtSecret: string;
  jwtScopes: string;
};

const emptyForm: FormState = {
  name: "",
  description: "",
  endpoint: "",
  authMode: "none",
  jwtSecret: "",
  jwtScopes: "",
};

/** Which form the panel is showing. "builder" = the agent builder form
 *  (member-accessible, create or edit); "custom" = the endpoint/JWT form
 *  for connecting an existing AG-UI backend (org-admin gated). */
type PanelKind = "builder" | "custom";

/** The agent being edited, when the panel is in edit mode. The name is
 *  snapshotted from the table row so the panel heading renders instantly
 *  (the builder form fetches the full definition itself). */
type Editing = {
  id: string;
  kind: PanelKind;
  name: string;
  hasJwtSecret: boolean;
};

/**
 * /agents — the one workspace agent-management surface. Three agent kinds,
 * one page: builder agents (created here via the embedded agent builder
 * form — member-accessible, author-only edits), custom endpoint agents
 * (org-admin only), and catalog installs (curator-managed, no local
 * edits). The panel above the table shows the correct form per kind.
 * Wrapped in Suspense because the inner page reads ?add=1 via
 * useSearchParams (Next requires a boundary on statically prerendered
 * routes).
 */
export default function AgentsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AgentsPageInner />
    </Suspense>
  );
}

function PageLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
      <p className="text-sm text-zinc-400">Loading...</p>
    </div>
  );
}

function AgentsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const addParam = searchParams.get("add");
  const { data: session, isPending } = authClient.useSession();
  const { config } = useAuthConfig();
  const { canManage, loading: canManageLoading } = useCanManageAgents();
  const { billing } = useBilling();
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  // The add panel's kind (builder default — the headline flow). Only
  // meaningful while !editing; admins can flip it, members see the
  // builder form only (custom agents are org-admin created).
  const [addKind, setAddKind] = useState<PanelKind>("builder");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { formTest, rowTests, runFormTest, runRowTest, resetFormTest } =
    useTestResults();
  const [formOpen, setFormOpen] = useState(false);
  // One-shot latch so ?add=1 opens the add panel exactly once (sidebar +
  // chat empty-state CTA). Render-time adjustment — covers both direct
  // URL visits and hydration, and never closes a panel the user opened
  // manually afterwards.
  const [openedFromAddParam, setOpenedFromAddParam] = useState(false);
  if (addParam === "1" && !openedFromAddParam) {
    setOpenedFromAddParam(true);
    setAddKind("builder");
    setFormOpen(true);
  }
  const panelRef = useRef<HTMLDivElement>(null);

  // The signed-in user id — drives the author-only Edit gate on builder
  // rows (same rule the backend PATCH/DELETE enforce).
  const currentUserId = session?.user.id ?? config?.user?.id ?? null;

  useEffect(() => {
    if (isPending || !config) return;
    // In solo mode (AUTH_DISABLED=true) the server treats every visitor
    // as the synthetic admin — grant full access without redirecting.
    if (config.authDisabled) return;
    if (!session) {
      router.push("/login");
      return;
    }
    // Members may view the table and edit their OWN builder agents here
    // (the builder is member-accessible); the admin-only surfaces —
    // custom endpoint agents, connector management, deletes — gate their
    // controls individually (and the backend enforces the same lines).
  }, [session, isPending, router, config]);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/agents");
    if (res.ok) setAgents(await res.json());
    setLoading(false);
  }, []);

  const fetchRef = useRef(fetchAgents);
  useEffect(() => {
    fetchRef.current = fetchAgents;
  }, [fetchAgents]);

  useEffect(() => {
    fetchRef.current();
  }, []);

  // Bring the panel into view when it opens, when the edit target
  // changes, or when the kind toggle swaps the form.
  useEffect(() => {
    if (formOpen) {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [formOpen, editing, addKind]);

  const updateForm = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    resetFormTest();
  };

  const startEditCustom = (agent: PublicAgent) => {
    setEditing({
      id: agent.id,
      kind: "custom",
      name: agent.name,
      hasJwtSecret: agent.hasJwtSecret,
    });
    setForm({
      name: agent.name,
      description: agent.description,
      // Edit is only reachable for non-managed, non-builder agents (the
      // other rows hide the button), but the type is optional — default
      // defensively.
      endpoint: agent.endpoint ?? "",
      // Never pre-fill secrets. The fields start empty; submitting
      // blank omits them from the PATCH (preserving the stored values).
      // hasJwtSecret drives helper text below.
      authMode: agent.authMode,
      jwtSecret: "",
      jwtScopes: agent.jwtScopes?.join(", ") ?? "",
    });
    setError(null);
    resetFormTest();
    setFormOpen(true);
  };

  const startEditBuilder = (agent: PublicAgent) => {
    setEditing({
      id: agent.id,
      kind: "builder",
      name: agent.name,
      hasJwtSecret: false,
    });
    setError(null);
    setFormOpen(true);
  };

  const closePanel = () => {
    setForm(emptyForm);
    setEditing(null);
    setError(null);
    resetFormTest();
    setFormOpen(false);
  };

  // Header-button toggle: opening from closed starts a clean builder
  // panel (the headline flow); closing (Cancel path) resets any
  // in-progress add or edit.
  const toggleForm = () => {
    if (formOpen) {
      closePanel();
    } else {
      setError(null);
      setAddKind("builder");
      setFormOpen(true);
    }
  };

  // The kind toggle (add flow only): flipping swaps the form below it
  // immediately — no second click — and discards whatever was typed in
  // the other form (both are short; a confirm dialog would be worse).
  const flipAddKind = () => {
    const next: PanelKind = addKind === "builder" ? "custom" : "builder";
    setAddKind(next);
    setForm(emptyForm);
    setError(null);
    resetFormTest();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const payload = {
      name: form.name,
      description: form.description,
      endpoint: form.endpoint,
      // authMode is always sent (defaults to "none"). jwtSecret follows
      // the same blank-preserve pattern — only sent when non-blank, so
      // blank submit on PATCH keeps the existing value.
      authMode: form.authMode,
      ...(form.jwtSecret ? { jwtSecret: form.jwtSecret } : {}),
      // jwtScopes: comma-separated text → string[]. Always sent (even
      // when empty) so clearing the field clears the stored value —
      // unlike jwtSecret, scopes are config, not a secret, so blank
      // means "remove all scopes", not "keep existing".
      jwtScopes: form.jwtScopes.split(",").map((s) => s.trim()).filter(Boolean),
    };

    try {
      const url = editing ? `/api/agents/${editing.id}` : "/api/agents";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Request failed (${res.status})`);
        return;
      }

      await fetchAgents();
      closePanel();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name?: string) => {
    // Managed agents keep their config on the server (the catalog row is
    // a reference), so removal is just "this workspace stops having it".
    const label = name ?? id;
    if (!confirm(`Delete agent "${label}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Delete failed");
      return;
    }
    if (editing?.id === id) closePanel();
    await fetchAgents();
  };

  // Builder form outcomes. A save opens the agent in chat (the same
  // deep-link the standalone builder page used — /app?agent=<id> selects
  // it immediately); a delete refreshes the table in place.
  const handleBuilderSaved = (saved: PublicAgent) => {
    router.push(`/app?agent=${saved.id}`);
  };
  const handleBuilderDeleted = () => {
    void fetchAgents();
    closePanel();
  };

  if (isPending || !config || canManageLoading || (!session && !config.authDisabled)) {
    return <PageLoading />;
  }

  const showPanel = formOpen;
  const panelIsBuilder = editing ? editing.kind === "builder" : addKind === "builder";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-10">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Agents
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Add, edit, or remove this workspace&apos;s agents. Build a new
              one with the agent builder, or connect your own AG-UI backend.
            </p>
          </div>
          <BackToChat />
        </header>

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        <section className="mb-10">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Configured agents ({agents.length})
            </h2>
            <button
              type="button"
              onClick={toggleForm}
              className="shrink-0 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {formOpen ? "Close" : "+ Add agent"}
            </button>
          </div>

          {showPanel && (
            <div
              ref={panelRef}
              className="mb-6 scroll-mt-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
            >
              {/* Kind toggle — the add flow only (an edit is always the
                  edited agent's kind). Org-admin only: custom endpoint
                  agents are admin-created, so members get the builder
                  form straight away with no toggle. Flipping discards
                  the other form's input (see flipAddKind). */}
              {!editing && canManage && (
                <div
                  className="mb-5 flex w-fit gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900"
                  role="tablist"
                  aria-label="Agent type"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={addKind === "builder"}
                    onClick={addKind !== "builder" ? flipAddKind : undefined}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      addKind === "builder"
                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-50"
                        : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    Create a new agent
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={addKind === "custom"}
                    onClick={addKind !== "custom" ? flipAddKind : undefined}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      addKind === "custom"
                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-50"
                        : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    Connect an existing agent
                  </button>
                </div>
              )}

              {editing && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                    Edit {editing.name}
                  </h3>
                </div>
              )}

              {panelIsBuilder ? (
                <BuilderForm
                  key={editing?.id ?? "create"}
                  mode={editing?.kind === "builder" ? "edit" : "create"}
                  agentId={editing?.kind === "builder" ? editing.id : undefined}
                  onSaved={handleBuilderSaved}
                  onDeleted={handleBuilderDeleted}
                  onCancel={closePanel}
                />
              ) : (
                <form
                  onSubmit={handleSubmit}
                  className="space-y-4"
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Name" required>
                      <input
                        value={form.name}
                        onChange={(e) => updateForm({ name: e.target.value })}
                        required
                        className={inputClass()}
                        placeholder="Research Agent"
                      />
                    </Field>
                    <Field label="Description" required>
                      <input
                        value={form.description}
                        onChange={(e) => updateForm({ description: e.target.value })}
                        required
                        className={inputClass()}
                        placeholder="LangGraph-powered web research assistant"
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
                      placeholder="http://localhost:8001/agent"
                    />
                  </Field>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                      label="Auth mode"
                      hint={
                        form.authMode === "jwt"
                          ? "Runtime mints a short-lived JWT per run, signed with the secret below, sent as Authorization: Bearer"
                          : "No auth — the agent endpoint is anonymous. User id is forwarded via forwardedProps.user_id"
                      }
                    >
                      <select
                        value={form.authMode}
                        onChange={(e) => {
                          const authMode = e.target.value as AgentAuthMode;
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
                            editing && editingHasJwtSecret()
                              ? "Key set ✓ — leave blank to keep existing, type a new value to replace"
                              : "Shared HS256 secret (≥32 chars). Set this to the same value as your backend's JWT verification key."
                          }
                        >
                          <input
                            value={form.jwtSecret}
                            onChange={(e) => updateForm({ jwtSecret: e.target.value })}
                            type="password"
                            minLength={32}
                            className={inputClass()}
                            placeholder={
                              editing && editingHasJwtSecret()
                                ? "(unchanged)"
                                : "at least 32 characters"
                            }
                          />
                        </Field>
                        <Field
                          label="JWT scopes"
                          hint="Comma-separated, e.g. agents:run. Only needed if your backend has authorization=True enabled — otherwise leave blank."
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

                  <p className="text-xs text-zinc-500">
                    Need an agent backend?{" "}
                    <a
                      href="https://docs.ag-ui.com/quickstart/server"
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      AG-UI quickstart →
                    </a>
                    {" · "}
                    <a
                      href="https://github.com/ag-ui-protocol/ag-ui"
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Browse 19 integrations →
                    </a>
                  </p>

                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    >
                      {submitting
                        ? "Saving..."
                        : editing
                          ? "Update agent"
                          : "Create agent"}
                    </button>
                    <button
                      type="button"
                      onClick={closePanel}
                      className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => runFormTest(form.endpoint)}
                      disabled={
                        formTest.status === "loading" || !form.endpoint
                      }
                      className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      title={TEST_HELP}
                    >
                      {formTest.status === "loading" ? "Testing..." : "Test connection"}
                    </button>
                    <span
                      className="ml-1 inline-flex cursor-help text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
                      title={TEST_HELP}
                      aria-label="What does Test connection check?"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="h-4 w-4"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm0-9a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM7 7a.75.75 0 0 0 0 1.5h.25v2.5H7a.75.75 0 0 0 0 1.5h2a.75.75 0 0 0 0-1.5h-.25v-3A.75.75 0 0 0 8 7H7Z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </span>
                    <TestBadge result={formTest} />
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Over-limit banner — surfaces the post-cancellation state
              where a downgraded Team org has more agents than the Free
              3-agent cap. Informational only; existing agents keep
              running, the server blocks new ones until the owner
              removes agents or upgrades. Tombstones (removed catalog
              agents kept for history) don't count toward the cap. */}
          {!loading &&
            canManage &&
            billing !== null &&
            billing.limits.maxAgents !== null &&
            (() => {
              const liveAgents = agents.filter((a) => !a.templateRemovedAt);
              return liveAgents.length > billing.limits.maxAgents ? (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  Your workspace is over the {billing.limits.label} plan&apos;s{" "}
                  {billing.limits.maxAgents}-agent limit. Remove{" "}
                  {liveAgents.length - billing.limits.maxAgents} agent
                  {liveAgents.length - billing.limits.maxAgents === 1 ? "" : "s"} or
                  upgrade in the account menu.
                </div>
              ) : null;
            })()}

          {loading ? (
            <p className="text-sm text-zinc-400">Loading...</p>
          ) : agents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 px-6 py-8 text-center dark:border-zinc-800">
              <p className="text-sm text-zinc-400">
                No agents yet — new ones appear in the chat sidebar immediately.
              </p>
              {!formOpen && (
                <button
                  type="button"
                  onClick={toggleForm}
                  className="mt-3 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Add your first agent
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop table — hidden on mobile. */}
              <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block dark:border-zinc-800">
                <table className="w-full text-left text-sm">
                  <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-2">Name</th>
                      <th className="px-4 py-2">Endpoint</th>
                      <th className="px-4 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {agents.map((agent) => (
                      <AgentRow
                        key={agent.id}
                        agent={agent}
                        rowTest={rowTests[agent.id] ?? { status: "idle" }}
                        canManage={canManage === true}
                        currentUserId={currentUserId}
                        onEdit={startEditBuilder}
                        onEditCustom={startEditCustom}
                        onTest={(id, endpoint) => runRowTest(id, endpoint)}
                        rowTestLoading={rowTests[agent.id]?.status === "loading"}
                        onDelete={handleDelete}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile card list — stacked per agent. Hidden on desktop. */}
              <ul className="space-y-3 md:hidden">
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    rowTest={rowTests[agent.id] ?? { status: "idle" }}
                    canManage={canManage === true}
                    currentUserId={currentUserId}
                    onEdit={startEditBuilder}
                    onEditCustom={startEditCustom}
                    onTest={(id, endpoint) => runRowTest(id, endpoint)}
                    rowTestLoading={rowTests[agent.id]?.status === "loading"}
                    onDelete={handleDelete}
                  />
                ))}
              </ul>
            </>
          )}
        </section>

        {/* Org MCP connectors — the builder's connector palette source.
            Org-admin only: members reference connectors in the builder
            form but can't add or change them (same gate the backend
            enforces on PUT/DELETE /api/connectors). */}
        {canManage && (
          <ConnectorsAdmin />
        )}
      </div>
    </div>
  );

  function editingHasJwtSecret(): boolean {
    return editing?.hasJwtSecret ?? false;
  }
}

/* ---------------------------------------------------------------------- */
/* Row rendering — desktop table row + mobile card. One source of truth   */
/* for the per-kind action gates:                                         */
/*   builder rows  → Edit for the author only (members and admins alike), */
/*                   no Test (no client-visible endpoint to probe),       */
/*                   Delete for org admins;                               */
/*   custom rows   → Edit + Test for org admins (custom agents are        */
/*                   admin-created);                                      */
/*   managed rows  → no Edit, no Test (curator-owned), Delete labelled    */
/*                   "Remove".                                            */
/* ---------------------------------------------------------------------- */

type RowActionProps = {
  agent: PublicAgent;
  rowTest: TestResult,
  canManage: boolean;
  currentUserId: string | null;
  onEdit: (agent: PublicAgent) => void;
  onEditCustom: (agent: PublicAgent) => void;
  onTest: (id: string, endpoint: string) => void;
  rowTestLoading: boolean;
  onDelete: (id: string, name?: string) => void;
};

function canEditBuilderRow(
  agent: PublicAgent,
  currentUserId: string | null,
): boolean {
  return agent.origin === "builder" && agent.authorUserId === currentUserId;
}

function AgentRow({
  agent,
  rowTest,
  canManage,
  currentUserId,
  onEdit,
  onEditCustom,
  onTest,
  rowTestLoading,
  onDelete,
}: RowActionProps) {
  const managed = Boolean(agent.sourceTemplateId);
  const isBuilder = agent.origin === "builder";
  const removed = Boolean(agent.templateRemovedAt);
  const paused = !removed && Boolean(agent.templateUnpublished);
  const canEdit = !managed && (isBuilder ? canEditBuilderRow(agent, currentUserId) : canManage);
  return (
    <tr className="bg-white dark:bg-zinc-950">
      <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
        {agent.name}
        {managed && <CatalogChip removed={removed} paused={paused} />}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
        {/* Managed agents carry no endpoint in the API — the curator's
            URL never leaves the server. Builder agents run on the
            platform — the endpoint concept doesn't apply to them. */}
        {managed ? (
          <span className="font-sans text-zinc-400">Managed by catalog</span>
        ) : isBuilder ? (
          <span className="font-sans text-zinc-400">Built with the agent builder</span>
        ) : (
          agent.endpoint
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {canEdit && (
          <button
            onClick={() => (isBuilder ? onEdit(agent) : onEditCustom(agent))}
            className="mr-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Edit
          </button>
        )}
        {!managed && !isBuilder && (
          <button
            onClick={() => onTest(agent.id, agent.endpoint ?? "")}
            disabled={rowTestLoading}
            className="mr-2 text-xs font-medium text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
            title={TEST_HELP}
          >
            {rowTestLoading ? "Testing..." : "Test"}
          </button>
        )}
        {canManage && (
          <button
            onClick={() => onDelete(agent.id, agent.name)}
            className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
          >
            {managed ? "Remove" : "Delete"}
          </button>
        )}
        {!managed && !isBuilder && <TestBadge result={rowTest} inline />}
      </td>
    </tr>
  );
}

function AgentCard({
  agent,
  rowTest,
  canManage,
  currentUserId,
  onEdit,
  onEditCustom,
  onTest,
  rowTestLoading,
  onDelete,
}: RowActionProps) {
  const managed = Boolean(agent.sourceTemplateId);
  const isBuilder = agent.origin === "builder";
  const removed = Boolean(agent.templateRemovedAt);
  const paused = !removed && Boolean(agent.templateUnpublished);
  const canEdit = !managed && (isBuilder ? canEditBuilderRow(agent, currentUserId) : canManage);
  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-zinc-900 dark:text-zinc-50">
            {agent.name}
            {managed && <CatalogChip removed={removed} paused={paused} />}
          </p>
        </div>
      </div>
      {!managed && !isBuilder && (
        <p className="mt-2 truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
          {agent.endpoint}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {canEdit && (
          <button
            onClick={() => (isBuilder ? onEdit(agent) : onEditCustom(agent))}
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Edit
          </button>
        )}
        {!managed && !isBuilder && (
          <button
            onClick={() => onTest(agent.id, agent.endpoint ?? "")}
            disabled={rowTestLoading}
            className="text-xs font-medium text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
            title={TEST_HELP}
          >
            {rowTestLoading ? "Testing..." : "Test"}
          </button>
        )}
        {canManage && (
          <button
            onClick={() => onDelete(agent.id, agent.name)}
            className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
          >
            {managed ? "Remove" : "Delete"}
          </button>
        )}
        {!managed && !isBuilder && <TestBadge result={rowTest} inline />}
      </div>
    </li>
  );
}

function CatalogChip({
  removed,
  paused,
}: {
  removed: boolean;
  paused: boolean;
}) {
  // Mirrors the sidebar's chip treatment: zinc = tombstoned (removed
  // from the catalog, past chats stay viewable — inactive, not an
  // error), amber = paused by the curator (reversible kill switch),
  // blue = live catalog install.
  const state = removed
    ? {
        label: "Removed",
        cls: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
      }
    : paused
      ? {
          label: "Paused",
          cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
        }
      : {
          label: "Catalog",
          cls: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
        };
  return (
    <span
      className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${state.cls}`}
    >
      {state.label}
    </span>
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
      {hint && (
        <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>
      )}
    </label>
  );
}

function inputClass(disabled = false): string {
  return [
    "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition-colors",
    "focus:border-blue-500 focus:ring-1 focus:ring-blue-500",
    "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50",
    disabled ? "opacity-60" : "",
  ].join(" ");
}

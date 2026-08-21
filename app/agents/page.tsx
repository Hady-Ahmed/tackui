"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { PublicAgent, AgentKind } from "@/lib/agents/agents.config";
import { UsersAdmin } from "@/components/users-admin";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useBilling } from "@/lib/billing/use-billing";

const KIND_OPTIONS: { value: AgentKind; label: string; description: string }[] = [
  {
    value: "agui",
    label: "AG-UI / Generic",
    description:
      "For any AG-UI-speaking endpoint — Agno, CrewAI, Pydantic AI, Mastra, LangGraph (via ag-ui-langgraph), or a custom backend.",
  },
  {
    value: "langgraph",
    label: "LangGraph Platform",
    description:
      "For LangGraph Cloud / Studio backends using the LangGraph Platform API. Needs a Graph ID.",
  },
];

type FormState = {
  name: string;
  description: string;
  kind: AgentKind;
  endpoint: string;
  graphId: string;
  langsmithApiKey: string;
};

const emptyForm: FormState = {
  name: "",
  description: "",
  kind: "agui",
  endpoint: "",
  graphId: "",
  langsmithApiKey: "",
};

type TestStatus = "idle" | "loading" | "ok" | "fail";
type TestResult = { status: TestStatus; message?: string };

const TEST_HELP =
  "Tests only that the server is reachable (an HTTP request succeeds). " +
  "A success does NOT validate auth, AG-UI protocol compliance, or that the agent will actually run. " +
  "A failure usually means the URL is wrong or the server is down.";

async function testEndpoint(
  endpoint: string,
  kind: AgentKind,
): Promise<TestResult> {
  try {
    const res = await fetch("/api/agents/reachability-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, kind }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        status: "fail",
        message:
          (typeof data === "object" && data && "error" in data
            ? String((data as { error: unknown }).error)
            : `Request failed (${res.status})`) ||
          "Validation failed — check the URL.",
      };
    }
    return {
      status: data.ok ? "ok" : "fail",
      message: data.message as string,
    };
  } catch {
    return { status: "fail", message: "Network error talking to /api/agents/reachability-probe" };
  }
}

export default function AgentsPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { config } = useAuthConfig();
  const { canManage, loading: canManageLoading } = useCanManageAgents();
  const { billing } = useBilling();
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingHasKey, setEditingHasKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formTest, setFormTest] = useState<TestResult>({ status: "idle" });
  const [rowTests, setRowTests] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    if (isPending || !config) return;
    // In solo mode (AUTH_DISABLED=true) the server treats every visitor
    // as the synthetic admin — grant full access without redirecting.
    if (config.authDisabled) return;
    if (!session) {
      router.push("/login");
      return;
    }
    // Gate on org-level agent management permission, not platform admin.
    // Org owners can manage their own workspace's agents; platform admins
    // can manage any org's agents. The server enforces this via
    // canManageAgents() — the hook just mirrors it for the redirect.
    if (canManage === false) {
      router.push("/app");
    }
  }, [session, isPending, router, config, canManage]);

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

  const updateForm = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setFormTest({ status: "idle" });
  };

  const startEdit = (agent: PublicAgent) => {
    setEditingId(agent.id);
    setEditingHasKey(agent.hasLangsmithApiKey);
    setForm({
      name: agent.name,
      description: agent.description,
      kind: agent.kind,
      endpoint: agent.endpoint,
      graphId: agent.graphId ?? "",
      // Never pre-fill the secret. The field starts empty; submitting
      // blank omits it from the PATCH (preserving the stored value).
      // hasLangsmithApiKey drives helper text below.
      langsmithApiKey: "",
    });
    setError(null);
    setFormTest({ status: "idle" });
  };

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setEditingHasKey(false);
    setError(null);
    setFormTest({ status: "idle" });
  };

  const handleTestForm = async () => {
    if (!form.endpoint) return;
    setFormTest({ status: "loading" });
    const result = await testEndpoint(form.endpoint, form.kind);
    setFormTest(result);
  };

  const handleTestRow = async (agent: PublicAgent) => {
    setRowTests((prev) => ({ ...prev, [agent.id]: { status: "loading" } }));
    const result = await testEndpoint(agent.endpoint, agent.kind);
    setRowTests((prev) => ({ ...prev, [agent.id]: result }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const payload = {
      name: form.name,
      description: form.description,
      kind: form.kind,
      endpoint: form.endpoint,
      ...(form.graphId ? { graphId: form.graphId } : {}),
      ...(form.langsmithApiKey ? { langsmithApiKey: form.langsmithApiKey } : {}),
    };

    try {
      const url = editingId ? `/api/agents/${editingId}` : "/api/agents";
      const method = editingId ? "PATCH" : "POST";
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
      resetForm();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete agent "${id}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Delete failed");
      return;
    }
    if (editingId === id) resetForm();
    await fetchAgents();
  };

  if (isPending || !config || canManageLoading || (!session && !config.authDisabled) || (!config.authDisabled && canManage !== true)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Agents
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Add, edit, or remove AG-UI-compatible agent backends. Changes
              apply immediately — no restart needed.
            </p>
          </div>
          <Link
            href="/app"
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            ← Back to chat
          </Link>
        </header>

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        <section className="mb-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            {editingId ? "Edit agent" : "Add agent"}
          </h2>
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name">
                <input
                  value={form.name}
                  onChange={(e) => updateForm({ name: e.target.value })}
                  required
                  className={inputClass()}
                  placeholder="Research Agent"
                />
              </Field>
              <Field label="Description">
                <input
                  value={form.description}
                  onChange={(e) => updateForm({ description: e.target.value })}
                  className={inputClass()}
                  placeholder="LangGraph-powered web research assistant"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Kind">
                <select
                  value={form.kind}
                  onChange={(e) => {
                    const kind = e.target.value as AgentKind;
                    if (kind !== "langgraph") {
                      updateForm({ kind, graphId: "", langsmithApiKey: "" });
                    } else {
                      updateForm({ kind });
                    }
                  }}
                  className={inputClass()}
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-zinc-500">
                  {KIND_OPTIONS.find((k) => k.value === form.kind)?.description}
                </p>
              </Field>
              <Field label="Endpoint" hint="full URL including port">
                <input
                  value={form.endpoint}
                  onChange={(e) => updateForm({ endpoint: e.target.value })}
                  required
                  type="url"
                  className={inputClass()}
                  placeholder="http://localhost:8001/agent"
                />
              </Field>
            </div>

            {form.kind === "langgraph" && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Graph ID" hint="langgraph only, optional">
                  <input
                    value={form.graphId}
                    onChange={(e) => updateForm({ graphId: e.target.value })}
                    className={inputClass()}
                    placeholder="agent"
                  />
                </Field>
                <Field
                  label="LangSmith API Key"
                  hint={
                    editingId && editingHasKey
                      ? "Key set ✓ — leave blank to keep existing, type a new value to replace"
                      : "langgraph only, optional"
                  }
                >
                  <input
                    value={form.langsmithApiKey}
                    onChange={(e) =>
                      updateForm({ langsmithApiKey: e.target.value })
                    }
                    type="password"
                    className={inputClass()}
                    placeholder={editingId && editingHasKey ? "(unchanged)" : "ls-..."}
                  />
                </Field>
              </div>
            )}

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
                href="https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations"
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
                  : editingId
                    ? "Update agent"
                    : "Create agent"}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={handleTestForm}
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
        </section>

        <section>
          {/* Over-limit banner — surfaces the post-cancellation state
              where a downgraded Team org has more agents than the Free
              3-agent cap. Informational only; existing agents keep
              running, the server blocks new ones until the owner
              removes agents or upgrades. */}
          {!loading &&
            canManage &&
            billing !== null &&
            billing.limits.maxAgents !== null &&
            agents.length > billing.limits.maxAgents && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                Your workspace is over the {billing.limits.label} plan&apos;s{" "}
                {billing.limits.maxAgents}-agent limit. Remove{" "}
                {agents.length - billing.limits.maxAgents} agent
                {agents.length - billing.limits.maxAgents === 1 ? "" : "s"} or
                upgrade in the account menu.
              </div>
            )}

          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Configured agents ({agents.length})
          </h2>
          {loading ? (
            <p className="text-sm text-zinc-400">Loading...</p>
          ) : agents.length === 0 ? (
            <p className="text-sm text-zinc-400">
              No agents yet. Add one above — it will appear in the chat sidebar
              immediately.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2">ID</th>
                    <th className="px-4 py-2">Name</th>
                    <th className="px-4 py-2">Kind</th>
                    <th className="px-4 py-2">Endpoint</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {agents.map((agent) => {
                    const rowTest = rowTests[agent.id] ?? { status: "idle" };
                    return (
                      <tr
                        key={agent.id}
                        className="bg-white dark:bg-zinc-950"
                      >
                        <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {agent.id}
                        </td>
                        <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                          {agent.name}
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            {agent.kind}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {agent.endpoint}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => startEdit(agent)}
                            className="mr-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleTestRow(agent)}
                            disabled={rowTest.status === "loading"}
                            className="mr-2 text-xs font-medium text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
                            title={TEST_HELP}
                          >
                            {rowTest.status === "loading" ? "Testing..." : "Test"}
                          </button>
                          <button
                            onClick={() => handleDelete(agent.id)}
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

        <UsersAdmin />
      </div>
    </div>
  );
}

function TestBadge({
  result,
  inline = false,
}: {
  result: TestResult;
  inline?: boolean;
}) {
  if (result.status === "idle" || result.status === "loading") {
    if (result.status === "loading") {
      return (
        <span className={`${inline ? "ml-2" : ""} text-xs text-zinc-400`}>
          ...
        </span>
      );
    }
    return null;
  }

  const ok = result.status === "ok";
  return (
    <span
      className={`${inline ? "ml-2" : ""} text-xs font-medium ${
        ok
          ? "text-green-600 dark:text-green-400"
          : "text-red-600 dark:text-red-400"
      }`}
      title={result.message}
    >
      {ok ? "✓" : "✗"} {result.message}
    </span>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
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
    "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors",
    "focus:border-blue-500 focus:ring-1 focus:ring-blue-500",
    "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50",
    disabled ? "opacity-60" : "",
  ].join(" ");
}

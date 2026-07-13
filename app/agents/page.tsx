"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import type { AgentEntry, AgentKind } from "@/lib/agents/agents.config";

const KINDS: AgentKind[] = ["langgraph", "agno", "agui"];

type FormState = {
  id: string;
  name: string;
  description: string;
  kind: AgentKind;
  endpoint: string;
  graphId: string;
  langsmithApiKey: string;
};

const emptyForm: FormState = {
  id: "",
  name: "",
  description: "",
  kind: "agui",
  endpoint: "",
  graphId: "",
  langsmithApiKey: "",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const startEdit = (agent: AgentEntry) => {
    setEditingId(agent.id);
    setForm({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      kind: agent.kind,
      endpoint: agent.endpoint,
      graphId: agent.graphId ?? "",
      langsmithApiKey: agent.langsmithApiKey ?? "",
    });
    setError(null);
  };

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const payload = {
      id: form.id,
      name: form.name,
      description: form.description,
      kind: form.kind,
      endpoint: form.endpoint,
      ...(form.graphId ? { graphId: form.graphId } : {}),
      ...(form.langsmithApiKey ? { langsmithApiKey: form.langsmithApiKey } : {}),
    };

    try {
      const url = editingId
        ? `/api/agents/${editingId}`
        : "/api/agents";
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
            href="/"
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
              <Field label="ID" hint="lowercase kebab-case, immutable after creation">
                <input
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  disabled={!!editingId}
                  required
                  pattern="[a-z0-9-]+"
                  className={inputClass(editingId ? true : false)}
                  placeholder="research"
                />
              </Field>
              <Field label="Name">
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className={inputClass()}
                  placeholder="Research Agent"
                />
              </Field>
            </div>

            <Field label="Description">
              <input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                className={inputClass()}
                placeholder="LangGraph-powered web research assistant"
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Kind">
                <select
                  value={form.kind}
                  onChange={(e) =>
                    setForm({ ...form, kind: e.target.value as AgentKind })
                  }
                  className={inputClass()}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Endpoint" hint="full URL including port">
                <input
                  value={form.endpoint}
                  onChange={(e) =>
                    setForm({ ...form, endpoint: e.target.value })
                  }
                  required
                  type="url"
                  className={inputClass()}
                  placeholder="http://localhost:8001/agent"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Graph ID" hint="langgraph only, optional">
                <input
                  value={form.graphId}
                  onChange={(e) =>
                    setForm({ ...form, graphId: e.target.value })
                  }
                  className={inputClass()}
                  placeholder="agent"
                />
              </Field>
              <Field label="LangSmith API Key" hint="langgraph only, optional">
                <input
                  value={form.langsmithApiKey}
                  onChange={(e) =>
                    setForm({ ...form, langsmithApiKey: e.target.value })
                  }
                  type="password"
                  className={inputClass()}
                  placeholder="ls-..."
                />
              </Field>
            </div>

            <div className="flex gap-2 pt-2">
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
            </div>
          </form>
        </section>

        <section>
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
                  {agents.map((agent) => (
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
                          onClick={() => handleDelete(agent.id)}
                          className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
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

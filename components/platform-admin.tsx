"use client";

/**
 * The platform admin page's body — the deployment's agent catalog: which
 * model providers/models and which toolkits tackui's builder offers.
 *
 * The admin's only actions are ticking checkboxes and typing model ids —
 * everything else (class names, env keys, credential contracts, function
 * lists) is derived from the platform's discovery scan and rendered
 * read-only, so nothing editable here can desynchronize the stack. A save
 * is a full-state replace that goes live on the next request (the platform
 * rebuilds its registry lazily) — no restart, no redeploy.
 *
 * Model grammar (one entry per line, inside a provider's own block):
 *   model-id[:key=value ...]
 * The parser also still accepts a legacy `:tier` segment (dormant since
 * the tier system sleeps — builder runs are 100% BYOK; it wakes at
 * Phase 3 publishing) but the UI no longer advertises it.
 *
 * Wire contract (app/api/admin/platform):
 *  - GET  → {providers: [...], tools: [...]} — discovery ∪ durable rows.
 *  - PUT  → {providers?, tools?} — full-state replace; the platform
 *           validates entries against its own classes and answers 400 with
 *           its message, surfaced verbatim.
 *  - POST /test-model {entry} — one "hi" completion through the platform's
 *    own env key; disabled here when the provider's platform key isn't set.
 *
 * Disabling a provider/toolkit does not just hide it from the picker —
 * existing agents referencing it stop running it (the operator withdrew
 * the offering). The UI says so where it matters.
 */

import { useCallback, useEffect, useState } from "react";

/** One provider row of GET /api/admin/platform/catalog. */
interface CatalogProvider {
  slug: string;
  available: boolean;
  enabled: boolean;
  class_name: string | null;
  requires_key: boolean;
  platform_env_key: string | null;
  env_key_set: boolean;
  models: Array<{ id: string; attrs: Record<string, unknown>; tier: boolean }>;
}

/** One toolkit row of GET /api/admin/platform/catalog. */
interface CatalogTool {
  slug: string;
  available: boolean;
  enabled: boolean;
  class_name: string | null;
  label: string;
  functions: string[];
  credentials: Array<{ dep_key: string; env: string; arg: string; label: string }>;
  deliverable: boolean;
}

interface CatalogResponse {
  providers: CatalogProvider[];
  tools: CatalogTool[];
  error?: string;
}

/** The editable draft: provider slug → enabled + the textarea contents. */
interface ProviderDraft {
  enabled: boolean;
  modelsText: string;
}

/** Serialize a saved model row back to its grammar entry (textarea prefill). */
function modelEntryText(row: { id: string; attrs: Record<string, unknown>; tier: boolean }): string {
  const parts = [row.id];
  if (row.tier) parts.push("tier");
  for (const [key, value] of Object.entries(row.attrs)) {
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(":");
}

export function PlatformAdmin() {
  const [providers, setProviders] = useState<CatalogProvider[] | null>(null);
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  const [draft, setDraft] = useState<Record<string, ProviderDraft>>({});
  const [toolDraft, setToolDraft] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // model entry (provider:id[:attrs]) currently being tested → result copy.
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/admin/platform/catalog");
    const data = (await res.json().catch(() => ({}))) as CatalogResponse;
    if (!res.ok) {
      setError(
        typeof data.error === "string" && data.error
          ? data.error
          : `Failed to load models & tools (${res.status})`,
      );
      setLoading(false);
      return;
    }
    setProviders(data.providers ?? []);
    setTools(data.tools ?? []);
    const d: Record<string, ProviderDraft> = {};
    for (const p of data.providers ?? []) {
      d[p.slug] = {
        enabled: p.enabled,
        modelsText: p.models.map(modelEntryText).join("\n"),
      };
    }
    setDraft(d);
    const t: Record<string, boolean> = {};
    for (const tool of data.tools ?? []) t[tool.slug] = tool.enabled;
    setToolDraft(t);
    setLoading(false);
  }, []);

  useEffect(() => {
    const wrapper = async () => {
      await load();
      setLoading(false);
    };
    wrapper();
  }, [load]);

  const save = async () => {
    if (providers === null || tools === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/platform/catalog", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: providers.map((p) => ({
            slug: p.slug,
            enabled: draft[p.slug]?.enabled ?? false,
            models: (draft[p.slug]?.modelsText ?? "")
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          })),
          tools: tools.map((t) => ({
            slug: t.slug,
            enabled: toolDraft[t.slug] ?? false,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.error === "string" && data.error
            ? data.error
            : `Failed to save the catalog (${res.status})`,
        );
        return;
      }
      setNotice("Catalog saved — live on the next request.");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const testModel = async (provider: CatalogProvider, entry: string) => {
    const key = `${provider.slug}:${entry}`;
    setTesting(key);
    setError(null);
    try {
      const res = await fetch("/api/admin/platform/test-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: `${provider.slug}:${entry}` }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResults((prev) => ({
        ...prev,
        [key]:
          res.ok && data.ok
            ? `✓ ${typeof data.reply === "string" ? data.reply.slice(0, 80) : "ok"}`
            : `✗ ${typeof data.error === "string" && data.error ? data.error : `Failed (${res.status})`}`,
      }));
    } finally {
      setTesting(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  const dirty =
    providers?.some(
      (p) =>
        (draft[p.slug]?.enabled ?? false) !== p.enabled ||
        (draft[p.slug]?.modelsText ?? "") !== p.models.map(modelEntryText).join("\n"),
    ) ||
    tools?.some((t) => (toolDraft[t.slug] ?? false) !== t.enabled);

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
          {notice}
        </div>
      )}

      {/* Models */}
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Models
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            one per line: <code className="text-[11px]">model-id[:key=value]</code>
          </p>
        </div>
        <div className="space-y-2">
          {(providers ?? []).map((p) => {
            const d = draft[p.slug] ?? { enabled: p.enabled, modelsText: "" };
            return (
              <div
                key={p.slug}
                className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    disabled={!p.available}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        [p.slug]: { ...d, enabled: e.target.checked },
                      }))
                    }
                    className="h-4 w-4 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
                  />
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">{p.slug}</span>
                  {!p.available && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      No longer available
                    </span>
                  )}
                  {p.available && (
                    <span className="truncate text-xs text-zinc-400">{p.class_name}</span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                    {p.platform_env_key ? (
                      p.env_key_set ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
                          {p.platform_env_key} set
                        </span>
                      ) : (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                          {p.platform_env_key} not set
                        </span>
                      )
                    ) : (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                        no key needed
                      </span>
                    )}
                  </span>
                </div>
                {d.enabled && p.available && (
                  <div className="mt-2">
                    <textarea
                      value={d.modelsText}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          [p.slug]: { ...d, modelsText: e.target.value },
                        }))
                      }
                      rows={Math.max(2, d.modelsText.split("\n").length)}
                      placeholder={"model-id"}
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-xs text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                    />
                    {/* Saved models — test one "hi" through the platform's
                        own key (needs the key; the model object only). */}
                    {p.models.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {p.models.map((row) => {
                          const entry = modelEntryText(row);
                          const key = `${p.slug}:${entry}`;
                          return (
                            <div key={key} className="flex items-center gap-2 text-xs">
                              <code className="truncate text-zinc-500 dark:text-zinc-400">
                                {entry}
                              </code>
                              <button
                                type="button"
                                disabled={!p.env_key_set || testing !== null}
                                title={
                                  p.env_key_set
                                    ? undefined
                                    : `No ${p.platform_env_key} on this deployment — set it to test`
                                }
                                onClick={() => testModel(p, entry)}
                                className="shrink-0 rounded border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                              >
                                {testing === key ? "Testing…" : "Test"}
                              </button>
                              {testResults[key] && (
                                <span
                                  className={
                                    testResults[key].startsWith("✓")
                                      ? "truncate text-green-600 dark:text-green-400"
                                      : "truncate text-red-600 dark:text-red-400"
                                  }
                                >
                                  {testResults[key]}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Tools */}
      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Tools
        </h2>
        <div className="space-y-2">
          {(tools ?? []).map((t) => {
            const checked = toolDraft[t.slug] ?? false;
            return (
              <div
                key={t.slug}
                className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!t.available || !t.deliverable}
                    onChange={(e) =>
                      setToolDraft((prev) => ({ ...prev, [t.slug]: e.target.checked }))
                    }
                    className="h-4 w-4 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
                  />
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">{t.label}</span>
                  {!t.available && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      No longer available
                    </span>
                  )}
                  {t.available && !t.deliverable && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      No key delivery path
                    </span>
                  )}
                  <span className="ml-auto truncate text-xs text-zinc-400">{t.class_name}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {t.functions.length > 0 ? t.functions.join(", ") : "No functions discovered."}
                </p>
                {t.credentials.length > 0 && (
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    Needs:{" "}
                    {t.credentials.map((c) => (
                      <span key={c.dep_key} className="mr-2 whitespace-nowrap">
                        <code className="text-[11px]">{c.dep_key}</code>
                        {c.env ? ` (env ${c.env})` : ""}
                      </span>
                    ))}
                  </p>
                )}
                {checked && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    Disabling this toolkit stops agents that use it.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Save — a full-state replace; the platform rebuilds on the next
          request, so changes go live without restart. */}
      <div className="sticky bottom-4 mt-6 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving || providers === null}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Save"}
        </button>
      </div>
    </div>
  );
}

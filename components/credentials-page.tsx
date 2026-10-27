"use client";

/**
 * The "API keys" page — the runner's BYOK credentials, reached from the
 * account menu (and linked from the builder's inline connect forms).
 *
 * Wire contract (app/api/credentials):
 *  - GET  → {credentials: [...saved...], catalog: {...} | null, catalogError?}
 *    The saved rows come from the local DB and ALWAYS render. The catalog
 *    is derived live from the AgentOS platform — when unreachable it comes
 *    back null and the page degrades: saved keys are still listed and
 *    deletable, only NEW keys can't be added (PUT validates against the
 *    live catalog, fail-closed).
 *  - PUT  → {provider, secret} — validated against the live catalog.
 *  - DELETE /:provider — accepts any saved provider, including ones the
 *    catalog no longer declares (a removed provider must never lock a key
 *    in; the row shows "No longer supported" and stays deletable).
 *
 * The plaintext key never leaves this page except in the PUT body — GET
 * responses carry existence booleans only.
 */

import { useCallback, useEffect, useState } from "react";
import { BackToChat } from "@/components/back-to-chat";

/** One saved row from GET /api/credentials. */
interface SavedCredential {
  provider: string;
  kind: "llm" | "tool";
  hasKey: boolean;
  updatedAt: string;
}

/** One catalog entry — the add-row source. */
interface CredentialMeta {
  kind: "llm" | "tool";
  keyName: string;
  label: string;
}

interface CredentialsResponse {
  credentials: SavedCredential[];
  catalog: Record<string, CredentialMeta> | null;
  catalogError?: string;
  error?: string;
}

/** Display label derived from a provider slug — mirrors the catalog's
 * prettifyProviderLabel (that module is server-side, so the client keeps
 * a local copy of the same convention). */
function providerLabel(provider: string): string {
  return provider
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function CredentialsPage() {
  const [credentials, setCredentials] = useState<SavedCredential[] | null>(null);
  const [catalog, setCatalog] = useState<Record<string, CredentialMeta> | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
  const [newSecrets, setNewSecrets] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/credentials");
    const data = (await res.json().catch(() => ({}))) as CredentialsResponse;
    if (!res.ok) {
      setError(
        typeof data.error === "string" && data.error
          ? data.error
          : `Failed to load your API keys (${res.status})`,
      );
      return;
    }
    setCredentials(data.credentials ?? []);
    setCatalog(data.catalog ?? null);
    setCatalogError(data.catalogError ?? null);
  }, []);

  useEffect(() => {
    const wrapper = async () => {
      await load();
      setLoading(false);
    };
    wrapper();
  }, [load]);

  const onSave = async (provider: string) => {
    const secret = newSecrets[provider];
    if (!secret) return;
    setSavingProvider(provider);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, secret }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.error === "string" && data.error
            ? data.error
            : `Failed to save the ${provider} key (${res.status})`,
        );
        return;
      }
      setNotice(`${providerLabel(provider)} key saved.`);
      setNewSecrets((prev) => ({ ...prev, [provider]: "" }));
      await load();
    } finally {
      setSavingProvider(null);
    }
  };

  const onDelete = async (provider: string) => {
    if (!confirm(`Delete your ${providerLabel(provider)} key? Agents using it will stop until you add a new one.`)) {
      return;
    }
    setDeletingProvider(provider);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/credentials/${provider}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.error === "string" && data.error
            ? data.error
            : `Failed to delete the ${provider} key (${res.status})`,
        );
        return;
      }
      setNotice(`${providerLabel(provider)} key deleted.`);
      await load();
    } finally {
      setDeletingProvider(null);
    }
  };

  const saved = credentials ?? [];
  // Add rows: catalog providers the runner hasn't saved a key for.
  const addRows = catalog
    ? Object.entries(catalog)
        .filter(([provider]) => !saved.some((c) => c.provider === provider))
        .map(([provider, meta]) => ({ provider, meta }))
    : [];
  // Saved rows that the catalog no longer declares.
  const catalogHas = (provider: string) =>
    catalog !== null ? Object.prototype.hasOwnProperty.call(catalog, provider) : null;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-2xl px-4 py-6 md:px-6 md:py-10 text-zinc-900 dark:text-zinc-100">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              API keys
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Keys your agents run on. Stored encrypted for your account and
              delivered to the agent platform per run — never shared.
            </p>
          </div>
          <BackToChat />
        </header>

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

        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <>
            {/* Platform-unreachable banner — the catalog is the only thing
                affected: saved rows keep working, only new keys are blocked. */}
            {catalog === null && catalogError && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                {catalogError}
              </div>
            )}

            {/* Saved keys */}
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Saved keys
            </h2>
            {saved.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                No keys saved yet.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {saved.map((c) => {
                  const known = catalogHas(c.provider);
                  const label = known
                    ? catalog![c.provider].label
                    : providerLabel(c.provider);
                  return (
                    <li
                      key={c.provider}
                      className="flex items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{label}</p>
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {c.kind === "llm" ? "Model key" : "Tool key"} · saved{" "}
                          {new Date(c.updatedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {/* A provider removed from the live catalog is
                            shown but flagged — the key still works for the
                            deletion path, and the run gate handles it. */}
                        {known === false && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                            No longer supported
                          </span>
                        )}
                        <button
                          onClick={() => onDelete(c.provider)}
                          disabled={deletingProvider !== null}
                          className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                        >
                          {deletingProvider === c.provider ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Add keys — only when the live catalog is available (PUT is
                fail-closed against it, so offering rows when the platform
                is down would just 503 on save). */}
            <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Connect a key
            </h2>
            {catalog === null ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                The platform&apos;s key catalog is unavailable right now —
                reconnect to add keys.
              </p>
            ) : catalog !== null && Object.keys(catalog).length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                The agent platform offers no key providers yet — providers
                appear when the platform exposes keyed models or tools.
              </p>
            ) : addRows.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                All supported providers have keys saved.
              </p>
            ) : (
              <ul className="space-y-2">
                {addRows.map(({ provider, meta }) => (
                  <li
                    key={provider}
                    className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{meta.label}</p>
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {meta.kind === "llm"
                            ? "Model key — the agent runs on it"
                            : "Tool key — used by the agent's tool calls"}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="password"
                        value={newSecrets[provider] ?? ""}
                        onChange={(e) =>
                          setNewSecrets((prev) => ({ ...prev, [provider]: e.target.value }))
                        }
                        placeholder={`${meta.label} API key`}
                        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                      />
                      <button
                        type="button"
                        disabled={!newSecrets[provider] || savingProvider !== null}
                        onClick={() => onSave(provider)}
                        className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingProvider === provider ? "Saving…" : "Save key"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

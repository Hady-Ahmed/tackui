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
 *  - PUT  → {provider, fields: {name: value}} — the provider's full
 *    contract, validated field-by-field against the live catalog. The
 *    semantics are position-aware: a NEW provider needs every declared
 *    field non-empty; an UPDATE keeps stored values for blank/omitted
 *    fields (that's how one field of a toolkit rotates without re-typing
 *    the rest). A wholly-blank update is rejected — Save stays disabled
 *    until at least one field is filled.
 *  - DELETE /:provider — accepts any saved provider, including ones the
 *    catalog no longer declares (a removed provider must never lock a key
 *    in; the row shows "No longer supported" and stays deletable).
 *
 * A provider's connect form renders one input per field of its contract —
 * single-key providers have one ("API key"); multi-credential toolkits (the
 * X toolkit) have several. The plaintext never leaves this page except in
 * the PUT body — GET responses carry field NAMES only. Editing works the
 * same way: the Edit button opens the contract's form in place inside
 * "Saved keys", with blank inputs meaning "keep the current value".
 *
 * A provider that already has a saved key never gets a second form in
 * "Connect a key" — its row in "Saved keys" is the one place to rotate or
 * complete it. A saved row that no longer covers the contract (the platform
 * added a field) is flagged "Incomplete" on the row itself; Edit is how the
 * missing fields get filled in.
 */

import { useCallback, useEffect, useState } from "react";
import { BackToChat } from "@/components/back-to-chat";
import { prettifyProviderLabel } from "@/lib/credentials/label";

/** One saved row from GET /api/credentials. */
interface SavedCredential {
  provider: string;
  kind: "llm" | "tool";
  hasKey: boolean;
  /** Field names saved — values are write-only. */
  fields: string[];
  updatedAt: string;
}

/** One catalog entry — the add-row source. */
interface CredentialMeta {
  kind: "llm" | "tool";
  keyName: string;
  label: string;
  /** The named fields the connect form renders. */
  fields: { key: string; label: string }[];
}

interface CredentialsResponse {
  credentials: SavedCredential[];
  catalog: Record<string, CredentialMeta> | null;
  catalogError?: string;
  error?: string;
}

/** Display label derived from a provider slug — the shared acronym-
 * correcting prettifier (lib/credentials/label.ts), same function the
 * catalog derives its labels with. */

export function CredentialsPage() {
  const [credentials, setCredentials] = useState<SavedCredential[] | null>(null);
  const [catalog, setCatalog] = useState<Record<string, CredentialMeta> | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
  const [newFields, setNewFields] = useState<Record<string, Record<string, string>>>({});
  // Editing state — one saved row at a time; its inputs live in editFields
  // (blank input = keep the stored value, mirroring the PUT update merge).
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Record<string, Record<string, string>>>({});

  const load = useCallback(async () => {
    try {
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
    } catch {
      // Own-proxy failure — without this the page strands on "Loading…".
      setError("Couldn't reach the server — try again shortly.");
    }
  }, []);

  useEffect(() => {
    const wrapper = async () => {
      await load();
      setLoading(false);
    };
    wrapper();
  }, [load]);

  const retry = () => {
    setError(null);
    setLoading(true);
    void load().finally(() => setLoading(false));
  };

  const onSave = async (provider: string, meta: CredentialMeta) => {
    const fields = newFields[provider] ?? {};
    if (!meta.fields.every((f) => (fields[f.key] ?? "").trim())) return;
    setSavingProvider(provider);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          fields: Object.fromEntries(meta.fields.map((f) => [f.key, fields[f.key].trim()])),
        }),
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
      setNotice(`${prettifyProviderLabel(provider)} key saved.`);
      setNewFields((prev) => ({ ...prev, [provider]: {} }));
      await load();
    } catch {
      setError("Couldn't reach the server — please try again.");
    } finally {
      setSavingProvider(null);
    }
  };

  const onEditStart = (provider: string) => {
    setEditingProvider(provider);
    setEditFields((prev) => ({ ...prev, [provider]: {} }));
  };

  const onEditCancel = () => {
    const provider = editingProvider;
    setEditingProvider(null);
    if (provider) setEditFields((prev) => ({ ...prev, [provider]: {} }));
  };

  const onSaveEdit = async (provider: string, meta: CredentialMeta) => {
    const values = editFields[provider] ?? {};
    // Only the filled fields go on the wire — blanks mean "keep the
    // stored value" (the route merges them over the saved row).
    const fields = Object.fromEntries(
      meta.fields
        .map((f) => [f.key, (values[f.key] ?? "").trim()])
        .filter(([, v]) => v !== ""),
    );
    if (Object.keys(fields).length === 0) return;
    setSavingProvider(provider);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, fields }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.error === "string" && data.error
            ? data.error
            : `Failed to update the ${provider} key (${res.status})`,
        );
        return;
      }
      setNotice(`${prettifyProviderLabel(provider)} key updated.`);
      setEditingProvider(null);
      setEditFields((prev) => ({ ...prev, [provider]: {} }));
      await load();
    } catch {
      setError("Couldn't reach the server — please try again.");
    } finally {
      setSavingProvider(null);
    }
  };

  const onDelete = async (provider: string) => {
    if (!confirm(`Delete your ${prettifyProviderLabel(provider)} key? Agents using it will stop until you add a new one.`)) {
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
      setNotice(`${prettifyProviderLabel(provider)} key deleted.`);
      await load();
    } catch {
      setError("Couldn't reach the server — please try again.");
    } finally {
      setDeletingProvider(null);
    }
  };

  const saved = credentials ?? [];
  // True when a saved row is missing fields the live contract now requires
  // (e.g. the platform added a field after the key was saved). Drives the
  // "Incomplete" hint on the row — completing happens via Edit, which
  // upserts the full map (blank = keep the stored value).
  const coversContract = (provider: string) => {
    const row = saved.find((c) => c.provider === provider);
    if (!row) return false;
    const meta = catalog?.[provider];
    if (!meta) return true; // not in the live catalog — nothing to complete
    return meta.fields.every((f) => row.fields.includes(f.key));
  };
  // Add rows: only providers with NO saved row. A provider that already
  // has a key never gets a second form — its row in "Saved keys" is the
  // one place to rotate or complete it (Edit), so the same provider can't
  // appear in two forms with two different "what happens on save" rules.
  const savedProviders = new Set(saved.map((c) => c.provider));
  const addRows = catalog
    ? Object.entries(catalog)
        .filter(([provider]) => !savedProviders.has(provider))
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
              delivered to the agent runner per run — never shared.
            </p>
          </div>
          <BackToChat />
        </header>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            {error}
            <button
              type="button"
              onClick={retry}
              className="ml-3 rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40"
            >
              Retry
            </button>
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
          >
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
                  const meta = known ? catalog![c.provider] : null;
                  const label = meta?.label ?? prettifyProviderLabel(c.provider);
                  const editing = editingProvider === c.provider;
                  // Same shape as the add rows: an empty contract falls
                  // back to the single api_key field.
                  const editInputs =
                    meta && meta.fields.length > 0
                      ? meta.fields
                      : [{ key: "api_key", label: "API key" }];
                  const editValues = editFields[c.provider] ?? {};
                  const editFilled = editInputs.some(
                    (f) => (editValues[f.key] ?? "").trim().length > 0,
                  );
                  // Incomplete vs the live contract: the run gate 402s runs
                  // that need this provider until the missing fields are
                  // filled in via Edit (blanks keep the stored values).
                  const incomplete =
                    known === true && meta != null && !coversContract(c.provider);
                  return (
                    <li key={c.provider} className="py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{label}</p>
                          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {c.kind === "llm" ? "Model key" : "Tool key"}
                            {c.fields.length > 1 ? ` · ${c.fields.length} fields` : ""} · saved{" "}
                            {new Date(c.updatedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {/* A provider removed from the live catalog is
                              shown but flagged — the key still works for the
                              deletion path, and the run gate handles it.
                              Edit is hidden with it (and whenever the catalog
                              is unreachable): editing renders the contract's
                              fields, which only the live catalog knows. */}
                          {known === false && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                              No longer supported
                            </span>
                          )}
                          {/* incomplete implies known === true (it's part of
                              its definition), so the two badges can't both
                              show. */}
                          {incomplete && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                              Incomplete — edit to add the missing fields
                            </span>
                          )}
                          {!editing && meta && (
                            <button
                              type="button"
                              onClick={() => onEditStart(c.provider)}
                              // One row edits at a time, and edits pause
                              // while a save/delete is in flight.
                              disabled={
                                editingProvider !== null ||
                                savingProvider !== null ||
                                deletingProvider !== null
                              }
                              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                            >
                              Edit
                            </button>
                          )}
                          {editing ? (
                            <button
                              type="button"
                              onClick={onEditCancel}
                              disabled={savingProvider !== null}
                              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                            >
                              Cancel
                            </button>
                          ) : (
                            <button
                              onClick={() => onDelete(c.provider)}
                              // Save and delete disable each other — see the
                              // add-row Save button below.
                              disabled={deletingProvider !== null || savingProvider !== null}
                              className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                            >
                              {deletingProvider === c.provider ? "Deleting…" : "Delete"}
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Inline edit form — opens inside Saved keys (the
                          add rows below stay untouched). Blank input =
                          keep the stored value. */}
                      {editing && meta && (
                        <div className="mt-2 space-y-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            Leave a field blank to keep its current value.
                          </p>
                          {editInputs.map((field) => (
                            <input
                              key={field.key}
                              type="password"
                              value={editValues[field.key] ?? ""}
                              onChange={(e) =>
                                setEditFields((prev) => ({
                                  ...prev,
                                  [c.provider]: {
                                    ...(prev[c.provider] ?? {}),
                                    [field.key]: e.target.value,
                                  },
                                }))
                              }
                              placeholder={`${label} ${field.label}`}
                              aria-label={`${label} ${field.label}`}
                              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                            />
                          ))}
                          <button
                            type="button"
                            disabled={
                              !editFilled ||
                              savingProvider !== null ||
                              deletingProvider !== null
                            }
                            onClick={() => onSaveEdit(c.provider, meta)}
                            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                          >
                            {savingProvider === c.provider
                              ? "Saving…"
                              : editInputs.length > 1
                                ? "Save credentials"
                                : "Save key"}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Add keys — only when the live catalog is available (PUT is
                fail-closed against it, so offering rows when the platform
                is down would just 503 on save). */}
            <h2 className="mt-8 mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Connect a key
            </h2>
            {/* The model/tool distinction, said ONCE here — it used to be
                repeated on every provider row, which was filler by the
                third entry. Add rows are unsaved providers only, so they
                need no per-row state text. */}
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              Model keys run the agent; tool keys power its tool calls.
            </p>
            {catalog === null ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                New keys can&apos;t be added right now — the key catalog is
                unavailable. Your saved keys are unaffected; try again shortly.
              </p>
            ) : catalog && Object.keys(catalog).length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                The agent builder offers no key providers yet — providers
                appear as the agent builder adds keyed models or tools.
              </p>
            ) : addRows.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                All supported providers have keys saved.
              </p>
            ) : (
              <ul className="space-y-2">
                {addRows.map(({ provider, meta }) => {
                  const fields =
                    meta.fields.length > 0 ? meta.fields : [{ key: "api_key", label: "API key" }];
                  const values = newFields[provider] ?? {};
                  const complete = fields.every((f) => (values[f.key] ?? "").trim().length > 0);
                  return (
                    <li
                      key={provider}
                      className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{meta.label}</p>
                          {/* Per-row text only when it carries state — the
                              static kind description ("Model key — the agent
                              runs on it") lived here once per provider and
                              moved to the one-line explainer above. */}
                        </div>
                      </div>
                      <div className="mt-2 space-y-2">
                        {fields.map((field) => (
                          <input
                            key={field.key}
                            type="password"
                            value={values[field.key] ?? ""}
                            onChange={(e) =>
                              setNewFields((prev) => ({
                                ...prev,
                                [provider]: { ...(prev[provider] ?? {}), [field.key]: e.target.value },
                              }))
                            }
                            placeholder={`${meta.label} ${field.label}`}
                            aria-label={`${meta.label} ${field.label}`}
                            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                          />
                        ))}
                        <button
                          type="button"
                          // Save and delete disable each other: both mutate
                          // the same store, and overlapping in-flight
                          // mutations (save provider X while deleting X's
                          // saved row) would race the list refresh.
                          disabled={!complete || savingProvider !== null || deletingProvider !== null}
                          onClick={() => onSave(provider, meta)}
                          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                        >
                          {savingProvider === provider
                            ? "Saving…"
                            : fields.length > 1
                              ? "Save credentials"
                              : "Save key"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

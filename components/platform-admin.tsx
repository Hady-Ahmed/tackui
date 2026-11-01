"use client";

/**
 * The Models & tools page's body — the deployment's agent catalog: which
 * model providers/models and which toolkits tackui's builder offers.
 *
 * The admin's only actions are toggling rows and typing model ids —
 * everything else (class names, credential contracts, function lists) is
 * derived from the platform's discovery scan and rendered read-only, so
 * nothing editable here can desynchronize the stack. A save
 * is a full-state replace that goes live on the next request (the platform
 * rebuilds its registry lazily) — no restart, no redeploy.
 *
 * Model grammar (one entry per model row, inside a provider's own block):
 *   model-id[:key=value ...]
 * The parser also still accepts a legacy `:tier` segment (dormant since
 * the tier system sleeps — builder runs are 100% BYOK; it wakes at
 * Phase 3 publishing) but the UI no longer advertises it.
 *
 * UX shape (the catalogs are long — 36 providers, 56 toolkits):
 *  - Provider rows are accordions: collapsed shows toggle + badges +
 *    model count; the model-id rows live inside the expanded row. Enabled
 *    providers start expanded (the working set), everything else stays
 *    collapsed. Both sections have a substring filter.
 *  - Toolkits group under free alphabetical bands derived at render time —
 *    no maintained category list anywhere (agno has none, and curated
 *    categories would mean a code change per re-organization). Function
 *    lists truncate to a few names with a native <details> expander.
 *  - An enabled provider with no model ids is blocked client-side (inline
 *    error + disabled save) AND server-side (the AgentOS PUT answers 400)
 *    — the tick-the-box-forget-the-rows state must not be saveable.
 *
 * Wire contract (app/api/admin/platform):
 *  - GET  → {providers: [...], tools: [...]} — discovery ∪ durable rows.
 *  - PUT  → {providers?, tools?} — full-state replace; the platform
 *           validates entries against its own classes and answers 400 with
 *           its message, surfaced verbatim.
 *  - POST /test-model {entry} — one "hi" completion through the platform's
 *    own env key; disabled here when the provider's platform key isn't set.
 *    That gate is the ONLY place key state surfaces in this UI: builder
 *    runs are 100% BYOK, so a row-level "key set?" display would be noise
 *    (it returns as a per-provider column when the Phase 3 tier wakes).
 *
 * Disabling a provider/toolkit does not just hide it from the picker —
 * existing agents referencing it stop running it (the operator withdrew
 * the offering). The UI says so where it matters.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, ReactNode } from "react";

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

/** The editable draft: provider slug → enabled + the model-id rows. Each
    row is one grammar entry (id[:key=value ...]) — edit, test, remove in
    place, exactly one list. */
interface ProviderDraft {
  enabled: boolean;
  models: string[];
}

/** Non-empty, trimmed model entries — what save() sends and what counts. */
function savedEntries(models: string[]): string[] {
  return models.map((m) => m.trim()).filter((m) => m.length > 0);
}

/** Serialize a saved model row back to its grammar entry (row prefill). */
function modelEntryText(row: { id: string; attrs: Record<string, unknown>; tier: boolean }): string {
  const parts = [row.id];
  if (row.tier) parts.push("tier");
  for (const [key, value] of Object.entries(row.attrs)) {
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(":");
}

/** Page-level failure: the route's user-safe message plus, when the
    upstream platform sent validation text, that detail as a secondary
    line (admin-only surface — operators need the platform's "why"). */
interface PageError {
  message: string;
  detail?: string;
}

/** Build the PageError from a proxy response body, falling back when the
    body isn't the expected shape (proxy down, non-JSON). */
function pageErrorFrom(
  data: { error?: unknown; detail?: unknown },
  fallback: string,
): PageError {
  return {
    message:
      typeof data.error === "string" && data.error ? data.error : fallback,
    detail:
      typeof data.detail === "string" && data.detail ? data.detail : undefined,
  };
}

/** Small status pill shared by both sections. */
function Pill({
  tone,
  children,
}: {
  tone: "green" | "amber" | "gray";
  children: ReactNode;
}) {
  const cls =
    tone === "green"
      ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
      : tone === "amber"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400";
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

export function PlatformAdmin() {
  const [providers, setProviders] = useState<CatalogProvider[] | null>(null);
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  const [draft, setDraft] = useState<Record<string, ProviderDraft>>({});
  const [toolDraft, setToolDraft] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [provFilter, setProvFilter] = useState("");
  const [toolFilter, setToolFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<PageError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Soft notes the platform attached to a successful save (skipped rows,
  // normalized entries). Unlike the green notice these do NOT auto-dismiss —
  // a warning the admin never saw is the exact failure mode this surface
  // exists to prevent. Cleared by the ✕ button or the next save.
  const [saveWarnings, setSaveWarnings] = useState<string[] | null>(null);
  // model entry (provider:id[:attrs]) currently being tested → result copy.
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  // Per-entry dismissal timers — a test result disappears after a few
  // seconds; re-testing resets the clock instead of stacking timers.
  const testTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // The saved-catalog notice dismisses on the same clock as test results —
  // a success banner that lingers forever is just noise.
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleNoticeDismiss = () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 8000);
  };

  useEffect(() => {
    // Copy the refs' current objects — they're mutated in place, so the
    // identity is stable, but the lint rule wants a local binding.
    const timers = testTimers.current;
    const notice = noticeTimer;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
      if (notice.current) clearTimeout(notice.current);
    };
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    setError(null);
    let res: Response;
    try {
      res = await fetch("/api/admin/platform/catalog");
    } catch {
      // Own-proxy failure (server restart, DNS) — same copy as the 5xx path.
      setError({ message: "Couldn't load models & tools — please retry shortly." });
      setLoading(false);
      return false;
    }
    const data = (await res.json().catch(() => ({}))) as CatalogResponse;
    if (!res.ok) {
      setError(pageErrorFrom(data, "Couldn't load models & tools — please retry shortly."));
      setLoading(false);
      return false;
    }
    setProviders(data.providers ?? []);
    setTools(data.tools ?? []);
    const d: Record<string, ProviderDraft> = {};
    for (const p of data.providers ?? []) {
      d[p.slug] = {
        enabled: p.enabled,
        models: p.models.map(modelEntryText),
      };
    }
    setDraft(d);
    // Expansion survives a reload (post-save refresh included): keep the
    // rows the admin opened; only first-load rows default to the enabled
    // working set.
    setExpanded((prev) => {
      const next: Record<string, boolean> = {};
      for (const p of data.providers ?? []) {
        next[p.slug] = prev[p.slug] ?? (p.enabled && p.available);
      }
      return next;
    });
    const t: Record<string, boolean> = {};
    for (const tool of data.tools ?? []) t[tool.slug] = tool.enabled;
    setToolDraft(t);
    setLoading(false);
    return true;
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
    setSaveWarnings(null);
    try {
      const res = await fetch("/api/admin/platform/catalog", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: providers.map((p) => ({
            slug: p.slug,
            enabled: draft[p.slug]?.enabled ?? false,
            models: savedEntries(draft[p.slug]?.models ?? []),
          })),
          tools: tools.map((t) => ({
            slug: t.slug,
            enabled: toolDraft[t.slug] ?? false,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(pageErrorFrom(data, "Couldn't save the catalog — please retry shortly."));
        setSaving(false);
        return;
      }
      // The platform's soft notes — only surface them when non-empty (the
      // proxy omits the field entirely when there are none).
      const warnings = Array.isArray(data.warnings)
        ? (data.warnings as unknown[]).filter(
            (w): w is string => typeof w === "string" && w.length > 0,
          )
        : [];
      if (warnings.length > 0) setSaveWarnings(warnings);
      setNotice("Catalog saved.");
      scheduleNoticeDismiss();
    } catch {
      // Own-proxy failure mid-PUT — the draft is intact, the user can retry.
      setError({ message: "Couldn't save the catalog — please retry shortly." });
      setSaving(false);
      return;
    }
    // The save itself succeeded; only the post-save refresh can fail here
    // (load() sets its own error banner on failure). `saving` stays true
    // through the refresh: the refresh replaces the whole draft, so any
    // keystroke landing mid-flight would be silently reverted — the
    // inputs are disabled until the refreshed state lands.
    if (!(await load())) {
      setError({
        message: "Saved — but the page couldn't refresh. Reload to see the current state.",
      });
    }
    setSaving(false);
  };

  const testModel = async (provider: CatalogProvider, entry: string) => {
    const key = `${provider.slug}:${entry}`;
    setTesting(key);
    // No setError(null) here: the test result is row-scoped and must not
    // wipe an unrelated page error (e.g. the load banner) mid-flight.
    let result: string;
    try {
      const res = await fetch("/api/admin/platform/test-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry: `${provider.slug}:${entry}` }),
      });
      const data = await res.json().catch(() => ({}));
      result =
        res.ok && data.ok
          ? `✓ ${typeof data.reply === "string" ? data.reply.slice(0, 80) : "ok"}`
          : `✗ ${
              // Prefer the platform's own validation detail (admin-only
              // surface — this is the one place the "why" belongs).
              typeof data.detail === "string" && data.detail
                ? data.detail
                : typeof data.error === "string" && data.error
                  ? data.error
                  : "Test failed — please retry shortly."
            }`;
    } catch {
      // Own-proxy failure — without this the row would sit silent forever.
      result = "✗ Couldn't reach the server — try again shortly.";
    }
    setTestResults((prev) => ({ ...prev, [key]: result }));
    // Auto-dismiss: reset this entry's clock (a re-test replaces the
    // old timer rather than stacking a second one). The delete is
    // guarded — the entry may already be gone via a row edit.
    clearTimeout(testTimers.current[key]);
    testTimers.current[key] = setTimeout(() => {
      delete testTimers.current[key];
      setTestResults((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, 8000);
    setTesting(null);
  };

  // Draft model-row editing — the row list IS the editor (no textarea
  // mirror): edit, test, remove per row; a multi-line paste splits into
  // rows so bulk-pasting a list still works.
  const updateModels = (slug: string, fn: (models: string[]) => string[]) =>
    setDraft((prev) => {
      const cur = prev[slug] ?? { enabled: false, models: [] };
      return { ...prev, [slug]: { ...cur, models: fn(cur.models) } };
    });

  const setModelRow = (slug: string, i: number, value: string, previous: string) => {
    updateModels(slug, (m) => m.map((v, j) => (j === i ? value : v)));
    // Editing a row invalidates its test result — a stale ✓/✗ beside a
    // different id would lie.
    const oldKey = `${slug}:${previous.trim()}`;
    clearTimeout(testTimers.current[oldKey]);
    delete testTimers.current[oldKey];
    if (testResults[oldKey]) {
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[oldKey];
        return next;
      });
    }
  };

  const pasteIntoRow = (e: ReactClipboardEvent<HTMLInputElement>, slug: string, i: number) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n")) return; // single value — default paste
    e.preventDefault();
    const parts = text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Whitespace-only paste (a lone newline): nothing to splice in — fall
    // through to the default single-value paste instead of deleting the
    // row (an empty `parts` splices it out entirely).
    if (parts.length === 0) return;
    // Replacing a row invalidates its test timer/result exactly like
    // setModelRow does — a lingering timer would fire against a row that
    // no longer contains the tested id.
    const replaced = (draft[slug]?.models ?? [])[i]?.trim();
    if (replaced) {
      const oldKey = `${slug}:${replaced}`;
      clearTimeout(testTimers.current[oldKey]);
      delete testTimers.current[oldKey];
      if (testResults[oldKey]) {
        setTestResults((prev) => {
          const next = { ...prev };
          delete next[oldKey];
          return next;
        });
      }
    }
    updateModels(slug, (m) => [...m.slice(0, i), ...parts, ...m.slice(i + 1)]);
  };

  const providerList = providers ?? [];
  const toolList = tools ?? [];

  // Enabled-but-empty providers: invalid, and save is blocked while any
  // exist. The row itself shows the inline error; this count drives the
  // save bar.
  const invalidProviders = providerList.filter((p) => {
    const d = draft[p.slug];
    return (d?.enabled ?? false) && p.available && savedEntries(d?.models ?? []).length === 0;
  });
  const invalidSlugs = new Set(invalidProviders.map((p) => p.slug));

  const dirtyCount =
    providerList.filter(
      (p) =>
        (draft[p.slug]?.enabled ?? false) !== p.enabled ||
        JSON.stringify(savedEntries(draft[p.slug]?.models ?? [])) !==
          JSON.stringify(p.models.map(modelEntryText)),
    ).length +
    toolList.filter((t) => (toolDraft[t.slug] ?? false) !== t.enabled).length;

  const enabledProviderCount = providerList.filter((p) => draft[p.slug]?.enabled).length;
  const enabledToolCount = toolList.filter((t) => toolDraft[t.slug]).length;

  // Unsaved-changes guard: a dirty draft must not die silently on tab
  // close/refresh. (In-app nav isn't intercepted — the save bar keeps the
  // state visible instead of nagging on every click.)
  useEffect(() => {
    if (dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyCount]);

  if (loading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  const q = provFilter.trim().toLowerCase();
  const visibleProviders = q
    ? providerList.filter(
        (p) => p.slug.toLowerCase().includes(q) || (p.class_name ?? "").toLowerCase().includes(q),
      )
    : providerList;

  const tq = toolFilter.trim().toLowerCase();
  const visibleTools = tq
    ? toolList.filter(
        (t) =>
          t.label.toLowerCase().includes(tq) ||
          t.slug.toLowerCase().includes(tq) ||
          (t.class_name ?? "").toLowerCase().includes(tq) ||
          t.functions.some((f) => f.toLowerCase().includes(tq)),
      )
    : toolList;

  // Free alphabetical bands from the visible set — derived at render time,
  // nothing maintained. A filter that empties a band just drops the band.
  // Sorted: the API orders rows by slug, but bands key off the label.
  const toolBands = new Map<string, CatalogTool[]>();
  for (const t of visibleTools) {
    const band = (t.label || t.slug).charAt(0).toUpperCase();
    const bucket = toolBands.get(band);
    if (bucket) bucket.push(t);
    else toolBands.set(band, [t]);
  }
  const bandEntries = [...toolBands.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p>{error.message}</p>
          {error.detail && (
            <p className="mt-1 break-words text-xs text-red-600 dark:text-red-400">
              {error.detail}
            </p>
          )}
          {providers === null && (
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
              className="mt-2 rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
            >
              Retry
            </button>
          )}
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
      {saveWarnings && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium">
              Saved with {saveWarnings.length === 1 ? "1 note" : `${saveWarnings.length} notes`}
              :
            </p>
            <button
              type="button"
              aria-label="Dismiss the save notes"
              onClick={() => setSaveWarnings(null)}
              className="shrink-0 text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
            >
              ✕
            </button>
          </div>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {saveWarnings.map((w, i) => (
              <li key={i} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Model providers — the sections count PROVIDERS/toolkits (the rows
          the admin toggles), not the models/functions inside them. */}
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Model providers{" "}
            <span className="font-normal normal-case tracking-normal text-zinc-400">
              · {enabledProviderCount} of {providerList.length} enabled
            </span>
          </h2>
          <input
            type="search"
            value={provFilter}
            onChange={(e) => setProvFilter(e.target.value)}
            placeholder="Filter providers…"
            className="w-48 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
        {/* Two-column flow at md+; expanded/invalid rows span the full row
            so the row list + test result keep their roomy width. */}
        <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 md:grid-cols-2">
          {visibleProviders.map((p) => {
            const d = draft[p.slug] ?? { enabled: p.enabled, models: [] };
            const open = expanded[p.slug] ?? false;
            const modelCount = savedEntries(d.models).length;
            const invalid = invalidSlugs.has(p.slug);
            const wide = (open && p.available) || invalid;
            return (
              <div
                key={p.slug}
                className={`min-w-0 rounded-xl border bg-white dark:bg-zinc-950 ${
                  wide ? "md:col-span-full " : ""
                }${
                  invalid
                    ? "border-red-300 dark:border-red-900"
                    : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                {/* Collapsed header — the whole row toggles expansion
                    except the controls themselves. */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  // aria-controls points at the panel element, which only
                  // exists when open && available — emit the reference just
                  // then so it never dangles.
                  {...(open && p.available
                    ? { "aria-controls": `provider-panel-${p.slug}` }
                    : {})}
                  onClick={() => setExpanded((prev) => ({ ...prev, [p.slug]: !open }))}
                  onKeyDown={(e) => {
                    // Only the header itself toggles — a keydown from the
                    // nested checkbox (Space on a focused checkbox bubbles
                    // here) must not also toggle the accordion, or keyboard
                    // users can't check the box without collapsing the row.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpanded((prev) => ({ ...prev, [p.slug]: !open }));
                    }
                  }}
                  className="flex cursor-pointer select-none items-center gap-3 p-3"
                >
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    // An unavailable provider can't be ENABLED (the
                    // platform can't produce it), but one that is still
                    // enabled must stay untickable — the backend's
                    // dead-row clear path (an agno upgrade dropped it)
                    // only fires when the save says enabled:false.
                    // Disabling the checkbox outright would trap an
                    // enabled dead row in a permanent 400 loop.
                    disabled={saving || (!p.available && !d.enabled)}
                    aria-label={`Enable ${p.slug}`}
                    title={
                      !p.available
                        ? d.enabled
                          ? `No longer available — untick to clear this row`
                          : `No longer available`
                        : undefined
                    }
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      // Enabling expands the row (the editor is the
                      // next required action); disabling collapses it.
                      // Outside the setDraft updater — updaters must be
                      // pure (React may invoke them twice).
                      setExpanded((x) => ({ ...x, [p.slug]: enabled && p.available }));
                      setDraft((prev) => ({ ...prev, [p.slug]: { ...d, enabled } }));
                    }}
                    className="h-4 w-4 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
                  />
                  <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-50">
                    {p.slug}
                  </span>
                  {!p.available && <Pill tone="amber">No longer available</Pill>}
                  {open ? (
                    <code className="min-w-0 flex-1 truncate text-xs text-zinc-400">{p.class_name}</code>
                  ) : (
                    d.enabled &&
                    p.available && (
                      <Pill tone={modelCount > 0 ? "gray" : "amber"}>
                        {modelCount} {modelCount === 1 ? "model" : "models"}
                      </Pill>
                    )
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-2.5">
                    <span
                      className={`shrink-0 pr-0.5 text-xs text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
                      aria-hidden
                    >
                      ▸
                    </span>
                  </span>
                </div>
                {open && p.available && (
                  <div id={`provider-panel-${p.slug}`} className="px-3 pb-3">
                    {/* The row list IS the editor — no textarea mirror:
                        each id is its own input with Test/remove inline,
                        and a multi-line paste splits into rows. Test
                        composes `slug:trimmed-row` and persists nothing;
                        buttons sit disabled with a tooltip when the
                        platform key is missing — the one place key state
                        surfaces in this UI. */}
                    <div className="space-y-1.5">
                      {d.models.map((line, i) => {
                        const resultKey = `${p.slug}:${line.trim()}`;
                        return (
                          <div key={i} className="flex items-center gap-2">
                            <input
                              value={line}
                              onChange={(e) => setModelRow(p.slug, i, e.target.value, line)}
                              onPaste={(e) => pasteIntoRow(e, p.slug, i)}
                              disabled={saving}
                              placeholder="model-id"
                              aria-label={`Model id ${i + 1} for ${p.slug}`}
                              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                            />
                            <button
                              type="button"
                              aria-label={`Test model id ${line.trim()} on ${p.slug}`}
                              disabled={
                                saving || !p.env_key_set || testing !== null || !line.trim()
                              }
                              title={
                                p.env_key_set
                                  ? !line.trim()
                                    ? "Enter a model id first"
                                    : undefined
                                  : `Set ${p.platform_env_key} on the platform to test this model`
                              }
                              onClick={() => testModel(p, line.trim())}
                              className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-[10px] text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                            >
                              {testing === resultKey ? "Testing…" : "Test"}
                            </button>
                            {testResults[resultKey] && (
                              <span
                                title={testResults[resultKey]}
                                className={`max-w-64 shrink truncate ${
                                  testResults[resultKey].startsWith("✓")
                                    ? "text-green-600 dark:text-green-400"
                                    : "text-red-600 dark:text-red-400"
                                }`}
                              >
                                {testResults[resultKey]}
                              </span>
                            )}
                            <button
                              type="button"
                              disabled={saving}
                              title="Remove this model id"
                              aria-label={`Remove model id ${i + 1} from ${p.slug}`}
                              onClick={() =>
                                updateModels(p.slug, (m) => m.filter((_, j) => j !== i))
                              }
                              className="shrink-0 rounded px-1 text-sm text-zinc-400 transition-colors hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => updateModels(p.slug, (m) => [...m, ""])}
                      className="mt-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      + Add model id
                    </button>
                    {/* Grammar hint — attributes ride on the id after a
                        colon; "one per line" is meaningless in a list. */}
                    <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                      attributes as <code>key=value</code> after a colon, e.g.{" "}
                      <code>model-id:max_tokens=8192</code>
                    </p>
                    {invalid && (
                      <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">
                        Add at least one model id — an enabled provider with no models
                        shows nothing in the picker.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {providers !== null && visibleProviders.length === 0 && (
            <p className="py-4 text-center text-xs text-zinc-400 md:col-span-2">
              No providers match “{provFilter}”.
            </p>
          )}
        </div>
      </section>

      {/* Toolkits — alphabetical bands derived at render time; a maintained
          category list would mean a code change per re-organization. */}
      <section className="mt-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Toolkits{" "}
            <span className="font-normal normal-case tracking-normal text-zinc-400">
              · {enabledToolCount} of {toolList.length} enabled
            </span>
          </h2>
          <input
            type="search"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            placeholder="Filter toolkits…"
            className="w-48 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
        <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 md:grid-cols-2">
          {/* Cards are the grid children; band headers span the full row
              and their group's cards flow two-per-row beneath them. */}
          {bandEntries.flatMap(([band, group]) => [
            <p
              key={`band-${band}`}
              className="col-span-full mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 first:mt-0 dark:text-zinc-500"
            >
              {band}
            </p>,
            ...group.map((t) => (
              <ToolRow
                key={t.slug}
                tool={t}
                checked={toolDraft[t.slug] ?? false}
                saving={saving}
                onChange={(checked) => setToolDraft((prev) => ({ ...prev, [t.slug]: checked }))}
              />
            )),
          ])}
          {tools !== null && visibleTools.length === 0 && (
            <p className="py-4 text-center text-xs text-zinc-400 md:col-span-2">
              No toolkits match “{toolFilter}”.
            </p>
          )}
        </div>
      </section>

      {/* Save — a full-state replace; the platform rebuilds on the next
          request, so changes go live without restart. Blocked while any
          enabled provider has no model ids (the AgentOS would 400 anyway). */}
      <div className="sticky bottom-4 mt-6 flex items-center justify-end gap-3 rounded-xl border border-zinc-200 bg-white/90 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        {invalidProviders.length > 0 && (
          <span className="mr-auto text-xs font-medium text-red-600 dark:text-red-400">
            {invalidProviders.length} enabled {invalidProviders.length === 1 ? "provider needs" : "providers need"} model ids
          </span>
        )}
        {invalidProviders.length === 0 && dirtyCount > 0 && (
          <span className="mr-auto text-xs text-zinc-500 dark:text-zinc-400">
            {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          // Disabled when there's nothing to save, or when an enabled
          // provider still has no model ids (the file header documents
          // this as client-side blocking — a save here would PUT the
          // invalid row anyway, and the platform's 400 would reject the
          // whole full-state batch, discarding every other valid change).
          // The inline error on the row says what to repair; the tooltip
          // names it on hover. Dead-row clearing is unaffected (unavailable
          // rows are not "invalid").
          disabled={
            saving ||
            providers === null ||
            invalidProviders.length > 0 ||
            (invalidProviders.length === 0 && dirtyCount === 0)
          }
          title={
            invalidProviders.length > 0
              ? "Add at least one model id to every enabled provider first"
              : undefined
          }
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : dirtyCount > 0 ? `Save ${dirtyCount} ${dirtyCount === 1 ? "change" : "changes"}` : "Save"}
        </button>
      </div>
    </div>
  );
}

/** One compact toolkit row — toggle + label + credential chips, with the
    function dump and class name tucked into a native <details>. */
function ToolRow({
  tool,
  checked,
  saving,
  onChange,
}: {
  tool: CatalogTool;
  checked: boolean;
  saving: boolean;
  onChange: (checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = tool.functions.slice(0, 3);
  const rest = tool.functions.length - shown.length;
  return (
    <div
      className={`min-w-0 rounded-xl border bg-white p-3 dark:bg-zinc-950 ${
        checked
          ? "border-blue-200 dark:border-blue-900"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={checked}
          // Same as the provider checkbox: an unavailable/undeliverable
          // toolkit can't be ENABLED, but one that is still enabled must
          // stay untickable — the backend's dead-row clear path only
          // fires when the save says enabled:false.
          disabled={saving || (!checked && (!tool.available || !tool.deliverable))}
          title={
            !tool.available
              ? checked
                ? "No longer available — untick to clear this row"
                : "No longer available"
              : !tool.deliverable
                ? checked
                  ? "Can't deliver credentials — untick to clear this row"
                  : undefined
                : undefined
          }
          aria-label={`Enable ${tool.label || tool.slug}`}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 shrink-0 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
        />
        <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-50">
          {tool.label}
        </span>
        {!tool.available && <Pill tone="amber">No longer available</Pill>}
        {tool.available && !tool.deliverable && (
          <Pill tone="amber">
            <span
              title="This toolkit declares credentials the platform can&apos;t deliver at run time, so it can&apos;t be enabled."
            >
              Can&apos;t deliver credentials
            </span>
          </Pill>
        )}
        {tool.credentials.length > 0 && (
          <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
            {tool.credentials.map((c) => (
              <code
                key={c.dep_key}
                title={`${c.dep_key}${c.env ? ` (env ${c.env})` : ""}`}
                className="truncate rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
              >
                {c.arg}
              </code>
            ))}
          </span>
        )}
      </div>
      {/* Function list — the bulk of the old card. Truncate to the first
          few; the native <details> holds the rest + the class name. */}
      <details
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
        className="mt-1 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <summary className="flex min-w-0 cursor-pointer list-none items-baseline gap-1 marker:hidden">
          {tool.functions.length > 0 ? (
            <>
              <span className="min-w-0 truncate">{shown.join(", ")}</span>
              {rest > 0 && (
                <span className="shrink-0 whitespace-nowrap text-[11px] text-blue-600 hover:underline dark:text-blue-400">
                  {" "}
                  +{rest} more
                </span>
              )}
            </>
          ) : (
            <span>No functions discovered.</span>
          )}
        </summary>
        <p className="mt-1 break-words">{tool.functions.join(", ") || "—"}</p>
        {tool.class_name && (
          <p className="mt-0.5">
            <code className="text-[10px]">{tool.class_name}</code>
          </p>
        )}
      </details>
      {checked && (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          Disabling this toolkit stops agents that use it.
        </p>
      )}
    </div>
  );
}

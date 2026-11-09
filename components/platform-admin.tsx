"use client";

/**
 * The Models & tools page's body — the deployment's agent catalog: which
 * model providers/models and which toolkits tackui's builder offers.
 *
 * The admin's only actions are typing model ids (a provider's enablement
 * follows its id list) and toggling toolkits — everything else (class
 * names, credential contracts, function lists) is derived from the
 * platform's discovery scan and rendered read-only, so nothing editable
 * here can desynchronize the stack. A save
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
 *  - Provider rows are accordions: the header carries a derived status
 *    dot + count label (● n models / ○ off — the glyph shape and the
 *    label text carry the state, not just color) and the model-id rows
 *    live inside the expanded row. Enabled available providers start expanded
 *    (the working set), everything else stays collapsed. Both sections
 *    have a substring filter.
 *  - A provider's enabled state is DERIVED, not stored: it is on exactly
 *    when it lists ≥1 model id (components/platform-admin-catalog.ts).
 *    Adding the first id lights it, removing the last dims it, and a
 *    Clear all button (shown only when ids exist; no confirmation —
 *    nothing persists until Save, so not-saving is the undo) empties the
 *    list in one go. The two old save-time guards — "enabled with no ids"
 *    (blocked) and "ids under a disabled provider" (silently dropped) —
 *    forbade the same diagonal, proving the checkbox and the id list were
 *    one fact; the UI now encodes it, so both error states are
 *    unconstructible here, and the PUT body derives enabled from the rows.
 *    The AgentOS keeps its own guards as defense-in-depth.
 *  - Toolkits group under free alphabetical bands derived at render time —
 *    no maintained category list anywhere (agno has none, and curated
 *    categories would mean a code change per re-organization). Function
 *    lists truncate to a few names with a native <details> expander when
 *    there are more; short lists render as plain text (no dead expander,
 *    no class-name chip — it would just duplicate the toolkit's title).
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
import {
  deriveProviderEnabled,
  modelEntryText,
  providerPutEntry,
  providerStatus,
  savedEntries,
} from "./platform-admin-catalog";

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

/** The editable draft: provider slug → the model-id rows. Each row is one
    grammar entry (id[:key=value ...]) — edit, test, remove in place,
    exactly one list. There is NO `enabled` field: enablement is derived
    from the rows (components/platform-admin-catalog.ts), so the states
    both save-time guards used to forbid are unrepresentable in the
    draft, let alone sendable. */
interface ProviderDraft {
  models: string[];
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
          // Each provider entry derives `enabled` from its rows
          // (providerPutEntry) — the body physically cannot carry the
          // states the AgentOS's guards reject: an enabled provider with
          // no ids, or ids under a disabled one.
          providers: providers.map((p) =>
            providerPutEntry(p.slug, draft[p.slug]?.models ?? []),
          ),
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
      const cur = prev[slug] ?? { models: [] };
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

  // Dirty detection compares the DERIVED draft enablement (a provider is
  // on exactly when its rows list ≥1 id) against the saved catalog.
  const dirtyCount =
    providerList.filter(
      (p) =>
        deriveProviderEnabled(draft[p.slug]?.models ?? []) !== p.enabled ||
        JSON.stringify(savedEntries(draft[p.slug]?.models ?? [])) !==
          JSON.stringify(p.models.map(modelEntryText)),
    ).length +
    toolList.filter((t) => (toolDraft[t.slug] ?? false) !== t.enabled).length;

  const enabledProviderCount = providerList.filter((p) =>
    deriveProviderEnabled(draft[p.slug]?.models ?? []),
  ).length;
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
  // Bands (and the order within each) key off the DISPLAYED title, so the
  // visible grouping always matches the visible names — the API orders by
  // slug, which diverges from the class-name titles.
  const toolBands = new Map<string, CatalogTool[]>();
  for (const t of visibleTools) {
    const band = toolTitle(t).charAt(0).toUpperCase();
    const bucket = toolBands.get(band);
    if (bucket) bucket.push(t);
    else toolBands.set(band, [t]);
  }
  const bandEntries = [...toolBands.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([band, tools]) => [
      band,
      [...tools].sort((a, b) => toolTitle(a).localeCompare(toolTitle(b))),
    ] as const);

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
        {/* Two-column flow at md+; expanded rows span the full row so the
            row list + test result keep their roomy width. */}
        <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 md:grid-cols-2">
          {visibleProviders.map((p) => {
            const d = draft[p.slug] ?? { models: [] };
            const open = expanded[p.slug] ?? false;
            // The header's status indicator — derived from the id rows,
            // never stored (see platform-admin-catalog.ts).
            const status = providerStatus(d.models);
            return (
              <div
                key={p.slug}
                className={`min-w-0 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${
                  open ? "md:col-span-full" : ""
                }`}
              >
                {/* Collapsed header — the whole row toggles expansion
                    except the status indicator (not a control; see
                    onClick below). */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  // aria-controls points at the panel element, which only
                  // exists when open — emit the reference just then so it
                  // never dangles.
                  {...(open ? { "aria-controls": `provider-panel-${p.slug}` } : {})}
                  onClick={(e) => {
                    // The status dot is not a control — a click inside it
                    // must not toggle the row; the row itself (its name,
                    // badges, empty space) is the expand/collapse target.
                    if ((e.target as HTMLElement).closest("[data-provider-status]")) return;
                    setExpanded((prev) => ({ ...prev, [p.slug]: !open }));
                  }}
                  onKeyDown={(e) => {
                    // Only the header itself toggles — a keydown from a
                    // nested interactive child (Space on a focused control
                    // bubbles here) must not also toggle the accordion.
                    // No such child exists today (the status dot is inert),
                    // but the guard costs nothing and keeps a future one
                    // from double-firing.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpanded((prev) => ({ ...prev, [p.slug]: !open }));
                    }
                  }}
                  className="flex cursor-pointer select-none items-center gap-3 p-3"
                >
                  {/* Derived status — NOT an input. A provider is enabled
                      exactly when it lists ≥1 model id: the dot fills and
                      counts when ids exist and goes hollow/off when none
                      do. The state rides the glyph shape and the label
                      text, not just color. Data attribute lets the row's
                      click handler ignore clicks here. */}
                  <span
                    data-provider-status
                    title="A provider is enabled while it lists at least one model id"
                    className="flex shrink-0 cursor-default items-center gap-1.5 text-xs font-medium"
                  >
                    <span
                      aria-hidden
                      className={
                        status.enabled
                          ? "text-green-600 dark:text-green-400"
                          : "text-zinc-400 dark:text-zinc-500"
                      }
                    >
                      {status.glyph}
                    </span>
                    <span
                      className={
                        status.enabled
                          ? "text-green-700 dark:text-green-300"
                          : "text-zinc-400 dark:text-zinc-500"
                      }
                    >
                      {status.label}
                    </span>
                  </span>
                  <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-50">
                    {/* The agno class name IS the honest display name
                        ("AzureOpenAI", not "azure" — which reads like all
                        of Azure when it's OpenAI-on-Azure only). Slug
                        fallback for any provider without a class. */}
                    {p.class_name ?? p.slug}
                  </span>
                  {!p.available && (
                    <Pill tone="amber">
                      <span
                        title={
                          status.enabled
                            ? "No longer available — clear its model ids to remove this row on save"
                            : "No longer available"
                        }
                      >
                        No longer available
                      </span>
                    </Pill>
                  )}
                  {/* The status label above IS the model-count display —
                      collapsed and expanded alike; no separate count pill.
                      The slug lives in the editor panel below where it's
                      actually referenced (result keys, error copy). */}
                  <span className="ml-auto flex shrink-0 items-center gap-2.5">
                    <span
                      className={`shrink-0 pr-0.5 text-xs text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
                      aria-hidden
                    >
                      ▸
                    </span>
                  </span>
                </div>
                {open && (
                  <div id={`provider-panel-${p.slug}`} className="px-3 pb-3">
                    {/* The row list IS the editor — no textarea mirror:
                        each id is its own input with Test/remove inline,
                        and a multi-line paste splits into rows. Test
                        composes `slug:trimmed-row` and persists nothing;
                        buttons sit disabled with a tooltip when the
                        platform key is missing — the one place key state
                        surfaces in this UI. The slug is NOT displayed
                        here: error copy names slugs, but the provider
                        filter matches them too — type it there to find
                        the row. Unavailable (dead) rows render read-only:
                        the platform can't serve them, so their ids can
                        only be cleared — which is exactly what this panel
                        now exists to offer them (the old checkbox's
                        untick-to-clear path). */}
                    <div className="space-y-1.5">
                      {d.models.map((line, i) => {
                        const resultKey = `${p.slug}:${line.trim()}`;
                        return (
                          <div key={i} className="flex items-center gap-2">
                            <input
                              value={line}
                              onChange={(e) => setModelRow(p.slug, i, e.target.value, line)}
                              onPaste={(e) => pasteIntoRow(e, p.slug, i)}
                              disabled={saving || !p.available}
                              placeholder="model-id"
                              aria-label={`Model id ${i + 1} for ${p.class_name ?? p.slug}`}
                              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 outline-none transition-colors focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                            />
                            <button
                              type="button"
                              aria-label={`Test model id ${line.trim()} on ${p.class_name ?? p.slug}`}
                              disabled={
                                saving ||
                                !p.available ||
                                !p.env_key_set ||
                                testing !== null ||
                                !line.trim()
                              }
                              title={
                                !p.available
                                  ? "No longer available"
                                  : p.env_key_set
                                    ? !line.trim()
                                      ? "Enter a model id first"
                                      : undefined
                                    : `Set ${p.platform_env_key} in the agent builder service's environment to test this model`
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
                    {/* Adding ids to an unavailable provider can only
                        produce a save the platform rejects (it can't serve
                        the offering) — dead rows get no Add affordance;
                        their panel is for clearing. */}
                    {p.available && (
                      <>
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
                      </>
                    )}
                    {/* Clear all — shown only when there's something to
                        clear (no dead affordance on an empty list). No
                        confirmation: nothing persists until Save, so
                        not-saving is the undo. The row list IS the draft —
                        one array holds the saved ids and any in-progress
                        blanks — so this empties both in one go, and the
                        derived state follows on its own: an emptied
                        provider saves disabled (for a dead row, that's the
                        row-clear path the old checkbox provided). */}
                    {status.enabled && (
                      <button
                        type="button"
                        disabled={saving}
                        title="Removes every model id — nothing is saved until you Save"
                        onClick={() => updateModels(p.slug, () => [])}
                        className="mt-2 text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                      >
                        Clear all
                      </button>
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
          request, so changes go live without restart. There is no
          validity gate here anymore: the draft derives enablement from
          the id rows, so the states the AgentOS would 400 (enabled with
          no ids, ids under a disabled provider) can't be built in this
          UI — the only thing that can block a save is having nothing to
          save. */}
      <div className="sticky bottom-4 mt-6 flex items-center justify-end gap-3 rounded-xl border border-zinc-200 bg-white/90 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        {dirtyCount > 0 && (
          <span className="mr-auto text-xs text-zinc-500 dark:text-zinc-400">
            {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          // Disabled only when there's nothing to save — the draft can't
          // hold an invalid provider state anymore (see the header).
          disabled={saving || providers === null || dirtyCount === 0}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : dirtyCount > 0 ? `Save ${dirtyCount} ${dirtyCount === 1 ? "change" : "changes"}` : "Save"}
        </button>
      </div>
    </div>
  );
}

/** The displayed toolkit name — the agno class name ("CsvTools"), falling
 *  back to the label, then the slug. One name everywhere: the row title,
 *  the aria-label, and the alphabetical bands all key off this. */
function toolTitle(tool: CatalogTool): string {
  return (tool.class_name ?? tool.label) || tool.slug;
}

/** One compact toolkit row — toggle + label + credential chips, with the
    function list expanding to the full untruncated list only when there
    are more names than the preview shows ("Show less" sits below the
    revealed list). */
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
  // Focus handoff refs: hiding the summary on open (or the "Show less"
  // button on close) would otherwise drop keyboard focus to <body>.
  const summaryRef = useRef<HTMLElement>(null);
  const showLessRef = useRef<HTMLButtonElement>(null);
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
          // A toolkit is a genuine independent choice (unlike a provider,
          // whose enablement follows its model-id rows): an
          // unavailable/undeliverable toolkit can't be ENABLED, but one
          // that is still enabled must stay untickable — the backend's
          // dead-row clear path only fires when the save says
          // enabled:false.
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
          aria-label={`Enable ${toolTitle(tool)}`}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 shrink-0 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
        />
        <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-50">
          {toolTitle(tool)}
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
      {/* Function list — the bulk of the old card. Non-interactive whenever
          the list already fits the preview (a clickable expander that only
          re-shows the same names read as a bug). When it expands, the
          summary (which must stay first to remain the native toggle)
          hides, the FULL list renders untruncated, and a "Show less"
          button BELOW the list becomes the collapse affordance — reading
          like the end of the reveal, not a header above it. No class name
          is rendered here: it duplicates the toolkit's title. */}
      {tool.functions.length === 0 ? (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          No functions discovered.
        </p>
      ) : rest > 0 ? (
        <details
          open={open}
          onToggle={(e) => {
            const nowOpen = (e.target as HTMLDetailsElement).open;
            setOpen(nowOpen);
            // Keep the keyboard path continuous: the element the user
            // was on (summary when opening, "Show less" when closing)
            // is about to be display:none — move focus to its successor
            // before it vanishes.
            requestAnimationFrame(() =>
              nowOpen ? showLessRef.current?.focus() : summaryRef.current?.focus(),
            );
          }}
          className="group mt-1 text-xs text-zinc-500 dark:text-zinc-400"
        >
          <summary
            ref={summaryRef}
            className="flex min-w-0 cursor-pointer list-none items-baseline gap-1 marker:hidden group-open:hidden"
          >
            <span className="min-w-0 truncate">{shown.join(", ")}</span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-blue-600 hover:underline dark:text-blue-400">
              +{rest} more
            </span>
          </summary>
          <p className="mt-1 hidden break-words group-open:block">
            {tool.functions.join(", ")}
          </p>
          <button
            ref={showLessRef}
            type="button"
            onClick={() => setOpen(false)}
            className="mt-0.5 hidden text-[11px] text-blue-600 hover:underline group-open:block dark:text-blue-400"
          >
            Show less
          </button>
        </details>
      ) : (
        <p className="mt-1 break-words text-xs text-zinc-500 dark:text-zinc-400">
          {tool.functions.join(", ")}
        </p>
      )}
      {checked && (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          Disabling this toolkit stops agents that use it.
        </p>
      )}
    </div>
  );
}

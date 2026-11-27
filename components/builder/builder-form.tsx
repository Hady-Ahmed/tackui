"use client";

/**
 * The agent builder form — create + edit for builder-origin agents
 * (Phase 1 "create your own agents"). Embedded by the /agents management
 * page (the builder's only surface); the page owns the chrome, this
 * component owns the definition.
 *
 * Member-accessible: any signed-in org member can build an agent — the
 * runtime config (endpoint + JWT) resolves from platform env at run time,
 * so the form only carries the definition (name/description/instructions
 * + model + tools + connectors). Editing and deleting are author-only
 * ("You can only edit agents you created") — enforced by the backend and
 * mirrored here.
 *
 * Wire contracts (server side lives in lib/agents/builder.ts):
 *  - create  → POST /api/agents/builder  {name, description, instructions,
 *             model:{provider,id}, tools:[{name}], connectors:[names]}
 *  - update  → PATCH /api/agents/builder/[id]  (all fields optional, at
 *             least one required; model/tools/connectors replace wholesale;
 *             the current instructions live in the AgentOS config, not the
 *             local store — the edit GET reads them back for the prefill,
 *             and a blank field preserves them)
 *  - badges  → GET /api/credentials (hasKey per provider + catalog),
 *             GET /api/connectors — all four loads (models, tools,
 *             credentials, connectors) are lifted to the /agents page —
 *             fetched once per page visit, passed down as props (every
 *             panel open and tab flip used to re-run all four fetches);
 *             in-page mutations refresh through the refresh callbacks
 *
 * The 402s the run gate produces (missing connector, missing BYOK key,
 * daily quota) surface at run time in the chat; this form front-loads
 * them: the model/tool badges show the key state and the connector
 * section carries the run-gate copy ("an org admin needs to add it before
 * the agent can run").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { PublicAgent } from "@/lib/agents/agents.config";
import type { PublicConnector } from "@/lib/connectors/connector-store";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { ExpandableText } from "@/components/expandable-text";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useBilling } from "@/lib/billing/use-billing";
import {
  BUILDER_CONNECTORS_MAX,
  buildCreatePayload,
  buildKnowledgeUploadForm,
  catalogEmptyCopy,
  catalogErrorCopy,
  createBlockedByEmptyModels,
  buildEditPayload,
  extractErrorMessage,
  filterTools,
  findModel,
  groupModelsByProvider,
  groupToolsByToolkit,
  hasProcessingDocs,
  KNOWLEDGE_CREATE_NOTE,
  KNOWLEDGE_DETACH_RETRY_COPY,
  KNOWLEDGE_FAILED_HINT,
  KNOWLEDGE_FILE_ACCEPT,
  KNOWLEDGE_MAX_UPLOAD_BYTES,
  KNOWLEDGE_POLL_MS,
  knowledgeCapabilityState,
  knowledgeDateLabel,
  knowledgeFileError,
  knowledgeHiddenCopy,
  knowledgeKeyBadge,
  knowledgeListEmptyCopy,
  knowledgeSizeLabel,
  knowledgeStatusChip,
  knowledgeTextError,
  knowledgeUrlError,
  modelKeyState,
  parseKnowledgeChunkFields,
  pickDefaultModel,
  prettySlug,
  providerMeta,
  staleModelCopy,
  toolKeyState,
  validateBuilderForm,
  type BuilderFormState,
  type BuilderToolOption,
  type CredentialsState,
  type KnowledgeCapability,
  type KnowledgeCapabilityState,
  type KnowledgeChunkParse,
  type KnowledgeDocRow,
  type KnowledgeKeyBadge,
  type KnowledgeUploadSource,
  type PlatformModel,
  type ToolKeyState,
  type ToolkitGroup,
} from "./builder-config";

export function BuilderForm({
  mode,
  agentId,
  models,
  modelsError,
  tools,
  toolsError,
  retryCatalogs,
  credentials,
  refreshCredentials,
  connectors,
  connectorsError,
  retryConnectors,
  onSaved,
  onDeleted,
  onCancel,
}: {
  mode: "create" | "edit";
  agentId?: string;
  /**
   * The platform model/tool catalogs and the user-scoped badge/palette
   * data (credentials, connectors) — all lifted to the /agents page and
   * fetched once per page visit; null while the page-level fetch is in
   * flight. The page is the single source of truth for this form AND the
   * ConnectorsAdmin section, so a connector added there shows up in the
   * palette without a re-fetch. The connect flow and connector mutations
   * refresh through the callbacks below.
   */
  models: PlatformModel[] | null;
  modelsError: string | null;
  tools: BuilderToolOption[] | null;
  toolsError: string | null;
  /** Re-fetch the two lifted catalogs — the catalog banner's Retry. */
  retryCatalogs: () => Promise<void>;
  /**
   * hasKey per provider + the credentials catalog — the key badges'
   * source and the key-aware model default's connectivity signal.
   */
  credentials: CredentialsState | null;
  /** Re-fetch credentials — the KeyForm save's success path, so a newly
   *  connected key updates the page state (re-rendering the badges and
   *  re-running the model-default effect). */
  refreshCredentials: () => Promise<void>;
  connectors: PublicConnector[] | null;
  connectorsError: string | null;
  /** Re-fetch connectors — the palette error banner's Retry. */
  retryConnectors: () => Promise<void>;
  /**
   * A successful create/save. The panel closes and the parent navigates
   * to /app?agent=<id> — "save & open in chat".
   */
  onSaved: (agent: PublicAgent) => void;
  /** A successful delete (edit mode only). The parent refreshes the table. */
  onDeleted?: () => void;
  /** The Cancel button — the parent closes the panel. */
  onCancel: () => void;
}) {
  const { data: session, isPending } = authClient.useSession();
  const { config } = useAuthConfig();
  const { canManage } = useCanManageAgents();
  const { billing } = useBilling();
  // Platform admin (or solo synthetic admin) — gates the "Models & tools"
  // link next to the picker. Deliberately NOT canManage: that gate spans
  // org owners/admins, but the catalog is global and only platform admins
  // may edit it.
  const isPlatformAdmin = config?.authDisabled || session?.user?.role === "admin";

  // Palette search — filters the rendered rows only. Selections live in
  // form.tools, so hiding a row never drops it from the agent's payload.
  const [toolQuery, setToolQuery] = useState("");
  // Which toolkit groups are drilled in — default collapsed; the row's
  // checkbox covers the common "take the whole toolkit" case.
  const [expandedToolkits, setExpandedToolkits] = useState<
    Record<string, boolean>
  >({});
  // Toolkits expanded at least once this form session. A newly-
  // encountered toolkit's tools all start checked on first expand; this
  // keeps a collapse → re-expand from re-checking tools the user just
  // unchecked.
  const [seenToolkits, setSeenToolkits] = useState<Set<string>>(
    () => new Set(),
  );
  // The catalog-failure Retry button's in-flight flag — without it the
  // click gives no feedback and a double-click fires duplicate fetches.
  const [retryingCatalog, setRetryingCatalog] = useState(false);
  const [agent, setAgent] = useState<PublicAgent | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [form, setForm] = useState<BuilderFormState>({
    name: "",
    description: "",
    instructions: "",
    model: null,
    tools: [],
    connectors: [],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [planCap, setPlanCap] = useState(false);
  const [saving, setSaving] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [keyProvider, setKeyProvider] = useState<string | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  /* -------------------------------------------------------------------- */
  /* Knowledge section state (#236)                                        */
  /* -------------------------------------------------------------------- */
  // The capability + doc list are form-owned (per-open — they address
  // THIS agent), unlike the four lifted page loads.
  const [knowledgeCapability, setKnowledgeCapability] =
    useState<KnowledgeCapability | null>(null);
  const [knowledgeCapabilityError, setKnowledgeCapabilityError] =
    useState<string | null>(null);
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDocRow[] | null>(null);
  const [knowledgeDocsError, setKnowledgeDocsError] = useState<string | null>(null);
  // Upload/delete errors render INSIDE the section (the page-level banner
  // is far from the user's cursor here — same rule as the KeyForm's
  // inline error).
  const [knowledgeActionError, setKnowledgeActionError] = useState<string | null>(null);
  const [knowledgeUploading, setKnowledgeUploading] = useState(false);
  const [knowledgeDeletingId, setKnowledgeDeletingId] = useState<string | null>(null);
  // A delete that LANDED while its detach publish failed — the Retry
  // re-fires the idempotent delete to finish the agent's knowledge
  // update (null = nothing pending).
  const [knowledgeDetachRetryId, setKnowledgeDetachRetryId] = useState<string | null>(null);
  // The paste-text row + URL row + Advanced disclosure inputs.
  const [pasteText, setPasteText] = useState("");
  const [pasteName, setPasteName] = useState("");
  const [knowledgeUrl, setKnowledgeUrl] = useState("");
  // Blank strings = omitted (the platform's own defaults apply — the
  // agno defaults differ per chunker, so the UI invents no number).
  const [chunkSizeText, setChunkSizeText] = useState("");
  const [chunkOverlapText, setChunkOverlapText] = useState("");
  // The file picker is uncontrolled; clearing `.value` after each round
  // lets the same file be re-picked after an error.
  const knowledgeFileInputRef = useRef<HTMLInputElement | null>(null);
  // Opens the connect form and clears any stale inline error — the error
  // belongs to the (provider-keyed) form, not the page.
  const openKeyForm = (provider: string) => {
    setKeyProvider(provider);
    setKeyError(null);
  };

  const currentUserId = session?.user.id ?? config?.user?.id ?? null;

  /* -------------------------------------------------------------------- */
  /* Data loading                                                          */
  /* -------------------------------------------------------------------- */

  const loadAgent = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAgentError(extractErrorMessage(data, "Agent not found"));
        return;
      }
      setAgent(data);
      // Prefill the edit form from the agent's requirements snapshot. The
      // instructions are read back from the AgentOS component config by
      // the GET route (they're never stored locally) — the owner's
      // tweakable system prompt, prefilled like name/description. When
      // the platform is unreachable the field is omitted and starts
      // blank, which the PATCH contract preserves as "keep current" —
      // and the catalog-error banner below disables the submit anyway,
      // so the blank case can't silently save.
      const a = data as PublicAgent | undefined;
      const req = a?.requirements;
      setForm({
        name: a?.name ?? "",
        description: a?.description ?? "",
        instructions: a?.instructions ?? "",
        model: req ? { provider: req.model.provider, id: req.model.id } : null,
        tools: req?.tools.map((t) => t.name) ?? [],
        // The form's connector state holds org-facing NAMES; the snapshot
        // carries {id, name} pairs.
        connectors: req?.connectors.map((c) => c.name) ?? [],
      });
    } catch {
      // Without this, edit mode strands on "Loading…" forever.
      setAgentError("Couldn't reach the server — try again shortly.");
    }
  }, [agentId]);

  // The key-aware default (create mode) — once BOTH the catalog and the
  // credentials have arrived, preselect the first model of the first
  // connected provider (pickDefaultModel; no keys → no default, the
  // select stays on its placeholder). Lives here, not in a loader: both
  // are props now, and the default must react to a key connected inside
  // the dialog (refreshCredentials updates the page state → new prop
  // value) the same way the loader's version reacted to the catalog
  // arriving. The setForm guard (prev.model ? prev) keeps user edits
  // never overridden — the effect only fills an empty selection.
  useEffect(() => {
    if (mode !== "create" || !models || !credentials) return;
    // Wrapper indirection satisfies react-hooks/set-state-in-effect (same
    // pattern as the loaders below).
    const apply = async () => {
      const def = pickDefaultModel(models, credentials.hasKey);
      if (def)
        setForm((prev) =>
          prev.model ? prev : { ...prev, model: { provider: def.provider, id: def.id } },
        );
    };
    void apply();
  }, [mode, models, credentials]);

  useEffect(() => {
    if (isPending) return;
    // Wrapper indirection satisfies react-hooks/set-state-in-effect (the
    // loader sets state after its fetch resolves — same pattern as
    // users-admin). All four data loads are the PARENT's problem now
    // (lifted — fetched once per page visit); only the per-agent edit
    // prefill stays form-owned — it is legitimately per-open.
    const load = async () => {
      if (mode === "edit") await loadAgent();
    };
    load();
  }, [isPending, mode, loadAgent]);

  /* -------------------------------------------------------------------- */
  /* Knowledge — capability + corpus loads (edit mode only)                 */
  /* -------------------------------------------------------------------- */

  const loadKnowledgeCapability = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/knowledge/config`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKnowledgeCapabilityError(
          extractErrorMessage(data, `Failed to load the knowledge settings (${res.status})`),
        );
        return;
      }
      setKnowledgeCapability(data as KnowledgeCapability);
      setKnowledgeCapabilityError(null);
    } catch {
      setKnowledgeCapabilityError("Couldn't reach the server — try again shortly.");
    }
  }, [agentId]);

  /**
   * (Re-)load the corpus list. Returns the rows (or null on failure) —
   * the delete flow re-fetches to learn whether the delete LANDED (the
   * list is the truth when a 502/409 may mean "landed + detach failed").
   */
  const loadKnowledgeDocs = useCallback(
    async (): Promise<KnowledgeDocRow[] | null> => {
      if (!agentId) return null;
      try {
        const res = await fetch(`/api/agents/${agentId}/knowledge`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setKnowledgeDocsError(
            extractErrorMessage(data, `Failed to load the document list (${res.status})`),
          );
          return null;
        }
        const rows = Array.isArray(data) ? (data as KnowledgeDocRow[]) : [];
        setKnowledgeDocs(rows);
        setKnowledgeDocsError(null);
        return rows;
      } catch {
        setKnowledgeDocsError("Couldn't reach the server — try again shortly.");
        return null;
      }
    },
    [agentId],
  );

  useEffect(() => {
    if (mode !== "edit" || !agentId) return;
    // Wrapper indirection satisfies react-hooks/set-state-in-effect.
    const load = async () => {
      await Promise.all([loadKnowledgeCapability(), loadKnowledgeDocs()]);
    };
    load();
  }, [mode, agentId, loadKnowledgeCapability, loadKnowledgeDocs]);

  // Status polling — agno ingests async, so a just-uploaded row reads
  // "processing" until the service finishes. While any row is
  // processing, re-poll the list on an interval; the effect stops (and
  // clears the timer) the moment every row is settled — and on unmount.
  const anyDocProcessing = knowledgeDocs ? hasProcessingDocs(knowledgeDocs) : false;
  useEffect(() => {
    if (!anyDocProcessing) return;
    let cancelled = false;
    const tick = async () => {
      await loadKnowledgeDocs();
    };
    void tick();
    const timer = setInterval(() => {
      if (!cancelled) void tick();
    }, KNOWLEDGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [anyDocProcessing, loadKnowledgeDocs]);

  /**
   * One delayed re-fetch after a landed upload. The service writes the
   * contents row in its background task after the 202 — the immediate
   * load can lose that race and see no new row, and if no other row is
   * processing the poll never engages, leaving the just-uploaded doc
   * invisible. The timer is replaced (never stacked) by a rapid second
   * upload and cleared on unmount.
   */
  const knowledgeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleKnowledgeRefresh = useCallback(() => {
    if (knowledgeRefreshTimerRef.current) clearTimeout(knowledgeRefreshTimerRef.current);
    knowledgeRefreshTimerRef.current = setTimeout(() => {
      knowledgeRefreshTimerRef.current = null;
      void loadKnowledgeDocs();
    }, KNOWLEDGE_POLL_MS);
  }, [loadKnowledgeDocs]);
  useEffect(
    () => () => {
      if (knowledgeRefreshTimerRef.current) clearTimeout(knowledgeRefreshTimerRef.current);
    },
    [],
  );

  /* -------------------------------------------------------------------- */
  /* Derived                                                               */
  /* -------------------------------------------------------------------- */

  const isBuilder = mode === "create" || agent?.origin === "builder";
  const isAuthor =
    mode === "create" || (Boolean(agent) && agent?.authorUserId === currentUserId);
  // Non-builder / non-author agents are not addressable here — the backend
  // PATCH also 403s, this is the UI mirror (defense in depth: the /agents
  // table only renders Edit on the author's own builder rows).
  const notAllowed = mode === "edit" && Boolean(agent) && (!isBuilder || !isAuthor);
  // A snapshot-less row: the stored requirements blob failed to parse and
  // was dropped at read (an older-format save). The run gate 402s these
  // with "open it in the agent builder and save it again" — this flag
  // turns that instruction into something the form can actually do: the
  // PATCH must carry a FULL config (model + tools + connectors), because
  // there is no snapshot to diff against and no snapshot to preserve
  // fields from. See handleSubmit + the banner in the form body.
  const staleSnapshot =
    mode === "edit" && agent !== null && agent.requirements === undefined;
  const groups = models ? groupModelsByProvider(models) : [];
  const selectedModel = form.model
    ? findModel(models ?? [], form.model.provider, form.model.id)
    : null;
  // The model options for the selected provider — undefined when the
  // provider itself isn't in the catalog (edit mode, removed provider).
  const modelProvider = form.model?.provider ?? null;
  const providerGroup = modelProvider
    ? groups.find((g) => g.provider === modelProvider)
    : undefined;
  const staleCopy = staleModelCopy(form.model, models, modelsError);
  const modelState = modelKeyState(
    form.model
      ? {
          provider: form.model.provider,
          platformTier: selectedModel?.platformTier ?? false,
          requiresKey: selectedModel?.requiresKey ?? true,
          depKey: selectedModel?.depKey ?? null,
        }
      : null,
    credentials,
  );
  const fieldErrors = validateBuilderForm(form, mode);
  // The builder is disabled on this deployment (AGENTOS_BASE_URL unset)
  // or whenever the platform catalogs can't be fetched — models or tools
  // — since the definition would be validated against a stale palette.
  const builderDisabled =
    (modelsError !== null && models === null) || (toolsError !== null && tools === null);
  // An empty model catalog can't produce a valid create (model is
  // required) — the submit stays disabled and the picker explains why.
  const createDisabled = createBlockedByEmptyModels(mode, models, modelsError);
  const modelsEmptyCopy = catalogEmptyCopy("models", models, modelsError);
  const toolsEmptyCopy = catalogEmptyCopy("tools", tools, toolsError);
  // The palette's rendered groups — the loaded catalog under the search
  // query. Empty list ≠ empty catalog: the no-match state is its own copy.
  const visibleGroups = tools
    ? groupToolsByToolkit(filterTools(tools, toolQuery))
    : [];

  // --- Knowledge (edit mode only; create shows the one-line note) ---
  const knowledgeCap: KnowledgeCapabilityState | null =
    mode === "edit" && agentId
      ? knowledgeCapabilityState(knowledgeCapability, knowledgeCapabilityError)
      : null;
  const knowledgeBadge =
    knowledgeCap?.kind === "available"
      ? knowledgeKeyBadge(
          knowledgeDocs,
          knowledgeCap.provider,
          credentials,
          modelState,
        )
      : null;
  const knowledgeDocsEmptyCopy = knowledgeListEmptyCopy(
    knowledgeDocs,
    knowledgeDocsError,
  );

  // The edit-mode baseline: the agent's stored definition (instructions
  // prefill means the diff is computed against the real current value).
  const original = agent?.requirements
    ? {
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions ?? "",
        model: { provider: agent.requirements.model.provider, id: agent.requirements.model.id },
        tools: agent.requirements.tools.map((t) => t.name),
        // The form's connector state holds org-facing NAMES (the picker's
        // vocabulary); the snapshot carries {id, name} pairs — map to
        // names so the edit diff compares like with like.
        connectors: agent.requirements.connectors.map((c) => c.name),
      }
    : null;

  // "Save changes" with a zero diff silently navigates to chat (the
  // parent treats it like a save — close + open in chat). Label the
  // button honestly when nothing is changed — EXCEPT on a stale snapshot,
  // where the click genuinely re-publishes the full config and must keep
  // saying "Save changes" (that's the unworkable-402 remedy's whole point).
  const noChanges =
    mode === "edit" &&
    !staleSnapshot &&
    original !== null &&
    Object.keys(buildEditPayload(form, original)).length === 0;

  /* -------------------------------------------------------------------- */
  /* Actions                                                               */
  /* -------------------------------------------------------------------- */

  const updateForm = (patch: Partial<BuilderFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const toggleTool = (name: string) => {
    setForm((prev) => {
      if (prev.tools.includes(name)) return { ...prev, tools: prev.tools.filter((t) => t !== name) };
      return { ...prev, tools: [...prev.tools, name] };
    });
  };

  /** Toolkit-level selection: checked = every tool of the toolkit,
   *  unchecked = none (the easy path); the drill-in panel curates
   *  individuals. Computed inside the updater so rapid clicks never
   *  act on a stale form.tools. */
  const toggleToolkit = (group: ToolkitGroup) => {
    const names = group.tools.map((t) => t.name);
    setForm((prev) => {
      if (names.every((n) => prev.tools.includes(n)))
        return { ...prev, tools: prev.tools.filter((n) => !names.includes(n)) };
      const set = new Set(prev.tools);
      for (const n of names) set.add(n);
      return { ...prev, tools: [...set] };
    });
  };

  /** Drill in/out of a toolkit. First expand of a toolkit with nothing
   *  selected from it checks all its tools (the "curate down from all"
   *  entry point the easy checkbox mirrors); seenToolkits makes that a
   *  once-per-toolkit effect, never a loop. */
  const toggleToolkitExpand = (group: ToolkitGroup) => {
    const slug = group.toolkit;
    const opening = !expandedToolkits[slug];
    setExpandedToolkits((prev) => ({ ...prev, [slug]: opening }));
    if (!opening || seenToolkits.has(slug)) return;
    setSeenToolkits((prev) => new Set(prev).add(slug));
    const names = group.tools.map((t) => t.name);
    setForm((prev) =>
      names.some((n) => prev.tools.includes(n))
        ? prev
        : { ...prev, tools: [...prev.tools, ...names] },
    );
  };

  const toggleConnector = (name: string) => {
    setForm((prev) => {
      if (prev.connectors.includes(name))
        return { ...prev, connectors: prev.connectors.filter((c) => c !== name) };
      if (prev.connectors.length >= BUILDER_CONNECTORS_MAX) return prev;
      return { ...prev, connectors: [...prev.connectors, name] };
    });
  };

  const saveKey = async (provider: string, fields: Record<string, string>) => {
    setKeySaving(true);
    setKeyError(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, fields }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Inline in KeyForm, not the page-level banner: the user's cursor
        // is at the key form (possibly several screens below the banner) —
        // an error only visible up top reads as a silent no-op.
        setKeyError(extractErrorMessage(data, "Failed to save the key"));
        return false;
      }
      await refreshCredentials();
      return true;
    } catch {
      setKeyError("Couldn't reach the server — please try again.");
      return false;
    } finally {
      setKeySaving(false);
    }
  };

  /* -------------------------------------------------------------------- */
  /* Knowledge actions                                                     */
  /* -------------------------------------------------------------------- */

  /**
   * One upload (file | text | url) → POST /api/agents/[id]/knowledge.
   * Client pre-checks mirror the route's cheap gates (instant feedback);
   * the route re-validates everything. `withChunk` carries the parsed
   * Advanced fields. Returns whether the upload was accepted.
   */
  const uploadKnowledge = async (
    source: KnowledgeUploadSource,
    chunk: KnowledgeChunkParse,
  ): Promise<boolean> => {
    if (!agentId) return false;
    setKnowledgeUploading(true);
    setKnowledgeActionError(null);
    try {
      const body = buildKnowledgeUploadForm(
        source,
        chunk.ok ? { chunkSize: chunk.chunkSize, chunkOverlap: chunk.chunkOverlap } : undefined,
      );
      const res = await fetch(`/api/agents/${agentId}/knowledge`, {
        method: "POST",
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKnowledgeActionError(
          extractErrorMessage(data, `Upload failed (${res.status})`),
        );
        return false;
      }
      return true;
    } catch {
      setKnowledgeActionError("Couldn't reach the server — please try again.");
      return false;
    } finally {
      setKnowledgeUploading(false);
    }
  };

  /** The file picker's change — validate every picked file, then upload
   *  each one sequentially (the route takes exactly one file per
   *  request). The list refresh happens once, after the last upload. */
  const handleKnowledgeFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    for (const file of picked) {
      const problem = knowledgeFileError(file);
      if (problem) {
        setKnowledgeActionError(problem);
        if (knowledgeFileInputRef.current) knowledgeFileInputRef.current.value = "";
        return;
      }
    }
    const chunk = parseKnowledgeChunkFields(chunkSizeText, chunkOverlapText);
    if (!chunk.ok) {
      setKnowledgeActionError(chunk.error);
      if (knowledgeFileInputRef.current) knowledgeFileInputRef.current.value = "";
      return;
    }
    let anyOk = false;
    for (const file of picked) {
      const ok = await uploadKnowledge({ kind: "file", file }, chunk);
      if (!ok) {
        break; // the error is on screen; stop the batch there
      }
      anyOk = true;
    }
    if (knowledgeFileInputRef.current) knowledgeFileInputRef.current.value = "";
    // Unconditional: a batch that stopped at file 3 of 5 still landed
    // files 1-2 — their rows must show even though the batch stopped.
    await loadKnowledgeDocs();
    // The 202'd doc's contents row is written by the service's background
    // task AFTER the response — the immediate load above can lose that
    // race and see no new row (and, if no other row is processing, no
    // poll engages and nothing would ever refresh). One delayed re-fetch
    // per landed upload closes the gap.
    if (anyOk) scheduleKnowledgeRefresh();
  };

  /** The paste-text row's Add. */
  const handleKnowledgeText = async () => {
    const problem = knowledgeTextError(pasteText);
    if (problem) {
      setKnowledgeActionError(problem);
      return;
    }
    if (!pasteName.trim()) {
      setKnowledgeActionError("Name the document so it's findable in the list.");
      return;
    }
    const chunk = parseKnowledgeChunkFields(chunkSizeText, chunkOverlapText);
    if (!chunk.ok) {
      setKnowledgeActionError(chunk.error);
      return;
    }
    const ok = await uploadKnowledge(
      { kind: "text", text: pasteText.trim(), name: pasteName.trim() },
      chunk,
    );
    if (ok) {
      setPasteText("");
      setPasteName("");
      await loadKnowledgeDocs();
      scheduleKnowledgeRefresh();
    }
  };

  /** The URL row's Add. */
  const handleKnowledgeUrl = async () => {
    const problem = knowledgeUrlError(knowledgeUrl);
    if (problem) {
      setKnowledgeActionError(problem);
      return;
    }
    const chunk = parseKnowledgeChunkFields(chunkSizeText, chunkOverlapText);
    if (!chunk.ok) {
      setKnowledgeActionError(chunk.error);
      return;
    }
    const ok = await uploadKnowledge(
      { kind: "url", url: knowledgeUrl.trim() },
      chunk,
    );
    if (ok) {
      setKnowledgeUrl("");
      await loadKnowledgeDocs();
      scheduleKnowledgeRefresh();
    }
  };

  /**
   * The delete flow, confirm separated from the attempt: the detach-
   * retry path re-fires the ATTEMPT directly (the document is already
   * gone — the retry finishes the agent's knowledge update and must not
   * re-ask "this cannot be undone").
   */
  const attemptKnowledgeDelete = async (contentId: string) => {
    if (!agentId) return;
    setKnowledgeDeletingId(contentId);
    setKnowledgeActionError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/knowledge/${encodeURIComponent(contentId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const routeError = extractErrorMessage(data, `Delete failed (${res.status})`);
        await settleKnowledgeDelete(contentId, routeError);
        return;
      }
      setKnowledgeDetachRetryId(null);
      await loadKnowledgeDocs();
    } catch {
      // A lost response (the delete may have reached the server before the
      // network blip) settles the same way: the re-fetched list is the
      // truth — a vanished row means the retry is safe and must not
      // re-ask the confirm.
      await settleKnowledgeDelete(contentId, "Couldn't reach the server — please try again.");
    } finally {
      setKnowledgeDeletingId(null);
    }
  };

  /**
   * The failed/lost delete's settle: the re-fetched list is the truth
   * (the delete may have LANDED with its detach publish failing — the
   * #235 note). A vanished row raises the amber retry notice alone —
   * a red error would frame a good outcome as a failure — while an
   * error whose row is still there shows the route's message.
   */
  const settleKnowledgeDelete = async (contentId: string, routeError: string) => {
    const rows = await loadKnowledgeDocs();
    const gone = rows !== null && !rows.some((r) => r.id === contentId);
    if (gone) {
      setKnowledgeDetachRetryId(contentId);
      setKnowledgeActionError(null);
    } else {
      setKnowledgeActionError(routeError);
    }
  };

  const deleteKnowledgeDoc = (contentId: string) => {
    if (!confirm("Delete this document from the agent's knowledge? This cannot be undone.")) return;
    void attemptKnowledgeDelete(contentId);
  };

  /** The detach-retry notice's Retry (no confirm — nothing left to undo). */
  const retryKnowledgeDetach = (contentId: string) => {
    void attemptKnowledgeDelete(contentId);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (notAllowed) return;
    if (Object.keys(fieldErrors).length) {
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setError(null);
    setSaving(true);
    try {
      const body =
        mode === "create" ? buildCreatePayload(form) : buildEditPayload(form, original);
      // Edit mode with no changes → nothing to publish; the parent treats
      // it like a save (close + open in chat). Never fires for a stale
      // snapshot — buildEditPayload sends the full config there (see its
      // docstring), which is the point: "just save it again" must work
      // even with zero edits.
      if (mode === "edit" && Object.keys(body).length === 0 && agent) {
        onSaved(agent);
        return;
      }
      const url = mode === "create" ? "/api/agents/builder" : `/api/agents/builder/${agentId}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 402) {
          // Plan-cap paywall — "Your plan allows up to N agents. Upgrade
          // to add more." Admins get the upgrade dialog (checkout is
          // org-admin gated); members get the error + a pointer to
          // their org admin.
          setError(typeof data.error === "string" ? data.error : "Request failed");
          if (data.code === "PLAN_AGENT_LIMIT") {
            setPlanCap(true);
            if (canManage) setUpgradeOpen(true);
          }
          return;
        }
        setError(extractErrorMessage(data, `Request failed (${res.status})`));
        return;
      }
      onSaved(data as PublicAgent);
    } catch {
      // Own-proxy failure — without this the Save button silently does
      // nothing on a network error.
      setError("Couldn't reach the server — please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!agentId) return;
    if (!confirm(`Delete agent "${agent?.name ?? agentId}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/agents/builder/${agentId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(extractErrorMessage(data, "Delete failed"));
        return;
      }
      onDeleted?.();
    } catch {
      setError("Couldn't reach the server — please try again.");
    }
  };

  /* -------------------------------------------------------------------- */
  /* Render                                                                */
  /* -------------------------------------------------------------------- */

  if (
    isPending ||
    !config ||
    (!session && !config.authDisabled) ||
    (mode === "edit" && !agent && !agentError)
  ) {
    return (
      <div className="flex items-center justify-center py-10">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }

  if (notAllowed) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
          You can only edit agents you created.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Back to the agents list
        </button>
      </div>
    );
  }

  if (agentError) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{agentError}</p>
        {/* A transient 429 or blip is one click from recoverable — without
            a Retry the only way back is a full round-trip through the list
            page. Same affordance as the catalog banner's Retry. */}
        <div className="mt-3 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => {
              setAgentError(null);
              void loadAgent();
            }}
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            Back to the agents list
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {builderDisabled && (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          <div className="flex items-center justify-between gap-3">
            <span>{catalogErrorCopy(modelsError, toolsError)}</span>
            {/* Same recovery affordance as the admin page's Retry —
                without it the only path out is a full browser reload. */}
            <button
              type="button"
              onClick={() => {
                // Errors stay up until the retry resolves — the page's
                // loaders re-set them on failure; success lifts the
                // banner by setting the catalogs. Clearing them here
                // would flash the form enabled with empty dropdowns.
                setRetryingCatalog(true);
                void retryCatalogs().finally(() => setRetryingCatalog(false));
              }}
              disabled={retryingCatalog}
              className="shrink-0 rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              {retryingCatalog ? "Retrying…" : "Retry"}
            </button>
          </div>
        </div>
      )}

      {staleSnapshot && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          This agent was saved by an older version of the agent builder and
          can&apos;t run until it&apos;s saved again. Its model, tools and
          connectors have been cleared below — pick them again (the same ones
          are fine), then save.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <p>{error}</p>
          {planCap && !canManage && (
            <p className="mt-1 text-xs">
              An org admin needs to upgrade to add more agents.
            </p>
          )}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
      >
        {/* Identity */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errors.name}>
            <input
              value={form.name}
              onChange={(e) => updateForm({ name: e.target.value })}
              maxLength={100}
              required
              className={inputClass()}
              placeholder="Research Assistant"
            />
          </Field>
          <Field
            label="Description"
            required
            error={errors.description}
            hint="Shown in the sidebar under the agent's name"
          >
            <input
              value={form.description}
              onChange={(e) => updateForm({ description: e.target.value })}
              maxLength={300}
              required
              className={inputClass()}
              placeholder="Finds sources and summarizes them"
            />
          </Field>
        </div>

        <Field
          label="Instructions"
          required={mode === "create"}
          error={errors.instructions}
          hint="The system prompt — how the agent behaves."
        >
          <textarea
            value={form.instructions}
            onChange={(e) => updateForm({ instructions: e.target.value })}
            maxLength={8000}
            rows={6}
            required={mode === "create"}
            className={inputClass()}
            placeholder="You are a research assistant. Find sources and summarize them."
          />
        </Field>

        {/* Model picker — provider, then model. The provider decides whose
            API key the run needs, so it's an explicit first choice, and the
            two selects can never disagree: changing the provider resets the
            model to that provider's default (first localeCompare-sorted
            entry — tier ordering is dormant).
            The model select holds raw ids — no combined provider:id value,
            so a model id containing a colon (e.g. OpenRouter's ":free"
            suffix) round-trips exactly. */}
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Provider" required>
              <select
                value={form.model?.provider ?? ""}
                onChange={(e) => {
                  const provider = e.target.value;
                  const group = groups.find((g) => g.provider === provider);
                  // Re-selecting the stale placeholder must keep the
                  // model — it's the row that keeps the collapsed state
                  // informative; clearing it would blank the form.
                  if (form.model && provider === form.model.provider) return;
                  updateForm({
                    model: group
                      ? { provider, id: group.models[0].id }
                      : null,
                  });
                }}
                className={inputClass()}
              >
                {/* A removed provider (edit mode) can't render as an
                    offered option — show it as an explicit placeholder
                    row so the collapsed state stays informative. The
                    option value IS the stale provider, so the controlled
                    select matches it (a value="" placeholder never
                    matches and renders blank). An EMPTY catalog gets the
                    same treatment with honest copy — it's the first-run
                    state, not a removal, so "no longer offered" would be
                    a claim we can't back; but a value="" placeholder
                    here would render the select BLANK (the saved
                    provider matches no option), which is worse than a
                    neutral label. While the catalog is still LOADING the
                    saved provider renders as its plain value — no claim,
                    just no blank flash. */}
                {form.model && models === null ? (
                  <option value={form.model.provider}>{form.model.provider}</option>
                ) : form.model &&
                  models !== null &&
                  models.length > 0 &&
                  !providerGroup ? (
                  <option value={form.model.provider}>
                    {prettySlug(form.model.provider)} (no longer offered)
                  </option>
                ) : form.model && models !== null && models.length === 0 ? (
                  <option value={form.model.provider}>
                    {prettySlug(form.model.provider)} (no models are enabled yet)
                  </option>
                ) : (
                  <option value="">Select a provider…</option>
                )}
                {groups.map((g) => (
                  <option key={g.provider} value={g.provider}>
                    {/* The value stays the raw slug (the PATCH contract);
                        the LABEL is prettified — members see "Openai
                        Responses", not the internal door slug. Same
                        convention as the key badges. */}
                    {prettySlug(g.provider)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model" required error={errors.model}>
              <select
                value={
                  form.model && selectedModel
                    ? form.model.id
                    : form.model && models === null
                      ? form.model.id // loading — show the saved value, never blank
                      : ""
                }
                onChange={(e) => {
                  // The placeholder rows carry an empty value — selecting
                  // them again must not write an empty model id.
                  if (e.target.value && form.model)
                    updateForm({ model: { provider: form.model.provider, id: e.target.value } });
                }}
                disabled={!providerGroup}
                className={inputClass(!providerGroup)}
              >
                {/* Stale saved model: not in the catalog anymore, so it
                    renders as an explicit placeholder row and the notice
                    below explains the gap. Guarded on models !== null —
                    while loading, the catalog can't have judged the model
                    stale yet (the saved value renders plainly so the
                    select never blanks) — and on a NON-empty catalog: an
                    empty one is the first-run state, not a removal. */}
                {form.model && models === null && (
                  <option value={form.model.id}>{form.model.id}</option>
                )}
                {form.model && models !== null && models.length > 0 && !selectedModel && (
                  <option value="">{form.model.id} (no longer offered)</option>
                )}
                {!form.model && <option value="">Pick a provider first…</option>}
                {form.model && models !== null && models.length === 0 && (
                  <option value="">No models are enabled yet</option>
                )}
                {providerGroup?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
              {modelsEmptyCopy && (
                <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {modelsEmptyCopy}
                </p>
              )}
              {staleCopy && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">{staleCopy}</p>
              )}
            </Field>
          </div>
          <div>
            <ModelKeyBadge
              state={modelState}
              onConnect={() => {
                // modelKeyState already resolved the credential provider
                // from the model's declared dep key — the VENDOR ("azure"),
                // not the model's door slug ("azure-claude"). The
                // credentials catalog collapses a vendor's doors into one
                // entry, so opening the key form at the door slug misses
                // the providerMeta lookup → KeyForm renders null (the
                // "connect one" button that opens nothing).
                if (modelState?.status === "missing" && modelState.provider) {
                  openKeyForm(modelState.provider);
                }
              }}
            />
          </div>
          {/* Platform admins manage what this picker offers — the
              Models & tools page (/admin/platform). Hidden from org
              admins/members: the catalog is global and they can't edit
              it. */}
          {isPlatformAdmin && (
            <Link
              href="/admin/platform"
              className="text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              Models &amp; tools
            </Link>
          )}
        </div>

        {/* Tool palette — the platform's tool catalog (GET /api/tools,
            proxied from the AgentOS /platform/tools), grouped by toolkit —
            the display-layer view of what /admin/platform already shapes.
            Adding a tool to the platform's allowlist shows up here with
            zero code. Search filters both levels (a toolkit matches on its
            slug/label, a function on label/description); the selection
            (form.tools) is unaffected — a hidden tool keeps its slot. */}
        <Field
          label="Tools"
          asGroup
          info="Many tools increase the context sent with every run — slower responses, higher cost."
          hint={
            form.tools.length > 0
              ? `${form.tools.length} tools selected — the agent can use them at run time.`
              : "Select tools — the agent can use them at run time."
          }
          error={errors.tools}
        >
          <div className="space-y-2">
            {(tools ?? []).length > 0 && (
              <input
                type="search"
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                placeholder="Search tools…"
                aria-label="Search tools"
                className={inputClass()}
              />
            )}
            {visibleGroups.map((group) => {
              // Partial selections (edit-mode snapshots) show the
              // checkbox's mixed state; full = all, none = unchecked.
              const checked = group.tools.filter((t) =>
                form.tools.includes(t.name),
              ).length;
              // Real toolkits share one credential contract, so the badge
              // derives once per toolkit — from any member. The degenerate
              // "Other tools" group can mix contracts, so it gets no badge
              // on the header; the badge is per-tool inside the drill-in.
              const degenerate = group.toolkit === "";
              const keyState = degenerate
                ? null
                : toolKeyState(group.tools[0], credentials);
              const open = expandedToolkits[group.toolkit] ?? false;
              return (
                <ToolkitRow
                  key={group.toolkit || "other-tools"}
                  group={group}
                  checked={checked}
                  expanded={open}
                  keyState={keyState}
                  onToggle={() => toggleToolkit(group)}
                  onExpand={() => toggleToolkitExpand(group)}
                  onConnect={() => {
                    // Same guard KeyBadge renders by — only a catalog-known
                    // provider gets a Connect flow (a drifted slug would
                    // open an empty KeyForm).
                    if (keyState?.status === "missing" && keyState.provider) {
                      openKeyForm(keyState.provider);
                    }
                  }}
                  renderTool={(tool) => {
                    // Real toolkits keep their rows badge-free (the
                    // toolkit-level badge carries the shared contract);
                    // the degenerate "Other tools" group mixes contracts,
                    // so each row derives — and owns — its own badge.
                    const toolKey = degenerate
                      ? toolKeyState(tool, credentials)
                      : null;
                    return (
                      <BuilderToolRow
                        key={tool.name}
                        tool={tool}
                        checked={form.tools.includes(tool.name)}
                        onToggle={() => toggleTool(tool.name)}
                        keyState={toolKey}
                        onConnect={() => {
                          // Same guard KeyBadge renders by — only a
                          // catalog-known provider gets a Connect flow.
                          if (
                            toolKey?.status === "missing" &&
                            toolKey.provider
                          ) {
                            openKeyForm(toolKey.provider);
                          }
                        }}
                      />
                    );
                  }}
                />
              );
            })}
            {toolsEmptyCopy && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{toolsEmptyCopy}</p>
            )}
            {tools !== null && tools.length > 0 && visibleGroups.length === 0 && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                No tools match &ldquo;{toolQuery.trim()}&rdquo;.
              </p>
            )}
          </div>
        </Field>

        {/* Connectors */}
        <Field
          label="Connectors"
          asGroup
          hint="MCP servers the agent can use at run time — managed by org admins."
          error={errors.connectors}
        >
          <div className="space-y-2">
            {connectorsError ? (
              // Error ≠ empty: a failed fetch must not claim "No connectors
              // yet" — the org's connectors may exist, the page just can't
              // see them. Same retry affordance as the catalog banner.
              <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950">
                <span className="text-xs text-red-700 dark:text-red-300">{connectorsError}</span>
                <button
                  type="button"
                  onClick={retryConnectors}
                  className="shrink-0 text-xs font-medium text-red-700 underline underline-offset-2 dark:text-red-300"
                >
                  Retry
                </button>
              </div>
            ) : (connectors ?? []).length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                No connectors yet.{" "}
                {canManage ? (
                  // Same page — the Connectors section is right below this
                  // form; the link just brings it into view. Intercepted so
                  // it GLIDES there (scrollIntoView) instead of the raw
                  // anchor's instant teleport — the same smooth motion the
                  // panel uses when it opens. The href stays for semantics
                  // (middle-click, no-JS fallbacks).
                  <a
                    href="#connectors"
                    onClick={(e) => {
                      e.preventDefault();
                      document
                        .getElementById("connectors")
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Add one below ↓
                  </a>
                ) : (
                  "An org admin needs to add connectors before the agent can run."
                )}
              </p>
            ) : (
              (connectors ?? []).map((c) => (
                <label
                  key={c.name}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  <input
                    type="checkbox"
                    checked={form.connectors.includes(c.name)}
                    onChange={() => toggleConnector(c.name)}
                    className="h-4 w-4 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
                  />
                  <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-50">
                    {c.name}
                  </span>
                  <span className="min-w-0 truncate text-xs text-zinc-400">{c.url}</span>
                  {c.hasToken ? (
                    <span className="ml-auto shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
                      token ✓
                    </span>
                  ) : null}
                </label>
              ))
            )}
            {(connectors ?? []).length > 0 && !canManage && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Missing a connector? An org admin needs to add it before the agent can run.
              </p>
            )}
            {(connectors ?? []).length > 0 && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Up to {BUILDER_CONNECTORS_MAX} connectors per agent.
              </p>
            )}
          </div>
        </Field>

        {/* Knowledge — documents the agent can search at run time. Docs
            attach to a SAVED component, so the section exists only in
            edit mode; create mode carries the one-line note. Edit mode
            gates the section on the capability signal (hidden with an
            explanation when off/unsupported, the error banner when
            unreachable — empty-vs-unreachable, same as the palette). */}
        {mode === "create" && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{KNOWLEDGE_CREATE_NOTE}</p>
        )}
        {mode === "edit" && knowledgeCap && knowledgeCap.kind !== "loading" && (
          <fieldset className="min-w-0 space-y-2 border-0 p-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Knowledge
              </span>
              {knowledgeBadge?.show && (
                <KnowledgeKeyBadgeView
                  badge={knowledgeBadge}
                  onConnect={() => {
                    // Same guard KeyBadge renders by — only a catalog-known
                    // provider gets a Connect flow (a drifted slug would
                    // open an empty KeyForm).
                    if (knowledgeBadge.provider) openKeyForm(knowledgeBadge.provider);
                  }}
                />
              )}
            </div>
            <p className="text-[11px] text-zinc-400">
              Documents the agent can search at run time — every run embeds its
              queries with your own OpenAI key.
            </p>

            {knowledgeCap.kind === "unreachable" && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950">
                <span className="text-xs text-red-700 dark:text-red-300">
                  {knowledgeCap.error}
                </span>
                <button
                  type="button"
                  onClick={() => void loadKnowledgeCapability()}
                  className="shrink-0 text-xs font-medium text-red-700 underline underline-offset-2 dark:text-red-300"
                >
                  Retry
                </button>
              </div>
            )}

            {knowledgeCap.kind === "hidden" && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {knowledgeHiddenCopy(knowledgeCap.reason)}
              </p>
            )}

            {knowledgeCap.kind === "available" && (
              <div className="space-y-3">
                {knowledgeActionError && (
                  <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                    {knowledgeActionError}
                  </p>
                )}
                {knowledgeDetachRetryId && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    <span>{KNOWLEDGE_DETACH_RETRY_COPY}</span>
                    <button
                      type="button"
                      onClick={() => retryKnowledgeDetach(knowledgeDetachRetryId)}
                      disabled={knowledgeDeletingId !== null}
                      className="font-medium underline underline-offset-2 disabled:opacity-50"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => setKnowledgeDetachRetryId(null)}
                      className="underline underline-offset-2"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Upload rows — three labeled sources (files / pasted
                    text / web page). Each is one POST (the route takes
                    exactly one source). */}
                <div className="space-y-4 rounded-lg border border-zinc-200 px-3 py-3 dark:border-zinc-700">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Files
                    </p>
                    {/* The native input is sr-only — the dashed row is the
                        visible picker (a bare file input reads as a text
                        field and was missed in the first live pass). */}
                    <label
                      className={`flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 focus-within:border-blue-500 dark:border-zinc-600 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-800 ${
                        knowledgeUploading ? "pointer-events-none opacity-50" : ""
                      }`}
                    >
                      <input
                        ref={knowledgeFileInputRef}
                        type="file"
                        multiple
                        accept={KNOWLEDGE_FILE_ACCEPT}
                        disabled={knowledgeUploading}
                        onChange={(e) => void handleKnowledgeFiles(e.target.files)}
                        aria-label="Upload files"
                        className="sr-only"
                      />
                      <span>Choose files…</span>
                    </label>
                    <p className="text-[11px] text-zinc-400">
                      PDF, CSV, Excel, Word, PowerPoint, JSON, Markdown, TXT —
                      up to 10 MB each.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Paste text
                    </p>
                    <input
                      value={pasteName}
                      onChange={(e) => setPasteName(e.target.value)}
                      maxLength={200}
                      placeholder="Document name"
                      aria-label="Pasted text document name"
                      className={inputClass()}
                    />
                    <textarea
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      rows={3}
                      placeholder="Paste the document's text here…"
                      aria-label="Paste text to add as a document"
                      maxLength={KNOWLEDGE_MAX_UPLOAD_BYTES}
                      className={inputClass()}
                    />
                    {/* Directly under the textarea it submits — "Add text"
                        next to the name field read as a second document
                        flow in the first live pass. */}
                    <button
                      type="button"
                      onClick={() => void handleKnowledgeText()}
                      disabled={knowledgeUploading}
                      className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      Add text
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Web page
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={knowledgeUrl}
                        onChange={(e) => setKnowledgeUrl(e.target.value)}
                        placeholder="https://example.com/page"
                        aria-label="Page URL to add as a document"
                        className={inputClass()}
                      />
                      <button
                        type="button"
                        onClick={() => void handleKnowledgeUrl()}
                        disabled={knowledgeUploading}
                        className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        Add URL
                      </button>
                    </div>
                    <p className="text-[11px] text-zinc-400">
                      The page is fetched and read when it&apos;s added — not
                      at run time.
                    </p>
                  </div>

                  {/* Advanced — chunk fields. Blank = the platform's own
                      defaults (agno's defaults differ per chunker, so the
                      UI shows blanks rather than inventing a number).
                      Applies to files and pasted text; URL ingest is
                      agno's auto-detected reader. */}
                  <details className="text-xs text-zinc-500 dark:text-zinc-400">
                    <summary className="cursor-pointer select-none">
                      Advanced — chunk size and overlap
                    </summary>
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Chunk size" hint="Leave blank for the default">
                        <input
                          type="number"
                          min={1}
                          value={chunkSizeText}
                          onChange={(e) => setChunkSizeText(e.target.value)}
                          aria-label="Chunk size"
                          className={inputClass()}
                        />
                      </Field>
                      <Field label="Chunk overlap" hint="Leave blank for the default">
                        <input
                          type="number"
                          min={0}
                          value={chunkOverlapText}
                          onChange={(e) => setChunkOverlapText(e.target.value)}
                          aria-label="Chunk overlap"
                          className={inputClass()}
                        />
                      </Field>
                    </div>
                    <p className="mt-2">
                      Applies to files and pasted text — the platform&apos;s own
                      defaults apply when left blank.
                    </p>
                  </details>
                </div>

                {/* The corpus's doc list — rows with status chips, polling
                    while any row processes (the effect above), delete with
                    confirm. A failed fetch renders the error banner, not
                    an empty-list claim. */}
                {knowledgeDocsError ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950">
                    <span className="text-xs text-red-700 dark:text-red-300">
                      {knowledgeDocsError}
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadKnowledgeDocs()}
                      className="shrink-0 text-xs font-medium text-red-700 underline underline-offset-2 dark:text-red-300"
                    >
                      Retry
                    </button>
                  </div>
                ) : knowledgeDocsEmptyCopy ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {knowledgeDocsEmptyCopy}
                  </p>
                ) : knowledgeDocs ? (
                  <div className="space-y-1">
                    {knowledgeDocs.map((doc) => (
                      <KnowledgeDocRowView
                        key={doc.id}
                        doc={doc}
                        deleting={knowledgeDeletingId === doc.id}
                        onDelete={() => deleteKnowledgeDoc(doc.id)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </fieldset>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button
            type="submit"
            disabled={saving || builderDisabled || createDisabled}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {saving
              ? "Saving…"
              : mode === "create"
                ? "Create agent"
                : noChanges
                  ? "Open in chat"
                  : "Save changes"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          {mode === "edit" && (
            <button
              type="button"
              onClick={handleDelete}
              // A delete firing mid-PATCH would race the save's own
              // compensations — same mutual exclusion as save/delete on
              // the credentials page.
              disabled={saving}
              className="ml-auto rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
            >
              Delete agent
            </button>
          )}
        </div>
      </form>

      {keyProvider && credentials && (
        <KeyForm
          // Remount per provider: the form's field state must not bleed
          // from one provider's contract into the next (different field
          // keys, different required sets).
          key={keyProvider}
          meta={providerMeta(credentials.catalog, keyProvider)}
          saving={keySaving}
          error={keyError}
          onSave={async (fields) => {
            const ok = await saveKey(keyProvider, fields);
            if (ok) setKeyProvider(null);
          }}
          onClose={() => setKeyProvider(null)}
        />
      )}

      {billing && canManage && (
        <UpgradeDialog open={upgradeOpen} onClose={() => setUpgradeOpen(false)} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Subcomponents                                                          */
/* ---------------------------------------------------------------------- */

/**
 * The model's key state — "Runs on your {label} key" when the runner has
 * the provider key, nothing for keyless providers (e.g. ollama), and a
 * warning when the model needs a key the runner hasn't connected yet (the
 * run gate 402s on that). (TIER DORMANCY: the old "Runs on the platform
 * key" badge died with the builder BYOK-only rule — wakes at Phase 3.)
 */
function ModelKeyBadge({
  state,
  onConnect,
}: {
  state: ReturnType<typeof modelKeyState>;
  onConnect: () => void;
}) {
  if (!state) return null;
  if (state.status === "none") return null;
  if (state.status === "connected") {
    return (
      <span className="rounded-full bg-green-100 px-2 py-1 text-[11px] font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
        Runs on your {state.providerLabel} key
      </span>
    );
  }
  return (
    <span className="text-[11px] text-amber-600 dark:text-amber-400">
      Needs your {state.providerLabel} key —{" "}
      {state.provider ? (
        <button
          type="button"
          onClick={onConnect}
          className="cursor-pointer underline underline-offset-2 hover:text-amber-800 dark:hover:text-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
        >
          connect one
        </button>
      ) : null}
    </span>
  );
}

/**
 * One palette row — a whole toolkit: checkbox + toolkit label + "N tools"
 * count + key badge + expand chevron. All tools in a real toolkit share
 * one credential contract (single-key toolkits have one field; multi-
 * credential ones like X have several), so the key badge derives once per
 * toolkit — from any member — and the Connect flow lives at the toolkit
 * level. The degenerate "Other tools" group can mix contracts, so its
 * header carries no badge — each row inside derives and owns its own.
 *
 * The checkbox is the easy toggle: check = all tools selected, uncheck =
 * none, partial = indeterminate (edit-mode snapshots carry partial
 * selections; the native checkbox needs a ref to set `indeterminate`).
 * The chevron is the drill-in: expand shows the toolkit's individual
 * tools as simple checked rows (BuilderToolRow — badge-free in real
 * toolkits, no cap state; the tool-level toggle is just a normal toggle).
 */
function ToolkitRow({
  group,
  checked,
  expanded,
  keyState,
  onToggle,
  onExpand,
  onConnect,
  renderTool,
}: {
  group: ToolkitGroup;
  /** Number of the group's tools currently selected — drives the
   *  checkbox's three states (all / partial / none). */
  checked: number;
  expanded: boolean;
  /** Null for the degenerate "Other tools" group — mixed credential
   *  contracts, so the header carries no badge (each row does). */
  keyState: ToolKeyState | null;
  onToggle: () => void;
  onExpand: () => void;
  onConnect: () => void;
  renderTool: (tool: BuilderToolOption) => React.ReactNode;
}) {
  const total = group.tools.length;
  const all = checked === total;
  const partial = checked > 0 && !all;
  const degenerate = group.toolkit === "";
  const inputRef = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = partial;
  };
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <input
          ref={inputRef}
          type="checkbox"
          checked={all}
          onChange={onToggle}
          // The degenerate group's label already says "tools" — appending
          // another would read "Select all Other tools tools".
          aria-label={
            degenerate
              ? `Select all ${group.label}`
              : `Select all ${group.label} tools`
          }
          className="h-4 w-4 shrink-0 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
        />
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span className="min-w-0 break-words font-medium text-zinc-900 dark:text-zinc-50">
            {group.label}
          </span>
          <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
            {total} tools
          </span>
        </button>
        {/* The degenerate group has no header badge — null keyState
            renders nothing; each row inside owns its own. */}
        {keyState && <KeyBadge state={keyState} onConnect={onConnect} />}
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${group.label}` : `Expand ${group.label}`}
          className="shrink-0 cursor-pointer rounded p-1 text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-zinc-300"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          >
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-700">
          {group.tools.map(renderTool)}
        </div>
      )}
    </div>
  );
}

/**
 * One expanded tool row inside a toolkit — checkbox + label on the
 * first line, the description clamped at two lines (ExpandableText —
 * "Show more / Show less" renders only when the text actually overflows)
 * indented beneath. Single-line by design: no cap state (the tools cap
 * is gone — many tools are a cost tradeoff, noted on the Tools header,
 * not a limit) and no key badge in real toolkits (the toolkit-level
 * badge carries the shared credential contract). Exception: the
 * degenerate "Other tools" group mixes credential contracts, so the
 * caller passes each row's own key state there and its Connect flow
 * opens the same KeyForm.
 */
function BuilderToolRow({
  tool,
  checked,
  onToggle,
  keyState,
  onConnect,
}: {
  tool: BuilderToolOption;
  checked: boolean;
  onToggle: () => void;
  /** Set only inside the degenerate "Other tools" group — real toolkits
   *  keep the shared toolkit-level badge and badge-free rows. */
  keyState?: ToolKeyState | null;
  onConnect?: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
        checked
          ? "border-blue-200 dark:border-blue-900"
          : "border-zinc-200 dark:border-zinc-700"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        aria-label={tool.label}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
      />
      <div className="min-w-0 flex-1">
        <span className="break-words font-medium text-zinc-900 dark:text-zinc-50">
          {tool.label}
        </span>
        {tool.description ? (
          <ExpandableText
            text={tool.description}
            lines={2}
            className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400"
          />
        ) : null}
      </div>
      {keyState ? (
        <KeyBadge state={keyState} onConnect={onConnect ?? (() => {})} />
      ) : null}
    </label>
  );
}

/**
 * The tool palette's key badge — per tool: no key (free), the runner's own
 * credentials connected, or missing credentials (the run gate 402s).
 */
function KeyBadge({
  state,
  onConnect,
}: {
  state: ReturnType<typeof toolKeyState>;
  onConnect: () => void;
}) {
  if (state.status === "none") return null;
  if (state.status === "connected") {
    return (
      <span className="ml-auto shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
        {state.providerLabel} key ✓
      </span>
    );
  }
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
        Needs your {state.providerLabel} key
      </span>
      {state.provider ? (
        <button
          type="button"
          onClick={onConnect}
          className="cursor-pointer text-[10px] underline underline-offset-2 hover:text-red-800 dark:hover:text-red-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
        >
          Connect
        </button>
      ) : null}
    </span>
  );
}

/**
 * The inline BYOK key form — the provider's credentials the runner is
 * missing. Renders one input per field of the provider's derived contract
 * (single-key providers have one; multi-credential toolkits like X have
 * several — every field is required, a partial contract can't be saved).
 * (The credentials catalog is the source of truth for labels; the
 * plaintext never leaves this form.)
 */
function KeyForm({
  meta,
  saving,
  error,
  onSave,
  onClose,
}: {
  meta: {
    kind: string;
    keyName: string;
    label: string;
    fields: { key: string; label: string }[];
  } | null;
  saving: boolean;
  error: string | null;
  onSave: (fields: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  if (!meta) return null;
  const fields = meta.fields.length > 0 ? meta.fields : [{ key: "api_key", label: "API key" }];
  const complete = fields.every((f) => (values[f.key] ?? "").trim().length > 0);
  // Trim on save for parity with the credentials page — a pasted key with
  // a trailing newline must not save broken here.
  const trimmedValues = () =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
  const setField = (key: string, value: string) =>
    setValues((prev) => ({ ...prev, [key]: value }));
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Connect {fields.length > 1 ? `${meta.label} credentials` : `a ${meta.label} key`}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {meta.kind === "tool"
              ? "Stored for your account — used by the agent's tool calls."
              : "Stored for your account — the agent runs on it."}
            {" "}
            <Link
              href="/app/credentials"
              className="underline"
            >
              Manage your API keys →
            </Link>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {fields.map((field) => (
          <input
            key={field.key}
            type="password"
            value={values[field.key] ?? ""}
            onChange={(e) => setField(field.key, e.target.value)}
            placeholder={`${meta.label} ${field.label}`}
            aria-label={`${meta.label} ${field.label}`}
            className={inputClass()}
          />
        ))}
        {error && (
          // Inline, right where the user is looking — the page-level
          // banner is several screens away from this form.
          <p className="text-[11px] text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={saving || !complete}
          onClick={() => onSave(trimmedValues())}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : fields.length > 1 ? "Save credentials" : "Save key"}
        </button>
      </div>
    </div>
  );
}

/**
 * The knowledge section header's key badge — the same three states as
 * ModelKeyBadge (connected → the green "runs on" chip; missing → the
 * amber demand + connect shortcut), minus the null case (the badge is
 * computed only when the capability is available and only rendered when
 * `show` — the dedupe against the model's badge lives in
 * knowledgeKeyBadge).
 */
function KnowledgeKeyBadgeView({
  badge,
  onConnect,
}: {
  badge: KnowledgeKeyBadge;
  onConnect: () => void;
}) {
  if (badge.connected) {
    return (
      <span className="rounded-full bg-green-100 px-2 py-1 text-[11px] font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
        Runs on your {badge.providerLabel} key
      </span>
    );
  }
  return (
    <span className="text-[11px] text-amber-600 dark:text-amber-400">
      Needs your {badge.providerLabel} key —{" "}
      {badge.provider ? (
        <button
          type="button"
          onClick={onConnect}
          className="cursor-pointer underline underline-offset-2 hover:text-amber-800 dark:hover:text-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
        >
          connect one
        </button>
      ) : null}
    </span>
  );
}

/**
 * One document row of the corpus — name + status chip (processing /
 * ready / partial / failed; no chip on a row predating a status write),
 * size, upload date, and delete-with-confirm. A failed row carries the
 * captured failure reason when the service stored one (agno's classified
 * ``status_message`` — e.g. an expired key's "authentication (HTTP 401)")
 * plus the re-upload guidance inline (the upload creates a NEW content
 * row — there is no resume, so the copy says so plainly).
 */
function KnowledgeDocRowView({
  doc,
  deleting,
  onDelete,
}: {
  doc: KnowledgeDocRow;
  deleting: boolean;
  onDelete: () => void;
}) {
  const chip = knowledgeStatusChip(doc.status);
  const size = knowledgeSizeLabel(doc.size);
  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-words font-medium text-zinc-900 dark:text-zinc-50">
          {doc.name}
        </span>
        {chip && (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chip.className}`}
          >
            {chip.label}
          </span>
        )}
        {size && <span className="shrink-0 text-xs text-zinc-400">{size}</span>}
        <span className="shrink-0 text-xs text-zinc-400">
          {knowledgeDateLabel(doc.createdAt)}
        </span>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      {doc.status === "failed" && (
        <div className="mt-1 space-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {doc.statusMessage ? (
            <p className="break-words">{doc.statusMessage}</p>
          ) : null}
          <p>{KNOWLEDGE_FAILED_HINT}</p>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  error,
  info,
  children,
  asGroup,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
  /** Optional hover tooltip on the header — a small ⓘ icon (the
   *  codebase's title-attribute pattern) next to the label. Used for the
   *  technical context/cost note on the Tools section (no cap). */
  info?: string;
  children: React.ReactNode;
  /** Checkbox-group variant: renders fieldset/legend instead of a label.
   *  REQUIRED for groups of checkboxes — a <label> wrapping them would
   *  wire the heading to the FIRST checkbox (clicking the title text
   *  toggles it; screen readers announce the whole group as that one
   *  control). */
  asGroup?: boolean;
}) {
  const title = (
    <>
      {label}
      {required && <span className="text-red-500"> *</span>}
      {info && (
        <span
          className="ml-1.5 cursor-help align-middle text-zinc-400"
          title={info}
        >
          ⓘ
        </span>
      )}
    </>
  );
  if (asGroup) {
    return (
      // min-w-0 matters: <fieldset> has a legacy UA rule (min-width:
      // min-content) that makes it refuse to shrink below its content's
      // text width — long nowrap-truncated rows (tool descriptions,
      // connector URLs) would blow the whole section out past the card
      // edge instead of truncating.
      <fieldset className="min-w-0 border-0 p-0">
        <legend className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {title}
        </legend>
        {children}
        {error && (
          <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">{error}</span>
        )}
        {hint && !error && (
          <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>
        )}
      </fieldset>
    );
  }
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {title}
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
    disabled ? "cursor-not-allowed opacity-60" : "",
  ].join(" ");
}

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
 *  - badges  → GET /api/models (platformTier), GET /api/credentials
 *             (hasKey per provider + catalog), GET /api/connectors
 *
 * The 402s the run gate produces (missing connector, missing BYOK key,
 * daily quota) surface at run time in the chat; this form front-loads
 * them: the model/tool badges show the key state and the connector
 * section carries the run-gate copy ("an org admin needs to add it before
 * the agent can run").
 */

import { useCallback, useEffect, useState } from "react";
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
  BUILDER_TOOLS_MAX,
  buildCreatePayload,
  catalogEmptyCopy,
  catalogErrorCopy,
  createBlockedByEmptyModels,
  buildEditPayload,
  extractErrorMessage,
  filterTools,
  findModel,
  groupModelsByProvider,
  modelKeyState,
  pickDefaultModel,
  prettySlug,
  providerMeta,
  staleModelCopy,
  sortTools,
  toolKeyState,
  validateBuilderForm,
  type BuilderFormState,
  type BuilderToolOption,
  type CredentialCatalog,
  type PlatformModel,
  type ToolKeyState,
} from "./builder-config";

export function BuilderForm({
  mode,
  agentId,
  onSaved,
  onDeleted,
  onCancel,
}: {
  mode: "create" | "edit";
  agentId?: string;
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

  const [models, setModels] = useState<PlatformModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [tools, setTools] = useState<BuilderToolOption[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  // Palette search — filters the rendered rows only. Selections live in
  // form.tools, so hiding a row never drops it from the agent's payload.
  const [toolQuery, setToolQuery] = useState("");
  // The catalog-failure Retry button's in-flight flag — without it the
  // click gives no feedback and a double-click fires duplicate fetches.
  const [retryingCatalog, setRetryingCatalog] = useState(false);
  const [credentials, setCredentials] = useState<{
    hasKey: Record<string, boolean>;
    catalog: CredentialCatalog;
  } | null>(null);
  const [connectors, setConnectors] = useState<PublicConnector[] | null>(null);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
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

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModelsError(extractErrorMessage(data, `Failed to load models (${res.status})`));
        return;
      }
      const list = Array.isArray(data.models) ? data.models : [];
      setModels(list);
      // Create mode: default to the first model (builder runs are 100% BYOK
      // — there is no platform-key free tier to prefer). Applied here (not an
      // effect) so the default lands as soon as the catalog arrives.
      if (mode === "create") {
        const def = pickDefaultModel(list);
        if (def)
          setForm((prev) =>
            prev.model ? prev : { ...prev, model: { provider: def.provider, id: def.id } },
          );
      }
    } catch {
      // Own-proxy failure — without this the dropdowns sit empty forever.
      setModelsError("Couldn't reach the server — try again shortly.");
    }
  }, [mode]);

  const loadCredentials = useCallback(async () => {
    try {
      const res = await fetch("/api/credentials");
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const hasKey: Record<string, boolean> = {};
      for (const c of Array.isArray(data.credentials) ? data.credentials : []) {
        hasKey[c.provider] = true;
      }
      setCredentials({ hasKey, catalog: data.catalog ?? {} });
    } catch {
      // Deliberate degradation: on a network failure the key badges read
      // "not saved" instead of stranding the form — the runner can retry
      // from the key form, which has its own error path.
    }
  }, []);

  const loadTools = useCallback(async () => {
    try {
      const res = await fetch("/api/tools");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setToolsError(extractErrorMessage(data, `Failed to load tools (${res.status})`));
        return;
      }
      // Sorted at load (not per render): the palette renders in the
      // deterministic (toolkit, label) order for the whole session.
      setTools(Array.isArray(data.tools) ? sortTools(data.tools) : []);
    } catch {
      // Own-proxy failure — without this the toolkit list sits empty forever.
      setToolsError("Couldn't reach the server — try again shortly.");
    }
  }, []);

  const loadConnectors = useCallback(async () => {
    try {
      const res = await fetch("/api/connectors");
      if (!res.ok) {
        // An outage is NOT the empty state: "No connectors yet" would be
        // a confident false claim (the org's connectors exist — the page
        // just can't see them). Leave connectors null; the palette
        // renders the error with a retry instead.
        setConnectorsError("Couldn't reach the server — please try again.");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
      setConnectorsError(null);
    } catch {
      setConnectorsError("Couldn't reach the server — please try again.");
    }
  }, []);

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

  useEffect(() => {
    if (isPending) return;
    // Wrapper indirection satisfies react-hooks/set-state-in-effect (the
    // loaders set state after their fetches resolve — same pattern as
    // users-admin).
    const load = async () => {
      loadCredentials();
      loadConnectors();
      await Promise.all([loadModels(), loadTools()]);
      if (mode === "edit") loadAgent();
    };
    load();
  }, [isPending, mode, loadModels, loadTools, loadCredentials, loadConnectors, loadAgent]);

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
  // The palette's rendered rows — the loaded catalog under the search
  // query. Empty list ≠ empty catalog: the no-match state is its own copy.
  const visibleTools = tools ? filterTools(tools, toolQuery) : [];
  // Cap reached — unchecked rows disable (the click would otherwise
  // silently no-op in toggleTool).
  const atToolCap = form.tools.length >= BUILDER_TOOLS_MAX;

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
      // Hard cap mirroring toggleConnector — without it the palette lets
      // a user check past BUILDER_TOOLS_MAX and validateBuilderForm then
      // rejects the submit with errors.tools, which nothing used to
      // render (silent no-op trap).
      if (prev.tools.length >= BUILDER_TOOLS_MAX) return prev;
      return { ...prev, tools: [...prev.tools, name] };
    });
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
      await loadCredentials();
      return true;
    } catch {
      setKeyError("Couldn't reach the server — please try again.");
      return false;
    } finally {
      setKeySaving(false);
    }
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
                // Errors stay up until the retry resolves (loadModels/
                // loadTools re-set them on failure; success lifts the
                // banner by setting the catalogs). Clearing them here
                // would flash the form enabled with empty dropdowns.
                setRetryingCatalog(true);
                void Promise.all([loadModels(), loadTools()]).finally(() =>
                  setRetryingCatalog(false),
                );
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
            proxied from the AgentOS /platform/tools). Adding a tool to
            the platform's allowlist shows up here with zero code.
            Search filters the rendered rows; the selection (form.tools)
            is unaffected — a hidden tool keeps its payload slot. */}
        <Field
          label="Tools"
          asGroup
          hint={
            form.tools.length > 0
              ? `${form.tools.length} of ${BUILDER_TOOLS_MAX} selected — the agent can use them at run time.`
              : `Up to ${BUILDER_TOOLS_MAX} — the agent can use them at run time.`
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
            {visibleTools.map((tool) => {
              const checked = form.tools.includes(tool.name);
              const keyState = toolKeyState(tool, credentials);
              return (
                <BuilderToolRow
                  key={tool.name}
                  tool={tool}
                  checked={checked}
                  disabled={!checked && atToolCap}
                  keyState={keyState}
                  onToggle={() => toggleTool(tool.name)}
                  onConnect={() => {
                    // Same guard KeyBadge renders by — only a catalog-known
                    // provider gets a Connect flow (a drifted slug would
                    // open an empty KeyForm).
                    if (keyState.status === "missing" && keyState.provider) {
                      openKeyForm(keyState.provider);
                    }
                  }}
                />
              );
            })}
            {toolsEmptyCopy && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{toolsEmptyCopy}</p>
            )}
            {tools !== null && tools.length > 0 && visibleTools.length === 0 && (
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
                  onClick={loadConnectors}
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
 * One palette row — two lines: checkbox + full name + key badge on the
 * first, the description clamped at two lines (ExpandableText — "Show
 * more / Show less" renders only when the text actually overflows)
 * indented beneath. The old single-line row squeezed name + description
 * against the key badge and truncated both into unreadable slivers;
 * stacking gives each its own room, and the checked-row border (the
 * platform-admin ToolRow's visual language) makes selections scan.
 *
 * Still one <label>: click anywhere toggles. The Show more/less and
 * Connect buttons are interactive content, which label activation
 * skips — they can't toggle the checkbox. The checkbox carries an
 * explicit aria-label so its accessible name is just the tool (the
 * label-derived name would read the whole description and the
 * expander's text aloud).
 *
 * `disabled` is the cap state — unchecked rows at BUILDER_TOOLS_MAX.
 * The checkbox disables with an explanatory title (the click would
 * otherwise silently no-op) and the row drops its pointer/hover
 * affordances since clicking it does nothing.
 */
function BuilderToolRow({
  tool,
  checked,
  disabled,
  keyState,
  onToggle,
  onConnect,
}: {
  tool: BuilderToolOption;
  checked: boolean;
  disabled: boolean;
  keyState: ToolKeyState;
  onToggle: () => void;
  onConnect: () => void;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
        disabled
          ? "cursor-not-allowed border-zinc-200 dark:border-zinc-700"
          : `cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
              checked
                ? "border-blue-200 dark:border-blue-900"
                : "border-zinc-200 dark:border-zinc-700"
            }`
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        title={
          disabled
            ? `Tool cap reached (${BUILDER_TOOLS_MAX}) — uncheck one to add another`
            : undefined
        }
        aria-label={tool.label}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
      />
      <div className="min-w-0 flex-1">
        {/* Name + key badge share the first line — the badge pins right
            and wraps below on a narrow row instead of squeezing the
            name, which never truncates. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words font-medium text-zinc-900 dark:text-zinc-50">
            {tool.label}
          </span>
          <KeyBadge state={keyState} onConnect={onConnect} />
        </div>
        {tool.description ? (
          <ExpandableText
            text={tool.description}
            lines={2}
            className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400"
          />
        ) : null}
      </div>
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

function Field({
  label,
  hint,
  required,
  error,
  children,
  asGroup,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
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

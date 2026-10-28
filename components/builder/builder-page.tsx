"use client";

/**
 * The agent builder — create + edit for builder-origin agents (Phase 1
 * "create your own agents"). Member-accessible: any signed-in org member
 * can build an agent on the platform AgentOS service — the runtime config
 * (endpoint + JWT) resolves from platform env at run time, so the form
 * only carries the definition (name/description/instructions + model +
 * tools + connectors).
 *
 * Wire contracts (server side lives in lib/agents/builder.ts):
 *  - create  → POST /api/agents/builder  {name, description, instructions,
 *             model:{provider,id}, tools:[{name}], connectors:[names]}
 *  - update  → PATCH /api/agents/builder/[id]  (all fields optional, at
 *             least one required; model/tools/connectors replace wholesale;
 *             the current instructions live in the AgentOS config, not the
 *             local GET response, so blank preserves them — the same
 *             blank-preserves pattern as agents.jwtSecret)
 *  - badges  → GET /api/models (platformTier), GET /api/credentials
 *             (hasKey per provider + catalog), GET /api/connectors
 *
 * The 402s the run gate produces (missing connector, missing BYOK key,
 * daily quota) surface at run time in the chat; this page front-loads
 * them: the model/tool badges show the key state and the connector
 * section carries the run-gate copy ("an org admin needs to add it before
 * the agent can run").
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PublicAgent } from "@/lib/agents/agents.config";
import type { PublicConnector } from "@/lib/connectors/connector-store";
import { BackToChat } from "@/components/back-to-chat";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useBilling } from "@/lib/billing/use-billing";
import {
  BUILDER_CONNECTORS_MAX,
  BUILDER_TOOLS_MAX,
  buildCreatePayload,
  buildUpdatePayload,
  catalogEmptyCopy,
  createBlockedByEmptyModels,
  extractErrorMessage,
  findModel,
  groupModelsByProvider,
  modelKeyState,
  pickDefaultModel,
  providerForDepKeyInCatalog,
  providerMeta,
  toolKeyState,
  validateBuilderForm,
  type BuilderFormState,
  type BuilderToolOption,
  type CredentialCatalog,
  type PlatformModel,
} from "./builder-config";

export function BuilderPage({
  mode,
  agentId,
}: {
  mode: "create" | "edit";
  agentId?: string;
}) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { config } = useAuthConfig();
  const { canManage } = useCanManageAgents();
  const { billing } = useBilling();

  const [models, setModels] = useState<PlatformModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [tools, setTools] = useState<BuilderToolOption[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<{
    hasKey: Record<string, boolean>;
    catalog: CredentialCatalog;
  } | null>(null);
  const [connectors, setConnectors] = useState<PublicConnector[] | null>(null);
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

  const currentUserId = session?.user.id ?? config?.user?.id ?? null;

  /* -------------------------------------------------------------------- */
  /* Data loading                                                          */
  /* -------------------------------------------------------------------- */

  const loadModels = useCallback(async () => {
    const res = await fetch("/api/models");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setModelsError(extractErrorMessage(data, `Failed to load models (${res.status})`));
      return;
    }
    const list = Array.isArray(data.models) ? data.models : [];
    setModels(list);
    // Create mode: default to a platform-tier model (mini-tier models run
    // on the platform key — no BYOK needed); non-tier models need a
    // runner key. Applied here (not an effect) so the default lands as
    // soon as the catalog arrives.
    if (mode === "create") {
      const def = pickDefaultModel(list);
      if (def)
        setForm((prev) =>
          prev.model ? prev : { ...prev, model: { provider: def.provider, id: def.id } },
        );
    }
  }, [mode]);

  const loadCredentials = useCallback(async () => {
    const res = await fetch("/api/credentials");
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const hasKey: Record<string, boolean> = {};
    for (const c of Array.isArray(data.credentials) ? data.credentials : []) {
      hasKey[c.provider] = true;
    }
    setCredentials({ hasKey, catalog: data.catalog ?? {} });
  }, []);

  const loadTools = useCallback(async () => {
    const res = await fetch("/api/tools");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setToolsError(extractErrorMessage(data, `Failed to load tools (${res.status})`));
      return;
    }
    setTools(Array.isArray(data.tools) ? data.tools : []);
  }, []);

  const loadConnectors = useCallback(async () => {
    const res = await fetch("/api/connectors");
    if (!res.ok) {
      setConnectors([]);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
  }, []);

  const loadAgent = useCallback(async () => {
    if (!agentId) return;
    const res = await fetch(`/api/agents/${agentId}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAgentError(extractErrorMessage(data, "Agent not found"));
      return;
    }
    setAgent(data);
    // Prefill the edit form from the agent's requirements snapshot. The
    // instructions are NOT in the local GET response — they live in the
    // AgentOS component config, so the field starts blank with the
    // "(leave blank to keep current)" semantics (same pattern as the
    // admin form's write-only jwtSecret).
    const req = (data as PublicAgent | undefined)?.requirements;
    setForm({
      name: (data as PublicAgent).name,
      description: (data as PublicAgent).description,
      instructions: "",
      model: req ? { provider: req.model.provider, id: req.model.id } : null,
      tools: req?.tools.map((t) => t.name) ?? [],
      connectors: req?.connectors ?? [],
    });
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

  // Redirect to /login when there's no session and auth isn't disabled —
  // the builder is member-accessible, so the pages gate on the session.
  useEffect(() => {
    if (isPending || !config) return;
    if (!session && !config.authDisabled) router.push("/login");
  }, [isPending, session, config, router]);

  /* -------------------------------------------------------------------- */
  /* Derived                                                               */
  /* -------------------------------------------------------------------- */

  const isBuilder = mode === "create" || agent?.origin === "builder";
  const isAuthor =
    mode === "create" || (Boolean(agent) && agent?.authorUserId === currentUserId);
  // Non-builder / non-author agents are not addressable here — the backend
  // PATCH also 403s, this is the UI mirror (hide for others).
  const notAllowed = mode === "edit" && Boolean(agent) && (!isBuilder || !isAuthor);
  const groups = models ? groupModelsByProvider(models) : [];
  const selectedModel = form.model
    ? findModel(models ?? [], form.model.provider, form.model.id)
    : null;
  const modelState = modelKeyState(
    form.model
      ? { provider: form.model.provider, platformTier: selectedModel?.platformTier ?? false }
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
  // Edit mode is unaffected: the model is only sent when it changes.
  const createDisabled = createBlockedByEmptyModels(mode, models, modelsError);
  const modelsEmptyCopy = catalogEmptyCopy("models", models, modelsError);
  const toolsEmptyCopy = catalogEmptyCopy("tools", tools, toolsError);

  // The edit-mode baseline: the agent's stored definition (instructions are
  // blank-preserve, so they're not part of the diff).
  const original = agent?.requirements
    ? {
        name: agent.name,
        description: agent.description,
        instructions: "",
        model: { provider: agent.requirements.model.provider, id: agent.requirements.model.id },
        tools: agent.requirements.tools.map((t) => t.name),
        connectors: agent.requirements.connectors,
      }
    : null;

  /* -------------------------------------------------------------------- */
  /* Actions                                                               */
  /* -------------------------------------------------------------------- */

  const updateForm = (patch: Partial<BuilderFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const toggleTool = (name: string) => {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(name) ? prev.tools.filter((t) => t !== name) : [...prev.tools, name],
    }));
  };

  const toggleConnector = (name: string) => {
    setForm((prev) => {
      if (prev.connectors.includes(name))
        return { ...prev, connectors: prev.connectors.filter((c) => c !== name) };
      if (prev.connectors.length >= BUILDER_CONNECTORS_MAX) return prev;
      return { ...prev, connectors: [...prev.connectors, name] };
    });
  };

  const saveKey = async (provider: string, secret: string) => {
    setKeySaving(true);
    try {
      const res = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, secret }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(extractErrorMessage(data, "Failed to save the key"));
        return false;
      }
      await loadCredentials();
      return true;
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
        mode === "create"
          ? buildCreatePayload(form)
          : buildUpdatePayload(form, original ?? form);
      // Edit mode with no changes → nothing to publish, just open in chat.
      if (mode === "edit" && Object.keys(body).length === 0) {
        router.push(`/app?agent=${agentId}`);
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
      const saved = data as PublicAgent;
      router.push(`/app?agent=${saved.id}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!agentId) return;
    if (!confirm(`Delete agent "${agent?.name ?? agentId}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/agents/builder/${agentId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(extractErrorMessage(data, "Delete failed"));
      return;
    }
    router.push("/app/builder");
  };

  /* -------------------------------------------------------------------- */
  /* Render                                                                */
  /* -------------------------------------------------------------------- */

  if (isPending || !config || (!session && !config.authDisabled) || (mode === "edit" && !agent && !agentError)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }

  if (notAllowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {isBuilder
              ? "You can only edit agents you created."
              : "Agent not found."}
          </p>
          <Link
            href="/app/builder"
            className="mt-3 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            Back to the agent builder
          </Link>
        </div>
      </div>
    );
  }

  if (agentError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{agentError}</p>
          <Link
            href="/app/builder"
            className="mt-3 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            Back to the agent builder
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-10">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              {mode === "create" ? "Agent builder" : `Edit ${agent?.name ?? "agent"}`}
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {mode === "create"
                ? "Create an agent that runs on the platform — no backend to host."
                : "Update the agent definition. Changes publish a new version."}
            </p>
          </div>
          <BackToChat />
        </header>

        {builderDisabled && (
          <div className="mb-6 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            {modelsError ?? toolsError}
          </div>
        )}

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <p>{error}</p>
            {planCap && !canManage && (
              <p className="mt-1 text-xs">
                An org admin needs to upgrade to add more agents.
              </p>
            )}
          </div>
        )}

        {mode === "create" && <YourAgents userId={currentUserId} />}

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
            hint={
              mode === "edit"
                ? "Leave blank to keep the current instructions — typing replaces them."
                : "The system prompt — how the agent behaves."
            }
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

          {/* Model picker */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Model" required error={errors.model}>
              <select
                value={form.model ? `${form.model.provider}:${form.model.id}` : ""}
                onChange={(e) => {
                  const [provider, id] = e.target.value.split(":");
                  updateForm({ model: provider && id ? { provider, id } : null });
                }}
                className={inputClass()}
              >
                <option value="">Select a model…</option>
                {groups.map((g) => (
                  <optgroup key={g.provider} label={g.provider}>
                    {g.models.map((m) => (
                      <option key={m.id} value={`${m.provider}:${m.id}`}>
                        {m.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {modelsEmptyCopy && (
                <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {modelsEmptyCopy}
                </p>
              )}
            </Field>
            <div className="flex items-end">
              <ModelKeyBadge state={modelState} onConnect={() => setKeyProvider(form.model?.provider ?? null)} />
            </div>
          </div>

          {/* Tool palette — the platform's tool catalog (GET /api/tools,
              proxied from the AgentOS /platform/tools). Adding a tool to
              the platform's allowlist shows up here with zero code. */}
          <Field label="Tools" hint={`Up to ${BUILDER_TOOLS_MAX} — the agent can use them at run time.`}>
            <div className="space-y-2">
              {(tools ?? []).map((tool) => {
                const checked = form.tools.includes(tool.name);
                const depProvider = tool.requiresKey
                  ? providerForDepKeyInCatalog(credentials?.catalog ?? {}, tool.requiresKey)
                  : null;
                return (
                  <label
                    key={tool.name}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTool(tool.name)}
                      className="h-4 w-4 rounded border-zinc-300 text-blue-600 dark:border-zinc-600"
                    />
                    <span className="font-medium text-zinc-900 dark:text-zinc-50">{tool.label}</span>
                    {tool.description ? (
                      <span className="truncate text-xs text-zinc-400">{tool.description}</span>
                    ) : null}
                    <KeyBadge
                      state={toolKeyState(tool, credentials)}
                      onConnect={() => setKeyProvider(depProvider)}
                    />
                  </label>
                );
              })}
              {toolsEmptyCopy && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{toolsEmptyCopy}</p>
              )}
            </div>
          </Field>

          {/* Connectors */}
          <Field label="Connectors" hint="MCP servers the agent can use at run time — managed by org admins.">
            <div className="space-y-2">
              {(connectors ?? []).length === 0 ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  No connectors yet.{" "}
                  {canManage ? (
                    <Link
                      href="/agents"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Add one on the Agents page →
                    </Link>
                  ) : (
                    "An org admin needs to add it before the agent can run."
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
                    <span className="font-medium text-zinc-900 dark:text-zinc-50">{c.name}</span>
                    <span className="truncate text-xs text-zinc-400">{c.url}</span>
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
                  : "Save changes"}
            </button>
            <Link
              href="/app"
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </Link>
            {mode === "edit" && (
              <button
                type="button"
                onClick={handleDelete}
                className="ml-auto rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
              >
                Delete agent
              </button>
            )}
          </div>
        </form>

        {keyProvider && credentials && (
          <KeyForm
            meta={providerMeta(credentials.catalog, keyProvider)}
            saving={keySaving}
            onSave={async (secret) => {
              const ok = await saveKey(keyProvider, secret);
              if (ok) setKeyProvider(null);
            }}
            onClose={() => setKeyProvider(null)}
          />
        )}

        {billing && canManage && (
          <UpgradeDialog open={upgradeOpen} onClose={() => setUpgradeOpen(false)} />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Subcomponents                                                          */
/* ---------------------------------------------------------------------- */

/**
 * The model's key state — "Runs on the platform key" for platform-tier
 * models (mini-tier models run on the platform key; SaaS deployments apply
 * a daily quota to platform-key runs), "Runs on your {label} key" when the
 * runner has the provider key, and a warning when the model needs a key
 * the runner hasn't connected yet (the run gate 402s on that).
 */
function ModelKeyBadge({
  state,
  onConnect,
}: {
  state: ReturnType<typeof modelKeyState>;
  onConnect: () => void;
}) {
  if (!state) return null;
  if (state.status === "platform") {
    return (
      <span className="rounded-full bg-green-100 px-2 py-1 text-[11px] font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
        Runs on the platform key — free-tier daily quota applies
      </span>
    );
  }
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
          className="underline"
        >
          connect one
        </button>
      ) : null}{" "}
      or pick a platform-tier model.
    </span>
  );
}

/**
 * The tool palette's key badge — per tool: no key (free), the runner's own
 * key, the platform fallback (missing key, but the platform carries an env
 * key — the run gate routes it to the platform key + daily quota), or a
 * missing key with no fallback (the run gate 402s).
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
  if (state.status === "fallback") {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          No {state.providerLabel} key — runs on the platform key
        </span>
        <button
          type="button"
          onClick={onConnect}
          className="text-[10px] underline"
        >
          Connect
        </button>
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
          className="text-[10px] underline"
        >
          Connect
        </button>
      ) : null}
    </span>
  );
}

/**
 * The inline BYOK key form — the provider's key the runner is missing.
 * (The credentials catalog is the source of truth for labels; the
 * plaintext never leaves this form.)
 */
function KeyForm({
  meta,
  saving,
  onSave,
  onClose,
}: {
  meta: { kind: string; keyName: string; label: string } | null;
  saving: boolean;
  onSave: (secret: string) => void;
  onClose: () => void;
}) {
  const [secret, setSecret] = useState("");
  if (!meta) return null;
  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Connect a {meta.label} key
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
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={`${meta.label} API key`}
          className={inputClass()}
        />
        <button
          type="button"
          disabled={saving || !secret}
          onClick={() => onSave(secret)}
          className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save key"}
        </button>
      </div>
    </div>
  );
}

/**
 * The author's own builder agents — the discovery surface for the edit
 * page (/app/builder/[id]), shown on the create page.
 */
function YourAgents({ userId }: { userId: string | null }) {
  const [agents, setAgents] = useState<PublicAgent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/agents");
      if (cancelled || !res.ok) {
        setAgents([]);
        return;
      }
      const list: PublicAgent[] = await res.json();
      setAgents(
        list.filter((a) => a.origin === "builder" && a.authorUserId === userId),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);
  if (!agents || agents.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Your agents ({agents.length})
      </h2>
      <ul className="space-y-2">
        {agents.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                {a.name}
              </p>
              <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {a.description}
              </p>
            </div>
            <Link
              href={`/app/builder/${a.id}`}
              className="shrink-0 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Edit
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required && <span className="text-red-500"> *</span>}
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
    disabled ? "opacity-60" : "",
  ].join(" ");
}

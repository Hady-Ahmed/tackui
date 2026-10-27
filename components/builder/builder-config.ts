/**
 * Client-safe builder helpers — the agent builder page's pure logic.
 *
 * The server-side builder contract lives in lib/agents/builder.ts, which
 * imports node-only modules (jsonwebtoken, the db) — it can't be imported
 * from client components. This module mirrors the parts the builder UI
 * needs: the tool palette wire shape (the palette itself is dynamic —
 * loaded from GET /api/tools, which proxies the AgentOS /platform/tools
 * catalog), the wire shapes for the builder create/update requests, and
 * the validation helpers. Keep in sync with lib/agents/builder.ts — a
 * drift here is a form that sends the wrong shape (the server re-validates
 * with zod, so a mismatch surfaces as a 400, but the form should never
 * send one).
 */

/** One model from GET /api/models (the AgentOS platform catalog). */
export interface PlatformModel {
  provider: string;
  id: string;
  platformTier: boolean;
}

/**
 * One tool from GET /api/tools — the platform tool palette (the AgentOS
 * is the single source of truth; there is no hardcoded list here). The
 * wire shape mirrors lib/agents/builder.ts `AgentosTool`, converted to
 * camelCase by the /api/tools route. `requiresKey` is the AG-UI context
 * dep key (e.g. "tavily_api_key"); the credentials catalog (GET
 * /api/credentials) maps dep keys to providers via `keyName`.
 * `platformFallback` = the platform carries an env key for the tool, so
 * a missing runner key is allowed (the run gate routes it to the
 * platform key + daily quota).
 */
export interface BuilderToolOption {
  name: string;
  label: string;
  description?: string | null;
  requiresKey: string | null;
  platformFallback: boolean;
}

/** Wire caps from the builder create/update schemas. */
export const BUILDER_TOOLS_MAX = 10;
export const BUILDER_CONNECTORS_MAX = 10;

/** One entry of the credentials catalog (GET /api/credentials). */
export interface CredentialMeta {
  kind: "llm" | "tool";
  keyName: string;
  label: string;
}

export type CredentialCatalog = Record<string, CredentialMeta>;

export interface CredentialsState {
  /** provider → hasKey (existence only — the plaintext never leaves). */
  hasKey: Record<string, boolean>;
  catalog: CredentialCatalog;
}

/** The builder form state (pre-serialization). */
export interface BuilderFormState {
  name: string;
  description: string;
  instructions: string;
  /** provider + id only — platformTier is re-derived server-side. */
  model: { provider: string; id: string } | null;
  tools: string[];
  connectors: string[];
}

/** The POST /api/agents/builder body shape (zod-validated server-side). */
export interface BuilderCreateWire {
  name: string;
  description: string;
  instructions: string;
  model: { provider: string; id: string };
  tools: { name: string }[];
  connectors: string[];
}

/**
 * The PATCH /api/agents/builder/[id] body shape — all fields optional,
 * model/tools/connectors replace wholesale. `instructions` is only sent
 * when the user typed one (the current instructions live on the AgentOS
 * component config, not the local row — blank preserves them).
 */
export type BuilderUpdateWire = {
  name?: string;
  description?: string;
  instructions?: string;
  model?: { provider: string; id: string };
  tools?: { name: string }[];
  connectors?: string[];
};

/** Models grouped by provider, sorted by provider then model id. */
export function groupModelsByProvider(models: PlatformModel[]): {
  provider: string;
  models: PlatformModel[];
}[] {
  const byProvider = new Map<string, PlatformModel[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  return Array.from(byProvider.entries())
    .map(([provider, group]) => ({
      provider,
      models: [...group].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Default selection: the first platform-tier model (mini-tier models run
 * on the platform key — free for the runner's own quota, no BYOK needed);
 * anything else requires a runner key. Falls back to the first model.
 */
export function pickDefaultModel(models: PlatformModel[]): PlatformModel | null {
  return models.find((m) => m.platformTier) ?? models[0] ?? null;
}

/**
 * Empty-catalog copy for the builder form. The platform catalogs are empty
 * BY DEFAULT — an operator who hasn't set PLATFORM_MODELS/PLATFORM_TOOLS
 * gets a builder that offers nothing, which is a configuration state, not
 * an error. Returns the empty-state copy when the catalog loaded
 * successfully but is empty; null while loading, when populated, or when
 * the fetch failed (the unreachable banner covers that case).
 *
 * Copy says "the agent platform", never "your agent platform" — SaaS end
 * users don't own the platform, and possessives imply they do.
 */
export function catalogEmptyCopy(
  kind: "models" | "tools",
  catalog: unknown[] | null,
  error: string | null,
): string | null {
  if (error !== null || catalog === null || catalog.length > 0) return null;
  return kind === "models"
    ? "The agent platform exposes no models yet. The platform operator adds them via PLATFORM_MODELS (see the platform README)."
    : "The agent platform exposes no tools yet. The platform operator can add them via PLATFORM_TOOLS (see the platform README).";
}

/**
 * Whether create must stay disabled because the model catalog is empty —
 * the model field is required, so an empty catalog can't produce a valid
 * create. Edit mode is unaffected: the model is only sent when it changes.
 */
export function createBlockedByEmptyModels(
  mode: "create" | "edit",
  models: PlatformModel[] | null,
  error: string | null,
): boolean {
  return mode === "create" && models !== null && models.length === 0 && error === null;
}

export function findModel(
  models: PlatformModel[],
  provider: string,
  id: string,
): PlatformModel | null {
  return models.find((m) => m.provider === provider && m.id === id) ?? null;
}

export function providerMeta(
  catalog: CredentialCatalog,
  provider: string,
): CredentialMeta | null {
  return catalog[provider] ?? null;
}

/** The credential provider that owns a dep key ("tavily_api_key" → "tavily"). */
export function providerForDepKey(
  catalog: CredentialCatalog,
  keyName: string,
): string | null {
  for (const [provider, meta] of Object.entries(catalog)) {
    if (meta.keyName === keyName) return provider;
  }
  return null;
}

/**
 * Model key state — the badge copy under the model picker:
 * - "platform"   : platform-tier model, served by the platform key.
 * - "connected"  : non-tier model, runner has a key for the provider.
 * - "missing"    : non-tier model, runner has no key → the run gate 402s.
 */
export type ModelKeyState =
  | { status: "platform" }
  | { status: "connected"; providerLabel: string }
  | { status: "missing"; providerLabel: string; provider: string | null };

export function modelKeyState(
  model: { provider: string; platformTier: boolean } | null,
  credentials: CredentialsState | null,
): ModelKeyState | null {
  if (!model) return null;
  if (model.platformTier) return { status: "platform" };
  const meta = credentials ? providerMeta(credentials.catalog, model.provider) : null;
  const hasKey = credentials?.hasKey[model.provider] ?? false;
  const providerLabel = meta?.label ?? model.provider;
  return hasKey
    ? { status: "connected", providerLabel }
    : { status: "missing", providerLabel, provider: meta ? model.provider : null };
}

/**
 * Tool key state — the badge on the tool palette row:
 * - "none"      : free tool, no key.
 * - "connected" : the runner's own key satisfies the dep.
 * - "fallback"  : missing key, but the platform fallback serves it
 *                 (platform-key daily quota applies on SaaS).
 * - "missing"   : missing key and no fallback → the run gate 402s.
 */
export type ToolKeyState =
  | { status: "none" }
  | { status: "connected"; providerLabel: string }
  | { status: "fallback"; providerLabel: string }
  | { status: "missing"; providerLabel: string; provider: string | null };

export function toolKeyState(
  tool: BuilderToolOption,
  credentials: CredentialsState | null,
): ToolKeyState {
  if (!tool.requiresKey) return { status: "none" };
  const provider = credentials ? providerForDepKey(credentials.catalog, tool.requiresKey) : null;
  const meta = credentials && provider ? providerMeta(credentials.catalog, provider) : null;
  const providerLabel = meta?.label ?? tool.requiresKey;
  if (credentials?.hasKey[provider ?? ""]) {
    return { status: "connected", providerLabel };
  }
  return tool.platformFallback
    ? { status: "fallback", providerLabel }
    : { status: "missing", providerLabel, provider };
}

/**
 * Client-side validation — mirrors the builder zod schemas (name ≤100,
 * description ≤300, instructions ≤8000, all required on create). In edit
 * mode instructions may be blank (blank preserves the stored ones).
 */
export function validateBuilderForm(
  form: BuilderFormState,
  mode: "create" | "edit",
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = "Name is required";
  else if (form.name.trim().length > 100) errors.name = "Name must be 100 characters or fewer";
  if (!form.description.trim()) errors.description = "Description is required";
  else if (form.description.trim().length > 300)
    errors.description = "Description must be 300 characters or fewer";
  if (!form.instructions.trim()) {
    // Edit mode: blank preserves the stored instructions (the AgentOS
    // config is the source of truth — the local GET doesn't carry it).
    if (mode === "create") errors.instructions = "Instructions are required";
  } else if (form.instructions.trim().length > 8000)
    errors.instructions = "Instructions must be 8000 characters or fewer";
  if (!form.model || !form.model.provider || !form.model.id)
    errors.model = "Pick a model";
  if (form.tools.length > BUILDER_TOOLS_MAX) errors.tools = "Too many tools";
  if (form.connectors.length > BUILDER_CONNECTORS_MAX)
    errors.connectors = "Too many connectors";
  return errors;
}

/** Serialize the form to the POST /api/agents/builder body. */
export function buildCreatePayload(form: BuilderFormState): BuilderCreateWire {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    instructions: form.instructions.trim(),
    model: form.model ?? { provider: "", id: "" },
    tools: form.tools.map((name) => ({ name })),
    connectors: form.connectors,
  };
}

/**
 * Serialize the changed subset of the form to the PATCH body. Blank
 * instructions on edit are omitted (preserve); model/tools/connectors
 * are only included when they differ from the original.
 */
export function buildUpdatePayload(
  form: BuilderFormState,
  original: BuilderFormState,
): BuilderUpdateWire {
  const patch: BuilderUpdateWire = {};
  if (form.name.trim() !== original.name.trim()) patch.name = form.name.trim();
  if (form.description.trim() !== original.description.trim())
    patch.description = form.description.trim();
  const instructions = form.instructions.trim();
  if (instructions) patch.instructions = instructions;
  if (form.model?.provider !== original.model?.provider || form.model?.id !== original.model?.id)
    patch.model = form.model ?? { provider: "", id: "" };
  if (
    form.tools.length !== original.tools.length ||
    [...form.tools].sort().join(",") !== [...original.tools].sort().join(",")
  )
    patch.tools = form.tools.map((name) => ({ name }));
  if (
    form.connectors.length !== original.connectors.length ||
    [...form.connectors].sort().join(",") !== [...original.connectors].sort().join(",")
  )
    patch.connectors = form.connectors;
  return patch;
}

/**
 * Build a user-facing error message from a route error response. Zod
 * rejections come back as `{ error: "Validation failed", details: {
 * fieldErrors: { field: [msgs] } } }` — surface the per-field messages
 * instead of the bare header.
 */
export function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data !== "object" || data === null) return fallback;
  const record = data as { error?: unknown; details?: unknown };
  const details = record.details;
  if (typeof details === "object" && details !== null) {
    const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
    if (typeof fieldErrors === "object" && fieldErrors !== null) {
      const parts = Object.entries(fieldErrors as Record<string, unknown>)
        .map(([field, msgs]) => {
          if (!Array.isArray(msgs) || msgs.length === 0) return null;
          return `${field}: ${String(msgs[0])}`;
        })
        .filter((part): part is string => part !== null);
      if (parts.length) return parts.join(" · ");
    }
  }
  return typeof record.error === "string" && record.error ? record.error : fallback;
}

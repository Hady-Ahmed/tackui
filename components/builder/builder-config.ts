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
  /**
   * Dormant for builder runs (100% BYOK; wakes at Phase 3 publishing) —
   * kept in the wire so the future needs no shape change. The badge logic
   * deliberately ignores it today.
   */
  platformTier: boolean;
  /** false for keyless providers (e.g. ollama) — no credential demanded. */
  requiresKey: boolean;
  /**
   * The vendor's declared dep key (e.g. "openai_api_key") — both of one
   * vendor's API doors share the vendor's single credential. Null for
   * keyless providers.
   */
  depKey: string | null;
}

/**
 * One tool from GET /api/tools — the platform tool palette (the AgentOS
 * is the single source of truth; there is no hardcoded list here). The
 * wire shape mirrors lib/agents/builder.ts `AgentosTool`, converted to
 * camelCase by the /api/tools route. `requiresKey` is the AG-UI context
 * dep key of the FIRST credential (null = keyless); `credentials` is the
 * full contract — multi-credential toolkits (the X toolkit) carry several.
 * `toolkit` is the provider slug the credentials are saved under.
 * `platformFallback` is DORMANT (builder runs are 100% BYOK; wakes at
 * Phase 3 publishing) — the badge logic ignores it today.
 */
export interface BuilderToolOption {
  name: string;
  label: string;
  description?: string | null;
  requiresKey: string | null;
  platformFallback: boolean;
  toolkit: string;
  credentials: { depKey: string; label: string }[];
}

/** Wire caps from the builder create/update schemas. */
export const BUILDER_TOOLS_MAX = 10;
export const BUILDER_CONNECTORS_MAX = 10;

/** One entry of the credentials catalog (GET /api/credentials). */
export interface CredentialMeta {
  kind: "llm" | "tool";
  keyName: string;
  label: string;
  /** The named fields the connect form renders (multi-credential → several). */
  fields: { key: string; label: string }[];
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
 * Default selection: the first model. (TIER DORMANCY — the old "prefer a
 * platform-tier model" default died with the platform-key free tier; builder
 * runs are 100% BYOK, so every model is equal until Phase 3 publishing.)
 */
export function pickDefaultModel(models: PlatformModel[]): PlatformModel | null {
  return models[0] ?? null;
}

/**
 * Empty-catalog copy for the builder form. The platform catalogs are empty
 * BY DEFAULT — an admin who hasn't enabled anything in the platform admin
 * page gets a builder that offers nothing, which is a configuration state,
 * not an error. Returns the empty-state copy when the catalog loaded
 * successfully but is empty; null while loading, when populated, or when
 * the fetch failed (the unreachable banner covers that case).
 *
 * Copy says "the agent builder", never "the agent platform" or "AgentOS"
 * — and never possessives ("your agent platform"): SaaS end users don't
 * own the platform, and possessives imply they do.
 */
export function catalogEmptyCopy(
  kind: "models" | "tools",
  catalog: unknown[] | null,
  error: string | null,
): string | null {
  if (error !== null || catalog === null || catalog.length > 0) return null;
  return kind === "models"
    ? "The agent builder has no models yet — a platform admin enables them in Models & tools."
    : "The agent builder has no tools yet — a platform admin enables them in Models & tools.";
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

/**
 * Notice for the model picker when the agent's saved model is no longer
 * in the catalog — the operator removed it, or the fail-closed drop
 * discarded a slug-mismatched entry (the platform keeps only servable
 * models). The form keeps the stale model — the PATCH only sends the
 * model when it changes, so the agent keeps its definition until the
 * user picks a replacement — but the select can't show it as an offered
 * option, so the picker explains the gap.
 */
export function staleModelCopy(
  model: { provider: string; id: string } | null,
  models: PlatformModel[] | null,
  error: string | null,
): string | null {
  if (error !== null || models === null || !model) return null;
  // An EMPTY catalog is not "removed" — the deployment simply hasn't
  // enabled any providers yet (the documented first-run state). The
  // empty-catalog notice owns that copy; a removal claim here would be
  // false (nothing can be picked to replace it either).
  if (models.length === 0) return null;
  if (findModel(models, model.provider, model.id)) return null;
  return `The agent's saved model (${model.provider}:${model.id}) is no longer offered by the platform. Pick a different one to replace it — saving other changes keeps the old model.`;
}

export function providerMeta(
  catalog: CredentialCatalog,
  provider: string,
): CredentialMeta | null {
  return catalog[provider] ?? null;
}

/**
 * The credential provider that owns a dep key ("tavily_api_key" → "tavily")
 * — a catalog LOOKUP (a key name not in the catalog → null), unlike the
 * mechanical slug derivation of the same name in lib/credentials/catalog.
 * Distinct name: the two are NOT interchangeable (mechanical derivation
 * never returns null; the catalog lookup can).
 */
export function providerForDepKeyInCatalog(
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
 * - "none"      : keyless provider (e.g. ollama) — nothing to connect.
 * - "connected" : runner has a key for the provider.
 * - "missing"   : runner has no key → the run gate 402s.
 * (TIER DORMANCY: the old "platform" badge — served by the platform key —
 * died with the builder BYOK-only rule; every keyed model is connected or
 * missing. Wakes at Phase 3 publishing.)
 */
export type ModelKeyState =
  | { status: "none" }
  | { status: "connected"; providerLabel: string }
  | { status: "missing"; providerLabel: string; provider: string | null };

export function modelKeyState(
  model: {
    provider: string;
    platformTier: boolean;
    requiresKey: boolean;
    depKey: string | null;
  } | null,
  credentials: CredentialsState | null,
): ModelKeyState | null {
  if (!model) return null;
  if (!model.requiresKey) return { status: "none" };
  if (!model.depKey) {
    // A keyed model without a declared dep key is a version-skew or
    // broken-platform-row case (the live catalog always declares one).
    // Never slug-guess the vendor — the honest UI is "can't run": show
    // missing with no connect form (the run gate 402s the run anyway).
    return { status: "missing", providerLabel: model.provider, provider: null };
  }
  // The credential lives under the VENDOR, not the door slug: one vendor's
  // API doors (openai-chat + openai-responses) collapse into the vendor's
  // single catalog entry, so resolve the credential provider from the
  // declared dep key ("<dep>_api_key" → vendor).
  const credentialProvider = model.depKey.replace(/_api_key$/, "");
  const meta = credentials
    ? providerMeta(credentials.catalog, credentialProvider)
    : null;
  const hasKey = credentials?.hasKey[credentialProvider] ?? false;
  const providerLabel = meta?.label ?? model.provider;
  return hasKey
    ? { status: "connected", providerLabel }
    : { status: "missing", providerLabel, provider: meta ? credentialProvider : null };
}

/**
 * Tool key state — the badge on the tool palette row:
 * - "none"      : free tool, no key.
 * - "connected" : the runner's own credentials satisfy the contract.
 * - "missing"   : missing credentials → the run gate 402s.
 * (TIER DORMANCY: the old "fallback" badge — platform key serves it — is
 * gone; builder runs are 100% BYOK. Wakes at Phase 3 publishing.)
 */
export type ToolKeyState =
  | { status: "none" }
  | { status: "connected"; providerLabel: string }
  | { status: "missing"; providerLabel: string; provider: string | null };

export function toolKeyState(
  tool: BuilderToolOption,
  credentials: CredentialsState | null,
): ToolKeyState {
  if (!tool.requiresKey) return { status: "none" };
  // The toolkit slug is the provider; the keyName catalog lookup stays as
  // the fallback for shapes without a slug.
  const provider =
    tool.toolkit ||
    (credentials ? providerForDepKeyInCatalog(credentials.catalog, tool.requiresKey) : null);
  const meta = credentials && provider ? providerMeta(credentials.catalog, provider) : null;
  const providerLabel = meta?.label ?? tool.requiresKey;
  if (credentials?.hasKey[provider ?? ""]) {
    return { status: "connected", providerLabel };
  }
  // Only surface a provider for the Connect flow when the credentials
  // catalog knows it — a toolkit slug that drifted out of the catalog
  // would otherwise render a Connect button that opens an empty KeyForm
  // (dead click). Mirrors modelKeyState's guard above.
  return { status: "missing", providerLabel, provider: meta ? provider : null };
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
    errors.model = "Pick a provider and model";
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
 * The PATCH body for an edit-mode save. `original` is the form as loaded
 * from the agent's snapshot — **null when the row has no snapshot** (the
 * stored requirements failed to parse and were dropped at read).
 *
 * A snapshot-less row can only be config-patched with a FULL config
 * (model + tools + connectors): the server 409s a partial patch because
 * there is nothing to re-derive the missing halves from — and a diff that
 * happened to include one tool would silently destroy the agent's real
 * tool set. So the save sends the complete wire: "open it in the agent
 * builder and save it again" (the run gate's remedy for a stale snapshot)
 * works even with zero edits.
 */
export function buildEditPayload(
  form: BuilderFormState,
  original: BuilderFormState | null,
): BuilderCreateWire | BuilderUpdateWire {
  return original ? buildUpdatePayload(form, original) : buildCreatePayload(form);
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

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

/**
 * Wire caps from the builder create/update schemas. Only connectors are
 * capped now — the tools cap was removed because a single toolkit carries
 * 30+ tools (the palette groups by toolkit instead; an info note on the
 * Tools header explains the context/cost tradeoff).
 */
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
 * Key-aware default selection (create mode): the first model whose
 * provider credential is already connected — catalog order, so the same
 * catalog yields the same default. A keyed model without its key 402s at
 * run time (a dead-end preselection), and with NO keys connected there is
 * no default at all: the select stays on "Select a provider…", because
 * the user's real next step is connecting a provider (the Connect
 * affordance is right under the picker). Keyless models (e.g. ollama) are
 * skipped too — "connected" means a key exists; preselection must always
 * be a runnable model with its credential in hand. (TIER DORMANCY — the
 * old "prefer a platform-tier model" default died with the platform-key
 * free tier; builder runs are 100% BYOK until Phase 3 publishing.)
 */
export function pickDefaultModel(
  models: PlatformModel[],
  hasKey: Record<string, boolean>,
): PlatformModel | null {
  for (const m of models) {
    if (!m.requiresKey || !m.depKey) continue;
    // Same vendor rule as modelKeyState: the credential lives under the
    // VENDOR (the dep key minus its "_api_key" suffix), not the model's
    // door slug.
    if (hasKey[m.depKey.replace(/_api_key$/, "")]) return m;
  }
  return null;
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
 * The disabled-builder banner copy — the models and tools catalog loads
 * fail independently (one 503, one 502), so genuinely distinct errors
 * join with the "·" separator and both display. But a single shared
 * failure (one 503 from agentosRequest) sets BOTH state slots to the
 * identical AgentosError message, and joining it twice renders the same
 * sentence twice — so identical messages collapse to one. Null when
 * nothing failed.
 */
export function catalogErrorCopy(
  modelsError: string | null,
  toolsError: string | null,
): string | null {
  const messages = [
    ...new Set([modelsError, toolsError].filter((e): e is string => e !== null)),
  ];
  return messages.length > 0 ? messages.join(" · ") : null;
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
  return `The agent's saved model (${model.provider}:${model.id}) is no longer offered by the agent builder. Pick a different one to replace it — saving other changes keeps the old model.`;
}

/** Display label derived from a provider slug — the shared, acronym-
 * correcting prettifier (lib/credentials/label.ts is client-safe, so the
 * fallback matches the catalog's labels exactly, "openai" → "OpenAI"
 * included). */
export { prettifyProviderLabel as prettySlug } from "@/lib/credentials/label";
import { prettifyProviderLabel as prettySlug } from "@/lib/credentials/label";

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
    // The door slug is prettified for display, never shown raw.
    return { status: "missing", providerLabel: prettySlug(model.provider), provider: null };
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
  const providerLabel = meta?.label ?? prettySlug(model.provider);
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
  // Never render the raw dep key — prettify the toolkit slug (or, when
  // even that is absent, the requiresKey dep) the way the credentials
  // page does. The raw form leaked in exactly the degraded states
  // (catalog fetch failed, slug drifted) where attention is highest.
  const providerLabel = meta?.label ?? prettySlug(tool.toolkit || tool.requiresKey);
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
 * The palette's display order: toolkit-mates adjacent, alphabetical
 * within each toolkit. The AgentOS allowlist order is upstream state
 * (toolkits append as admins enable them, order drifts between
 * deployments) — sorting here makes the palette deterministic: the same
 * toolkit's functions sit together and the list reads the same on every
 * load. Returns a new array; the input is untouched.
 */
export function sortTools(tools: BuilderToolOption[]): BuilderToolOption[] {
  return [...tools].sort(
    (a, b) =>
      (a.toolkit || "").localeCompare(b.toolkit || "") ||
      a.label.localeCompare(b.label),
  );
}

/**
 * One toolkit group of the palette — the toolkit's slug, its display
 * label (prettySlug — the same prettifier the key badges use), and the
 * toolkit's functions. All tools in a group share one credential
 * contract, so the toolkit-level key badge derives from any member.
 */
export interface ToolkitGroup {
  /** The toolkit slug — "" for the degenerate unslugged group (last). */
  toolkit: string;
  label: string;
  tools: BuilderToolOption[];
}

/**
 * The palette's toolkit structure — the display-layer view of what the
 * admin side already shapes (/admin/platform toggles whole toolkits).
 * Groups the catalog by `toolkit` slug, orders toolkits alphabetically
 * and functions alphabetically within each — the same deterministic
 * (toolkit, label) intent as the page-level sortTools, applied here so
 * the output is correct on its own (the form receives pre-sorted input,
 * but the grouping must not depend on that). Returns a new array; the
 * input is untouched. A tool with a missing/empty toolkit slug (a
 * platform shape drift — toolKeyState treats the same state as
 * degraded) lands in a degenerate group ordered LAST, so it can never
 * shadow a real toolkit; its label is honest about the grouping gap.
 */
export function groupToolsByToolkit(
  tools: BuilderToolOption[],
): ToolkitGroup[] {
  const groups = new Map<string, BuilderToolOption[]>();
  for (const tool of tools) {
    const slug = tool.toolkit || "";
    const list = groups.get(slug) ?? [];
    list.push(tool);
    groups.set(slug, list);
  }
  const byLabel = (g: BuilderToolOption[]) =>
    [...g].sort((a, b) => a.label.localeCompare(b.label));
  const named = Array.from(groups.entries())
    .filter(([slug]) => slug !== "")
    .map(([toolkit, g]): ToolkitGroup => ({
      toolkit,
      label: prettySlug(toolkit),
      tools: byLabel(g),
    }))
    .sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  const orphan = groups.get("");
  if (!orphan) return named;
  return [
    ...named,
    { toolkit: "", label: "Other tools", tools: byLabel(orphan) },
  ];
}

/**
 * Palette search — case-insensitive substring match on the label (the
 * human-facing name), the description (the summary text — arg/return
 * docs no longer reach the palette), and the toolkit (the
 * raw slug and its prettified label — searching "github" must surface
 * the GitHub toolkit even though its function labels read "Create an
 * issue"). An empty/whitespace query matches everything and returns the
 * input as-is (no array copy). Filtering is display-only: selections
 * live in form.tools, so a hidden tool keeps its slot in the payload.
 */
export function filterTools(
  tools: BuilderToolOption[],
  query: string,
): BuilderToolOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tools;
  return tools.filter(
    (tool) =>
      tool.label.toLowerCase().includes(needle) ||
      (tool.description ?? "").toLowerCase().includes(needle) ||
      tool.toolkit.toLowerCase().includes(needle) ||
      prettySlug(tool.toolkit).toLowerCase().includes(needle),
  );
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

/* ---------------------------------------------------------------------- */
/* Knowledge — the corpus management half of the builder form (#236)       */
/*                                                                        */
/* Pure logic only: the wire shapes (mirroring the #235 clients/routes —   */
/* KEEP IN SYNC), the capability-state branching, upload payload shaping,  */
/* status-chip mapping, and the key badge's dedupe against the model      */
/* badge. The node-only service contract stays in lib/agents/builder.ts.  */
/* ---------------------------------------------------------------------- */

/** The knowledge capability (GET /api/agents/[id]/knowledge/config —
 *  the member-accessible proxy of the service's capability signal). */
export interface KnowledgeCapability {
  enabled: boolean;
  provider: string;
  model: string;
  /** true = the service answered 404 (predates knowledge) — reachable
   *  but unsupported. Distinct from enabled=false, which is "answered,
   *  knowledge is off". */
  unsupported?: boolean;
}

/** One content row of the corpus (GET /api/agents/[id]/knowledge —
 *  camelCase, the #235 list route's shape; `status` is agno's
 *  ContentStatus or null on a row predating a status write;
 *  `statusMessage` is agno's classified failure reason, present only
 *  on failed rows — shown to the author so "Failed" is never bare). */
export interface KnowledgeDocRow {
  id: string;
  name: string;
  status: string | null;
  statusMessage?: string | null;
  size: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The upload allowlist — the SAME list the tackui route enforces
 * (app/api/agents/[id]/knowledge/route.ts ALLOWED_EXTENSIONS; the
 * service enforces it a second time). Mirrored here so the file picker's
 * `accept` and the pre-check copy match the enforced gate without a
 * server round-trip. Drift = a file the picker offered but the route
 * 400s — keep both lists identical.
 */
export const KNOWLEDGE_ACCEPT_EXTENSIONS = [
  ".pdf", ".csv", ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".json", ".md", ".txt",
];

/** The file input's `accept` attribute value. */
export const KNOWLEDGE_FILE_ACCEPT = KNOWLEDGE_ACCEPT_EXTENSIONS.join(",");

/** The upload byte cap — mirrors the route's 10 MB request cap. */
export const KNOWLEDGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** How often the doc list re-polls while any row is still processing
 *  (agno ingests async — processing can last seconds for big PDFs). */
export const KNOWLEDGE_POLL_MS = 5000;

/** Create-mode note — docs attach to a SAVED component, so the section
 *  itself only exists in edit mode. */
export const KNOWLEDGE_CREATE_NOTE =
  "Knowledge attaches after the agent is saved — save the agent first, then add documents.";

/** The failed row's remedy microcopy — the upload creates a NEW content
 *  row (there is no resume), so the fix is delete + re-upload. */
export const KNOWLEDGE_FAILED_HINT =
  "Processing failed — nothing was kept. Delete this document and upload it again (a re-upload creates a new one; there is no resume).";

/**
 * The capability gate's four states:
 * - loading       — the config fetch is in flight (render nothing yet).
 * - unreachable   — the fetch failed: the standard error banner, NOT a
 *                   "knowledge is off" claim (empty-vs-unreachable
 *                   distinction, same as the palette).
 * - hidden        — the service answered and knowledge is off (or the
 *                   deployment predates it): hidden with a one-line
 *                   explanation.
 * - available     — render the section.
 */
export type KnowledgeCapabilityState =
  | { kind: "loading" }
  | { kind: "unreachable"; error: string }
  | { kind: "hidden"; reason: "unsupported" | "disabled" }
  | { kind: "available"; provider: string; model: string };

export function knowledgeCapabilityState(
  capability: KnowledgeCapability | null,
  error: string | null,
): KnowledgeCapabilityState {
  if (error !== null) return { kind: "unreachable", error };
  if (capability === null) return { kind: "loading" };
  if (!capability.enabled) {
    return {
      kind: "hidden",
      reason: capability.unsupported ? "unsupported" : "disabled",
    };
  }
  return { kind: "available", provider: capability.provider, model: capability.model };
}

/** The one-line explanation for a hidden section — a configuration
 *  state, not an error (same honest copy discipline as the empty
 *  catalogs: "the agent builder", never possessives). */
export function knowledgeHiddenCopy(
  reason: "unsupported" | "disabled",
): string {
  return reason === "unsupported"
    ? "This deployment's agent builder predates knowledge — the knowledge section is unavailable here."
    : "Knowledge isn't offered on this deployment — a platform admin enables it in Models & tools.";
}

/**
 * Empty-corpus copy for the doc list — the no-docs state is its own copy
 * (not an error, not loading). Null while loading, when populated, or
 * when the list fetch failed (the unreachable banner covers that case).
 */
export function knowledgeListEmptyCopy(
  rows: KnowledgeDocRow[] | null,
  error: string | null,
): string | null {
  if (error !== null || rows === null || rows.length > 0) return null;
  return "No documents yet — add files, paste text, or a URL below.";
}

/** One status chip's display shape (the tool palette's chip styling). */
export interface KnowledgeStatusChip {
  label: string;
  className: string;
}

/**
 * Status-chip mapping — agno's ContentStatus values as the list route
 * delivers them: "processing" (ingest running), "completed" (→ Ready),
 * "partial" (some chunks embedded, searchable but incomplete), "failed",
 * or null (a row predating a status write). Null/unknown statuses get NO
 * chip rather than a guessed label; "partial" gets its own amber chip —
 * it is neither Ready nor Failed, and a "Ready" claim would be false.
 */
export function knowledgeStatusChip(
  status: string | null,
): KnowledgeStatusChip | null {
  switch (status) {
    case "processing":
      return {
        label: "Processing",
        className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
      };
    case "completed":
      return {
        label: "Ready",
        className: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
      };
    case "partial":
      return {
        label: "Partial",
        className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
      };
    default:
      return null;
  }
}

/**
 * Whether any row is still processing — the list poll's gate. ONLY
 * "processing" is pending: completed/partial/failed are settled states
 * (partial and failed never change without a re-upload), and null is
 * treated as settled too — polling forever on an unknown status would
 * never stop.
 */
export function hasProcessingDocs(rows: KnowledgeDocRow[]): boolean {
  return rows.some((r) => r.status === "processing");
}

/** Human-readable file size for a doc row; null when the service hasn't
 *  recorded a size yet (a processing row can predate the write). */
export function knowledgeSizeLabel(size: number | null): string | null {
  if (size === null || size < 0) return null;
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) {
    const label = kb < 10 ? String(Math.round(kb * 10) / 10) : String(Math.round(kb));
    return `${label} KB`;
  }
  return `${Math.round((kb / 1024) * 10) / 10} MB`;
}

/** The doc row's upload date (epoch seconds → a short date label). */
export function knowledgeDateLabel(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

/** The first problem with a picked file (extension/size), or null — the
 *  tackui route enforces the same gates; this pre-check gives instant
 *  feedback instead of a round-trip 400. */
export function knowledgeFileError(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  const suffix = dot > -1 ? file.name.slice(dot).toLowerCase() : "";
  if (!KNOWLEDGE_ACCEPT_EXTENSIONS.includes(suffix)) {
    return `“${file.name}” isn't a supported format — accepted: ${KNOWLEDGE_ACCEPT_EXTENSIONS.join(", ")}`;
  }
  if (file.size > KNOWLEDGE_MAX_UPLOAD_BYTES) {
    return `“${file.name}” exceeds the ${KNOWLEDGE_MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload cap.`;
  }
  return null;
}

/** The paste-text source's problems (empty text, over-cap), or null. */
export function knowledgeTextError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Add the text to upload first.";
  if (new TextEncoder().encode(trimmed).byteLength > KNOWLEDGE_MAX_UPLOAD_BYTES) {
    return `The text exceeds the ${KNOWLEDGE_MAX_UPLOAD_BYTES / (1024 * 1024)} MB request cap.`;
  }
  return null;
}

/** The URL source's problems, or null — shape only (absolute http(s));
 *  the SSRF guard stays server-side (the client can't and must not
 *  reimplement it). */
export function knowledgeUrlError(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return "Add a URL first.";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "The URL must start with http:// or https://";
    }
  } catch {
    return "The URL must be an absolute http(s) URL.";
  }
  return null;
}

/** The Advanced disclosure's chunk fields (parsed — both optional). */
export interface KnowledgeChunkFields {
  chunkSize?: number;
  chunkOverlap?: number;
}

export type KnowledgeChunkParse =
  | { ok: true; chunkSize?: number; chunkOverlap?: number }
  | { ok: false; error: string };

/**
 * Parse the Advanced disclosure's two number fields. Blank = OMITTED —
 * the service then applies agno's own defaults, which differ per chunker
 * (the fixed chunker defaults 5000/0; the page reader 2000), so the UI
 * shows blanks labelled "default" rather than inventing one number.
 * Whole-number and overlap<size checks mirror the route's validation.
 */
export function parseKnowledgeChunkFields(
  sizeText: string,
  overlapText: string,
): KnowledgeChunkParse {
  const trimmedSize = sizeText.trim();
  const trimmedOverlap = overlapText.trim();
  let chunkSize: number | undefined;
  let chunkOverlap: number | undefined;
  if (trimmedSize) {
    const n = Number(trimmedSize);
    if (!Number.isInteger(n)) return { ok: false, error: "Chunk size must be a whole number." };
    if (n < 1) return { ok: false, error: "Chunk size must be at least 1." };
    chunkSize = n;
  }
  if (trimmedOverlap) {
    const n = Number(trimmedOverlap);
    if (!Number.isInteger(n)) return { ok: false, error: "Chunk overlap must be a whole number." };
    if (n < 0) return { ok: false, error: "Chunk overlap must be 0 or more." };
    chunkOverlap = n;
  }
  if (chunkSize !== undefined && chunkOverlap !== undefined && chunkOverlap >= chunkSize) {
    return { ok: false, error: "Chunk overlap must be smaller than chunk size." };
  }
  return {
    ok: true,
    ...(chunkSize !== undefined ? { chunkSize } : {}),
    ...(chunkOverlap !== undefined ? { chunkOverlap } : {}),
  };
}

/** One upload's source — exactly one of file / text / url (the route's
 *  exactly-one gate). */
export type KnowledgeUploadSource =
  | { kind: "file"; file: File }
  | { kind: "text"; text: string; name: string }
  | { kind: "url"; url: string };

/**
 * The browser → tackui-route multipart body for one upload. Field names
 * are the tackui route's contract: `file` | `text` | `url` + optional
 * `name` + optional `chunkSize`/`chunkOverlap` (camelCase — the route
 * re-shapes them service-side and resolves the embedding key itself, so
 * the browser never carries one). Exactly one source field is ever set;
 * chunk fields ride every upload (the service applies them to files and
 * pasted text; URL ingest ignores them — agno's URL auto-detection).
 */
export function buildKnowledgeUploadForm(
  source: KnowledgeUploadSource,
  chunk?: KnowledgeChunkFields,
): FormData {
  const form = new FormData();
  if (source.kind === "file") {
    form.set("file", source.file, source.file.name);
  } else if (source.kind === "text") {
    form.set("text", source.text);
    if (source.name) form.set("name", source.name);
  } else {
    form.set("url", source.url);
  }
  if (chunk?.chunkSize !== undefined) form.set("chunkSize", String(chunk.chunkSize));
  if (chunk?.chunkOverlap !== undefined) form.set("chunkOverlap", String(chunk.chunkOverlap));
  return form;
}

/** The knowledge section header's key badge — tri-state like the tool
 *  badges, with the dedupe rule against the model's badge:
 *  - key connected + docs exist → the green "runs on" chip (the run
 *    embeds queries with it).
 *  - key connected + no docs → nothing (nothing uses the key yet).
 *  - key missing + the MODEL badge doesn't already demand the same
 *    provider's key → the "Needs your … key" badge + Connect shortcut
 *    (uploads need the key even with an empty corpus — it's the curation
 *    prerequisite — and runs need it once docs exist).
 *  - key missing + the model badge already demands the same key (an
 *    OpenAI model + OpenAI knowledge) → hidden: one identical line is
 *    the noise the dedupe exists to kill; the model badge's Connect
 *    flow fixes both.
 */
export interface KnowledgeKeyBadge {
  show: boolean;
  connected: boolean;
  providerLabel: string;
  /** Set only when the credentials catalog knows the provider — a
   *  drifted slug would open an empty KeyForm (dead click). Mirrors
   *  modelKeyState/toolKeyState's guard. */
  provider: string | null;
}

export function knowledgeKeyBadge(
  docs: KnowledgeDocRow[] | null,
  provider: string,
  credentials: CredentialsState | null,
  modelState: ModelKeyState | null,
): KnowledgeKeyBadge {
  const meta = credentials ? providerMeta(credentials.catalog, provider) : null;
  const providerLabel = meta?.label ?? prettySlug(provider);
  const connected = credentials?.hasKey[provider] ?? false;
  const connectable = meta ? provider : null;
  if (connected) {
    return {
      show: (docs?.length ?? 0) > 0,
      connected: true,
      providerLabel,
      provider: connectable,
    };
  }
  const modelCoversIt =
    modelState?.status === "missing" && modelState.provider === provider;
  return {
    show: !modelCoversIt,
    connected: false,
    providerLabel,
    provider: connectable,
  };
}

/**
 * The detach-retry notice's copy (the row vanished; the config ref
 *  detach didn't finish). The delete may have LANDED with the detach
 *  publish failing (a 502/409 for an operation that did land — the #235
 *  review note), so the re-fetched list is the truth: a vanished row
 *  means the retry is safe and idempotent (the service delete is
 *  {ok:true} on unknown ids) and finishes the agent's knowledge update.
 */
export const KNOWLEDGE_DETACH_RETRY_COPY =
  "The document was removed, but finishing the agent's knowledge update didn't complete — retrying is safe.";


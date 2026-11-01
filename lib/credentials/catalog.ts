/**
 * The BYOK credential catalog — derived from the AgentOS platform, never
 * hardcoded. LLM providers come from the distinct key-requiring providers in
 * GET /platform/models; tool providers from the tools catalog's credential
 * contracts. Adding a tool or model provider to the platform automatically
 * adds it here — zero tackui code, not even env.
 *
 * Each provider carries its FIELD LIST — the named constructor arguments the
 * AgentOS per-run delivery fills. Single-key providers (LLM providers,
 * single-key toolkits like tavily) have one field, "api_key"; multi-
 * credential toolkits (the X toolkit) list several. The wire dep key for a
 * field is `<provider>_<field>` — one convention from the catalog through
 * the key UI, run-gate 402s, per-run delivery, and the toolkit constructor.
 *
 * The single source of truth is the AgentOS. When it is unreachable, the
 * catalog fetch fails gracefully (`catalog: null` + a caller-safe message)
 * and the saved-credentials store keeps working — only NEW keys are
 * blocked, because PUT validates against the live catalog.
 */

import {
  fetchAgentosModels,
  fetchBuilderTools,
  type AgentosModel,
  type AgentosTool,
} from "@/lib/agents/builder";

export type CredentialKind = "llm" | "tool";

/** One named secret field of a provider's connect form. */
export interface CredentialField {
  /** The constructor arg name (e.g. "api_key", "consumer_key"). */
  key: string;
  /** Display copy for the form field (e.g. "API key"). */
  label: string;
}

/** One derived provider: what it's for, its dep key, and its display label. */
export interface CredentialCatalogEntry {
  provider: string;
  kind: CredentialKind;
  /** The AG-UI context dep key the runner delivers (e.g. "tavily_api_key").
   *  For multi-credential providers this is the FIRST credential's dep key —
   *  `fields` is the full contract. */
  keyName: string;
  /** Display copy derived from the provider slug. */
  label: string;
  /** The named fields this provider's connect form renders. */
  fields: CredentialField[];
}

export type CredentialsCatalog = Record<string, CredentialCatalogEntry>;

/**
 * The dep key → provider slug convention: `<provider>_<field>` (e.g.
 * `tavily_api_key`, `x_consumer_key`). The AgentOS derives the dep key from
 * the toolkit slug + constructor arg, so the slug derivation is mechanical —
 * never a provider list. NOTE: for multi-field providers this cannot recover
 * the provider from the dep key alone (a field boundary is ambiguous) — the
 * catalog's `toolkit` slug is the source there; this helper stays for
 * single-key shapes and back-compat snapshots.
 */
export function providerForDepKey(keyName: string): string {
  return keyName.endsWith("_api_key") ? keyName.slice(0, -"_api_key".length) : keyName;
}

/** The model dep key for a provider slug (mirror of providerForDepKey). */
export function depKeyForProvider(provider: string): string {
  return `${provider}_api_key`;
}

/**
 * Display label derived from a provider slug — cosmetic only (the picker
 * already shows raw slugs for models). Title-case on word boundaries,
 * with a small acronym map so member-visible copy reads correctly:
 * "openai" → "OpenAI", "tavily" → "Tavily", "azure_openai" →
 * "Azure OpenAI", "z-ai" → "Z AI".
 */
const LABEL_ACRONYMS: Record<string, string> = {
  ai: "AI",
  api: "API",
  id: "ID",
  llm: "LLM",
  mcp: "MCP",
  openai: "OpenAI",
  url: "URL",
};

export function prettifyProviderLabel(provider: string): string {
  return provider
    .split(/[-_]/)
    .map((word) => LABEL_ACRONYMS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The field name a provider's dep key carries: the dep key is
 * `<provider>_<field>`, so with the provider known the field is the rest.
 * "tavily_api_key" + "tavily" → "api_key"; "x_consumer_key" + "x" →
 * "consumer_key".
 */
export function fieldForDepKey(provider: string, depKey: string): string {
  const prefix = `${provider}_`;
  return depKey.startsWith(prefix) ? depKey.slice(prefix.length) : depKey;
}

/**
 * Derive the credentials catalog from the two platform catalogs. A provider
 * that appears in both keeps its first (LLM) entry.
 */
export function deriveCredentialsCatalog(
  models: AgentosModel[],
  tools: AgentosTool[],
): CredentialsCatalog {
  const catalog: CredentialsCatalog = {};
  for (const m of models) {
    if (!m.provider || catalog[m.provider]) continue;
    if (m.requires_key === false) continue; // keyless provider (e.g. ollama)
    catalog[m.provider] = {
      provider: m.provider,
      kind: "llm",
      keyName: depKeyForProvider(m.provider),
      label: prettifyProviderLabel(m.provider),
      fields: [{ key: "api_key", label: "API key" }],
    };
  }
  for (const t of tools) {
    if (!t.requires_key || t.credentials.length === 0) continue;
    // The toolkit slug is the provider — dep keys derive from it, so a
    // multi-credential toolkit's fields all land under one provider. The
    // mechanical derivation stays as the fallback for slug-less shapes.
    const provider = t.toolkit || providerForDepKey(t.requires_key);
    const fields: CredentialField[] = [];
    for (const cred of t.credentials) {
      const key = fieldForDepKey(provider, cred.dep_key);
      if (fields.some((f) => f.key === key)) continue;
      fields.push({ key, label: cred.label });
    }
    if (fields.length === 0) continue;
    const existing = catalog[provider];
    if (existing) {
      // Same provider serving models and tools (e.g. openai): keep the LLM
      // entry, union any tool fields it doesn't already declare.
      for (const f of fields) {
        if (!existing.fields.some((g) => g.key === f.key)) existing.fields.push(f);
      }
      continue;
    }
    catalog[provider] = {
      provider,
      kind: "tool",
      keyName: t.requires_key,
      label: prettifyProviderLabel(provider),
      fields,
    };
  }
  return catalog;
}

/** The banner copy when the platform is unreachable — saved keys are never
 * affected; only adding new ones is blocked. */
export const CATALOG_UNREACHABLE_MESSAGE =
  "Can't reach the agent builder — your saved keys are unaffected. New keys can't be added until it's back.";

export interface CredentialsCatalogFetch {
  /** null when the platform was unreachable — the caller degrades, not fails. */
  catalog: CredentialsCatalog | null;
  catalogError?: string;
}

/**
 * Live-fetch both platform catalogs and derive the credentials catalog.
 * Any AgentOS failure degrades to `{catalog: null, catalogError}` — this
 * never throws, so routes can render saved data without the platform.
 */
export async function fetchCredentialsCatalog(): Promise<CredentialsCatalogFetch> {
  try {
    const [models, tools] = await Promise.all([
      fetchAgentosModels(),
      fetchBuilderTools(),
    ]);
    return { catalog: deriveCredentialsCatalog(models, tools) };
  } catch {
    return { catalog: null, catalogError: CATALOG_UNREACHABLE_MESSAGE };
  }
}

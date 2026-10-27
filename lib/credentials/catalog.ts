/**
 * The BYOK credential catalog — derived from the AgentOS platform, never
 * hardcoded. LLM providers come from the distinct providers in
 * GET /platform/models; tool providers from the tools catalog's
 * `requiresKey` dep keys. Adding a tool or model provider to the platform
 * automatically adds it here — zero tackui code, not even env.
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

/** One derived provider: what it's for, its dep key, and its display label. */
export interface CredentialCatalogEntry {
  provider: string;
  kind: CredentialKind;
  /** The AG-UI context dep key the runner delivers (e.g. "tavily_api_key"). */
  keyName: string;
  /** Display copy derived from the provider slug. */
  label: string;
}

export type CredentialsCatalog = Record<string, CredentialCatalogEntry>;

/**
 * The dep key → provider slug convention: `<provider>_api_key`. The
 * AgentOS credentials.py wire contract fixes the dep-key naming, so the
 * slug derivation is mechanical — never a provider list.
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
 * already shows raw slugs for models). Title-case on word boundaries:
 * "openai" → "Openai", "tavily" → "Tavily", "z-ai" → "Z Ai".
 */
export function prettifyProviderLabel(provider: string): string {
  return provider
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
    catalog[m.provider] = {
      provider: m.provider,
      kind: "llm",
      keyName: depKeyForProvider(m.provider),
      label: prettifyProviderLabel(m.provider),
    };
  }
  for (const t of tools) {
    if (!t.requires_key) continue;
    const provider = providerForDepKey(t.requires_key);
    if (catalog[provider]) continue;
    catalog[provider] = {
      provider,
      kind: "tool",
      keyName: t.requires_key,
      label: prettifyProviderLabel(provider),
    };
  }
  return catalog;
}

/** The banner copy when the platform is unreachable — saved keys are never
 * affected; only adding new ones is blocked. */
export const CATALOG_UNREACHABLE_MESSAGE =
  "Can't reach the platform — your saved keys are unaffected. New keys can't be added until it's back.";

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

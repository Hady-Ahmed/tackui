/**
 * Provider/field display-label helpers — pure string functions, safe to
 * import from client components (catalog.ts pulls in the server-side
 * builder client, so its helpers are unreachable from the browser).
 *
 * Single source of truth for the acronym-correcting prettifier: the
 * credentials catalog derives labels with it, and the client fallbacks
 * (credentials-page.tsx, builder-config.ts) import the same functions so a
 * catalog drift can never resurrect member-visible copy like "Openai".
 */

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
 * Normalize a FIELD label that arrives from outside (the AgentOS toolkit
 * contracts supply their own, e.g. "Api key") — same acronym correction,
 * but word-preserving: it only rewrites known acronyms and leaves
 * everything else (case, spacing) exactly as sent. "Api key" → "API key";
 * "consumer key" → "consumer key".
 */
export function prettifyFieldLabel(label: string): string {
  return label
    .split(/\s+/)
    .map((word) => LABEL_ACRONYMS[word.toLowerCase()] ?? word)
    .join(" ");
}

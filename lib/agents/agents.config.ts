export type AgentKind = "langgraph" | "agno" | "agui";

export interface AgentEntry {
  id: string;
  name: string;
  description: string;
  kind: AgentKind;
  endpoint: string;
  orgId: string;
  graphId?: string;
  langsmithApiKey?: string;
}

/**
 * Agent shape returned by read endpoints (GET /api/agents,
 * GET /api/agents/[id]). The raw `langsmithApiKey` is stripped and
 * replaced with a boolean so callers (e.g. the admin edit form) can
 * tell whether a key is configured without ever receiving the value.
 * Write endpoints (POST/PATCH) still accept the raw key.
 */
export interface PublicAgent {
  id: string;
  name: string;
  description: string;
  kind: AgentKind;
  endpoint: string;
  orgId: string;
  graphId?: string;
  hasLangsmithApiKey: boolean;
}

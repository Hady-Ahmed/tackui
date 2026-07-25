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

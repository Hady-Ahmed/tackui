export type AgentKind = "langgraph" | "agno" | "agui";

export interface AgentEntry {
  id: string;
  name: string;
  description: string;
  kind: AgentKind;
  endpoint: string;
  graphId?: string;
  langsmithApiKey?: string;
}

export const agents: AgentEntry[] = [
  {
    id: "research",
    name: "Research Agent",
    description: "LangGraph-powered web research assistant",
    kind: "agui",
    endpoint: process.env.LANGGRAPH_URL || "http://localhost:8001/agent",
  },
  {
    id: "assistant",
    name: "Agno Assistant",
    description: "General-purpose assistant powered by Agno",
    kind: "agno",
    endpoint: process.env.AGNO_URL || "http://localhost:8000/agui",
  },
];

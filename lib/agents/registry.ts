import { LangGraphAgent } from "@copilotkit/runtime/langgraph";
import { HttpAgent } from "@ag-ui/client";
import type { AbstractAgent } from "@ag-ui/client";
import type { AgentEntry } from "./agents.config";
import { listAgents } from "./agent-store";

export type AgentsMap = Record<string, AbstractAgent>;

export function getAgents(): AgentsMap {
  const entries = listAgents();
  if (entries.length === 0) {
    throw new Error(
      "No agents configured. Add agents via the /agents admin page or seed agents.config.ts.",
    );
  }

  const map: AgentsMap = {};
  for (const entry of entries) {
    map[entry.id] = createAgent(entry);
  }
  return map;
}

function createAgent(entry: AgentEntry): AbstractAgent {
  switch (entry.kind) {
    case "langgraph":
      return new LangGraphAgent({
        deploymentUrl: entry.endpoint,
        graphId: entry.graphId || "agent",
        langsmithApiKey: entry.langsmithApiKey,
      });

    case "agno":
    case "agui":
      return new HttpAgent({
        url: entry.endpoint,
      });

    default:
      throw new Error(`Unknown agent kind: ${entry.kind satisfies never}`);
  }
}

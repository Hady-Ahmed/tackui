import { LangGraphAgent } from "@copilotkit/runtime/langgraph";
import { HttpAgent } from "@ag-ui/client";
import type { AbstractAgent } from "@ag-ui/client";
import { agents } from "./agents.config";

export type AgentsMap = Record<string, AbstractAgent>;

export function getAgents(): AgentsMap {
  const map: AgentsMap = {};

  for (const entry of agents) {
    map[entry.id] = createAgent(entry);
  }

  return map;
}

function createAgent(entry: (typeof agents)[number]): AbstractAgent {
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

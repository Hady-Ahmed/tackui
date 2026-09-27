import { LangGraphAgent } from "@copilotkit/runtime/langgraph";
import { HttpAgent } from "@ag-ui/client";
import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import type { AgentEntry } from "./agents.config";
import { listAgents } from "./agent-store";
import { getRequestUser } from "@/lib/auth/context";
import type { RequestUser } from "@/lib/auth/request-context";

export type AgentsMap = Record<string, AbstractAgent>;

export async function getAgents(request?: Request): Promise<AgentsMap> {
  const user = await getRequestUser(request ?? new Request("http://localhost"));
  if (!user) throw new Error("No agents available — not authenticated.");
  const entries = await listAgents(user.orgId);
  if (entries.length === 0) {
    throw new Error(
      "No agents configured. Add agents via the /agents admin page.",
    );
  }

  const map: AgentsMap = {};
  for (const entry of entries) {
    map[entry.id] = createAgent(entry, user);
  }
  return map;
}

function createAgent(entry: AgentEntry, user: RequestUser): AbstractAgent {
  switch (entry.kind) {
    case "langgraph":
      return new LangGraphAgent({
        deploymentUrl: entry.endpoint,
        graphId: entry.graphId || "agent",
        langsmithApiKey: entry.langsmithApiKey,
      });

    case "agui": {
      const agent = new HttpAgent({
        url: entry.endpoint,
      });
      // Forward the authenticated user's id to the agent backend via
      // `forwardedProps.user_id` — Agno's documented convention for
      // anonymous-caller attribution (Agno's `/agui` interface reads this
      // to key per-user memory and sessions). The value is the server-
      // resolved auth principal (Better Auth user UUID, or "local" in
      // solo mode), never trusting client-supplied identity. Auth-
      // protected agents requiring per-user JWTs are a future feature.
      agent.use((input: RunAgentInput, next) =>
        next.run({
          ...input,
          forwardedProps: {
            ...input.forwardedProps,
            user_id: user.id,
          },
        }),
      );
      return agent;
    }

    default:
      throw new Error(`Unknown agent kind: ${entry.kind satisfies never}`);
  }
}

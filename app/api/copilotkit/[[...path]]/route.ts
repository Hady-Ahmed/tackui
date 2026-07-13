import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { getAgents } from "@/lib/agents/registry";
import { PersistentAgentRunner } from "@/lib/agents/persistent-runner";

const runtime = new CopilotRuntime({
  agents: () => getAgents(),
  runner: new PersistentAgentRunner({ dbPath: "./data/agent-state.db" }),
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
});

export const POST = handler;
export const GET = handler;
export const PATCH = handler;
export const DELETE = handler;

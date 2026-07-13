import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { getAgents } from "@/lib/agents/registry";
import { runner } from "@/lib/agents/runner-instance";

const runtime = new CopilotRuntime({
  agents: () => getAgents(),
  runner,
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
});

export const POST = handler;
export const GET = handler;
export const PATCH = handler;
export const DELETE = handler;

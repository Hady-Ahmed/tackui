import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { getAgents } from "@/lib/agents/registry";
import { runner } from "@/lib/agents/runner-instance";
import { getRequestUser, SYNTHETIC_ADMIN } from "@/lib/auth/context";
import { isAuthDisabled } from "@/lib/auth/auth";
import { runWithUserAsync } from "@/lib/auth/request-context";

const runtime = new CopilotRuntime({
  agents: ({ request }) => getAgents(request),
  runner,
});

const innerHandler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
});

async function handler(request: Request): Promise<Response> {
  if (!isAuthDisabled()) {
    const user = await getRequestUser(request);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return runWithUserAsync(user, () => innerHandler(request));
  }
  return runWithUserAsync(SYNTHETIC_ADMIN, () => innerHandler(request));
}

export const POST = handler;
export const GET = handler;
export const PATCH = handler;
export const DELETE = handler;

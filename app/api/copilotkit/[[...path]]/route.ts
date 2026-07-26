import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { getAgents } from "@/lib/agents/registry";
import { runner } from "@/lib/agents/runner-instance";
import { getRequestUser, getSyntheticAdmin } from "@/lib/auth/context";
import { isAuthDisabled } from "@/lib/auth/auth";
import { runWithUserAsync } from "@/lib/auth/request-context";
import {
  checkUserLimit,
  acquireConcurrent,
} from "@/lib/ratelimit/middleware";
import { wrapStreamWithRelease } from "@/lib/ratelimit/stream-wrap";

const runtime = new CopilotRuntime({
  agents: ({ request }) => getAgents(request),
  runner,
});

const innerHandler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
});

async function handler(request: Request): Promise<Response> {
  try {
    let userId: string;

    if (!isAuthDisabled()) {
      const user = await getRequestUser(request);
      if (!user) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      userId = user.id;

      // Per-user rate limit: 20 runs/min.
      const limited = checkUserLimit(userId, "copilotkit");
      if (limited) return limited;

      // Concurrent SSE cap: 3 in-flight streams per user.
      // Wrap the response stream so the decrement fires on stream close
      // (completion, error, or client disconnect).
      const concurrentResult = acquireConcurrent(userId, "copilotkitConcurrent");
      if (concurrentResult instanceof Response) return concurrentResult;
      const releaseConcurrent = concurrentResult;

      try {
        const response = await runWithUserAsync(user, () => innerHandler(request));
        return wrapStreamWithRelease(response, releaseConcurrent);
      } catch (err) {
        releaseConcurrent();
        throw err;
      }
    }

    // Solo mode — no per-user limiting (everyone is "local"). Per-IP
    // flood protection from proxy.ts still applies.
    const syntheticUser = await getSyntheticAdmin();
    userId = syntheticUser.id;
    return runWithUserAsync(syntheticUser, () => innerHandler(request));
  } catch (err) {
    console.error("[copilotkit] handler error", {
      method: request.method,
      url: request.url,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}

export const POST = handler;
export const GET = handler;
export const PATCH = handler;
export const DELETE = handler;

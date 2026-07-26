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

/**
 * Wrap a Response so that `release()` is called when the response body
 * stream finishes (on natural completion, error, or client cancellation).
 *
 * This is necessary for the concurrent-stream cap: we increment before
 * the run starts and must decrement when the stream closes. The SSE
 * response from CopilotKit is a standard `Response` with a `ReadableStream`
 * body — we tee/wrap it to intercept the close event.
 *
 * If the response has no body (e.g. a 429 or error JSON), release
 * immediately.
 */
function wrapStreamWithRelease(
  response: Response,
  release: () => void,
): Response {
  if (!response.body) {
    release();
    return response;
  }

  const stream = response.body;
  const reader = stream.getReader();

  // Create a new stream that pipes through the reader and calls release
  // when the source stream closes or errors.
  const wrappedStream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel() {
      release();
      reader.cancel().catch(() => {});
    },
  });

  // Copy headers + status from the original response.
  const headers = new Headers(response.headers);
  return new Response(wrappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const POST = handler;
export const GET = handler;
export const PATCH = handler;
export const DELETE = handler;

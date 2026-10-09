import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { getAgents } from "@/lib/agents/registry";
import { runner } from "@/lib/agents/runner-instance";
import { getRequestUser, getSyntheticAdmin } from "@/lib/auth/context";
import { isAuthDisabled } from "@/lib/auth/auth";
import { SAAS_MODE } from "@/lib/config/saas";
import type { PlanId } from "@/lib/billing/plans";
import { runWithUserAsync } from "@/lib/auth/request-context";
import {
  checkUserLimit,
  acquireConcurrent,
} from "@/lib/ratelimit/middleware";
import { wrapStreamWithRelease } from "@/lib/ratelimit/stream-wrap";
import { getEnforcementLimits, checkCatalogRunGates } from "@/lib/plans/enforcement";

/**
 * Extract the agent id from a run request path, e.g.
 * `/api/copilotkit/agent/{agentId}/run` → `{agentId}`. Returns null for
 * any other path shape (control requests never reach the caller).
 */
function runAgentIdFromPath(pathname: string): string | null {
  const match = /\/agent\/([^/]+)\/run\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

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

    // Determine if this is an actual agent RUN request vs. a
    // connect/info/threads/stop request. Only runs count toward the rate
    // limit and concurrent cap.
    //
    // CopilotKit POSTs to various sub-paths (e.g. /agent/my-agent/run),
    // not just the base /api/copilotkit. The long-lived POSTs that
    // AREN'T runs are:
    //   - connect streams (POST /agent/*/connect) — listen for events
    //     on an existing connection, no new backend call.
    //   - stop requests (POST /agent/*/stop/<threadId>) — teardown
    //     signal that aborts an existing run. Exempting these is
    //     critical: otherwise stopping a run at the 3-concurrent cap
    //     tries to acquire a 4th slot and 429s, making the run
    //     unstoppable.
    // Everything else POST is a run.
    //
    // Non-run requests are still protected by the per-IP global
    // flood limit (300/min) in proxy.ts.
    const url = new URL(request.url);
    const isControlRequest =
      url.pathname.includes("/connect") || url.pathname.includes("/stop/");
    const isRunRequest = request.method === "POST" && !isControlRequest;

    if (!isAuthDisabled()) {
      const user = await getRequestUser(request);
      if (!user) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      userId = user.id;

      // Per-user rate limit + concurrent cap. Under SaaS mode the limits
      // come from the org's plan (free=10/min + 1 concurrent, pro=20/min
      // + 3, team=20/min + 5); under self-host the static presets in
      // LIMITS apply (getEnforcementLimits short-circuits to those).
      let planRunsPerMin: number | undefined;
      let planConcurrent: number | undefined;
      let saasPlan: PlanId | undefined;
      if (SAAS_MODE) {
        const { plan, limits } = await getEnforcementLimits(user.orgId);
        saasPlan = plan;
        planRunsPerMin = limits.runsPerMinute;
        planConcurrent = limits.concurrentRuns;
      }
      if (isRunRequest) {
        const limited = checkUserLimit(userId, "copilotkit", {
          max: planRunsPerMin,
        });
        if (limited) return limited;

        // Catalog agent gates: the curator-state checks (tombstone →
        // 410, deactivated template → 402) apply in ALL modes; the
        // monetization gates (requiredPlan + free-tier daily quota) are
        // SaaS-only and short-circuit inside on self-host. Runs of
        // manually-added agents are never gated. This is a product
        // gate, not a flood guard, so it fires after the per-minute
        // rate limit above.
        const runAgentId = runAgentIdFromPath(url.pathname);
        if (runAgentId) {
          const gated = await checkCatalogRunGates(user, runAgentId, saasPlan);
          if (gated) return gated;
        }
      }

      // Concurrent SSE cap: in-flight run streams per user.
      // Only applies to actual agent runs. Connect streams (POST to
      // /agent/*/connect) are long-lived but lightweight — they
      // listen for events on existing connections, they don't start
      // new agent runs or hold expensive resources.
      let releaseConcurrent: (() => void) | null = null;
      if (isRunRequest) {
        const concurrentResult = acquireConcurrent(userId, "copilotkitConcurrent", {
          max: planConcurrent,
        });
        if (concurrentResult instanceof Response) return concurrentResult;
        releaseConcurrent = concurrentResult;
      }

      try {
        const response = await runWithUserAsync(user, () => innerHandler(request));
        return releaseConcurrent
          ? wrapStreamWithRelease(response, releaseConcurrent)
          : response;
      } catch (err) {
        if (releaseConcurrent) releaseConcurrent();
        throw err;
      }
    }

    // Solo mode — no per-user rate limiting or billing gates (everyone
    // is "local"), but curator-state catalog gates still apply: a
    // tombstoned or deactivated catalog agent must not run even for the
    // self-host operator. Per-IP flood protection from proxy.ts still
    // applies.
    const syntheticUser = await getSyntheticAdmin();
    userId = syntheticUser.id;
    if (isRunRequest) {
      const runAgentId = runAgentIdFromPath(url.pathname);
      if (runAgentId) {
        const gated = await checkCatalogRunGates(syntheticUser, runAgentId);
        if (gated) return gated;
      }
    }
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

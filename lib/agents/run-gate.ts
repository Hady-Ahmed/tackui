/**
 * Builder-agent run gate — the pre-run 402s and per-run dependency
 * resolution for agents created through the builder.
 *
 * Called by the copilotkit route for EVERY run request BEFORE anything
 * reaches a backend. Split into two phases so refusal can never cost the
 * user anything they didn't get:
 *
 * 1. **`checkBuilderRunGate` (gate phase)** — refuse the run (one
 *    aggregated 402) when a requirement cannot be satisfied: the agent's
 *    model is not platform-tier and the runner has no key for its
 *    provider; a tool needs a key the runner lacks and the tool has no
 *    platform fallback; a required org MCP connector is not configured.
 *    The principle is "never a silent mid-run failure" — anything
 *    checkable is checked before the run. This phase consumes nothing:
 *    a refused run burns no quota and holds no concurrent slot, so it
 *    runs BEFORE slot acquisition.
 *
 * 2. **`consumeBuilderRunQuota` (quota phase)** — called AFTER the
 *    concurrent slot is acquired (a 429 at the cap must not burn a daily
 *    platform-key run). When the run is platform-key (some dependency
 *    resolves to the platform key), count it against the plan's
 *    `platformDailyQuota` (lib/ratelimit, 24h sliding window). BYOK runs
 *    are exempt. The quota is the only SaaS-only check here: self-host
 *    still gets requirement 402s (there is no fallback for connector
 *    credentials or non-fallback tool keys, and non-tier models are hard
 *    failures regardless of mode) but never consumes quota — the operator
 *    pays the platform key bill themselves. Dependencies are resolved in
 *    both modes so BYOK delivery works everywhere.
 *
 * Non-builder agents (manual/template rows) return the empty resolution —
 * catalog agents have their own gates (checkCatalogRunGates).
 */

import { NextResponse } from "next/server";
import { getCredentialSecrets } from "@/lib/credentials/credential-store";
import {
  depKeyForProvider,
  prettifyProviderLabel,
  providerForDepKey,
} from "@/lib/credentials/catalog";
import { getConnectorsByNames } from "@/lib/connectors/connector-store";
import { consumePlatformKeyQuota } from "@/lib/ratelimit/platform-quota";
import { getEnforcementLimits, formatCountdown } from "@/lib/plans/enforcement";
import { SAAS_MODE } from "@/lib/config/saas";
import { getAgent } from "./agent-store";
import type { AgentEntry } from "./agents.config";
import type { RunContextItem, RequestUser } from "@/lib/auth/request-context";

export interface BuilderRunResolution {
  /** null when the run is allowed; otherwise the 402 to return. */
  response: NextResponse | null;
  /** AG-UI context items to inject (empty for non-builder agents). */
  contextItems: RunContextItem[];
  /** true when the run will use the platform key and its daily quota
      must be consumed AFTER the concurrent slot is acquired. */
  platformKeyRun: boolean;
}

export function emptyBuilderRunResolution(): BuilderRunResolution {
  return { response: null, contextItems: [], platformKeyRun: false };
}

/**
 * Gate phase — 402-check the requirements and resolve the per-run
 * dependencies. Only builder agents (origin === "builder" with a
 * requirements snapshot) are gated; anything else gets the empty
 * resolution. Consumes nothing: quota happens in `consumeBuilderRunQuota`
 * after the concurrent slot is acquired.
 */
export async function checkBuilderRunGate(
  user: RequestUser,
  agentId: string,
): Promise<BuilderRunResolution> {
  const agent: AgentEntry | null = await getAgent(agentId, user.orgId);
  if (!agent || agent.origin !== "builder" || !agent.requirements) {
    return emptyBuilderRunResolution();
  }
  const requirements = agent.requirements;

  const runnerKeys = await getCredentialSecrets(user.id);
  const contextItems: RunContextItem[] = [];
  const blockers: string[] = [];
  let platformKeyRun = false;

  // --- Model: runner's key wins; platform key serves mini-tier models. ---
  // The model dep key follows the wire contract the AgentOS dispatcher
  // resolves (<provider>_api_key — see credentials.py).
  const modelProvider = requirements.model.provider;
  const modelKeyName = depKeyForProvider(modelProvider);
  const modelKey = runnerKeys[modelProvider];
  if (modelKey) {
    contextItems.push({ description: modelKeyName, value: modelKey });
  } else if (requirements.model.platformTier) {
    // Platform-tier (mini) model — the AgentOS env platform key serves it.
    platformKeyRun = true;
  } else {
    const providerLabel = prettifyProviderLabel(modelProvider);
    blockers.push(
      `This agent runs on ${requirements.model.id} — add your own ${providerLabel} key to run it.`,
    );
  }

  // --- Tools: key-delivered when the runner has one; platform fallback ---
  // serves otherwise; hard 402 when neither exists. Everything comes from
  // the requirements snapshot — no live catalog, no hardcode. A snapshot
  // that predates the provider/platformFallback fields parses with the
  // provider re-derived from the dep key and fallback=false (fail-closed).
  for (const tool of requirements.tools) {
    if (!tool.requiresKey) continue;
    const provider = tool.provider ?? providerForDepKey(tool.requiresKey);
    const key = runnerKeys[provider];
    if (key) {
      contextItems.push({ description: tool.requiresKey, value: key });
    } else if (tool.platformFallback === true) {
      platformKeyRun = true;
    } else {
      const toolLabel = tool.label ?? tool.name;
      const providerLabel = prettifyProviderLabel(provider);
      blockers.push(
        `This agent uses ${toolLabel} — add your own ${providerLabel} key to run it.`,
      );
    }
  }

  // --- Connectors: org-level MCP config; missing = always a blocker
  // (there is no platform fallback for connector credentials in any mode).
  if (requirements.connectors.length > 0) {
    const connectors = await getConnectorsByNames(
      user.orgId,
      requirements.connectors,
    );
    const missing = requirements.connectors.filter((n) => !connectors.has(n));
    if (missing.length > 0) {
      blockers.push(
        `This agent uses the ${missing.join(" and ")} connector${missing.length === 1 ? "" : "s"} — an org admin needs to add ${missing.length === 1 ? "it" : "them"} before it can run.`,
      );
    }
    if (connectors.size > 0) {
      const payload: Record<string, { url: string; token: string }> = {};
      for (const connector of connectors.values()) {
        payload[connector.name] = { url: connector.url, token: connector.token };
      }
      contextItems.push({
        description: "mcp_connectors",
        value: JSON.stringify(payload),
      });
    }
  }

  // Aggregated 402 — every resolvable blocker in one response. This phase
  // runs before the concurrent slot is acquired, so a refused run holds
  // nothing and consumes nothing.
  if (blockers.length > 0) {
    return {
      response: NextResponse.json(
        { error: blockers.join(" "), code: "AGENT_REQUIREMENTS_MISSING" },
        { status: 402 },
      ),
      contextItems: [],
      platformKeyRun: false,
    };
  }

  return { response: null, contextItems, platformKeyRun };
}

/**
 * Quota phase — consume the platform-key daily quota when the run will
 * use the platform key. MUST be called AFTER the concurrent slot is
 * acquired: a 429 at the cap happens before this, so a run refused at
 * the cap never burns a daily platform-key run. A run that passes this
 * and fails mid-stream still legitimately consumed (the platform key was
 * spent). SaaS-only; self-host short-circuits (the operator pays the
 * platform key bill, and the self-host sentinel quota is null anyway).
 */
export async function consumeBuilderRunQuota(
  user: RequestUser,
  platformKeyRun: boolean,
): Promise<NextResponse | null> {
  if (!SAAS_MODE || !platformKeyRun) return null;
  const { plan, limits } = await getEnforcementLimits(user.orgId);
  if (limits.platformDailyQuota === null) return null;
  const quota = consumePlatformKeyQuota(user.id, limits.platformDailyQuota);
  if (quota.allowed) return null;
  const resetsAt = quota.resetAt;
  const upgradeClause = plan === "free" ? " Upgrade to Pro for more usage." : "";
  return NextResponse.json(
    {
      error: `You've reached your daily limit for platform-key runs — you can run again in ${formatCountdown(resetsAt - Date.now())}.${upgradeClause}`,
      code: "PLATFORM_QUOTA_EXCEEDED",
      resetsAt,
    },
    { status: 402 },
  );
}

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
 *    model has no runner key for its provider; a tool's credential
 *    contract cannot be resolved from the runner's saved fields; a
 *    required org MCP connector is not configured. The principle is
 *    "never a silent mid-run failure" — anything checkable is checked
 *    before the run, and every dep of a tool's contract must resolve
 *    (a partial contract would pass the gate and fail mid-run). This
 *    phase consumes nothing: a refused run burns no quota and holds no
 *    concurrent slot, so it runs BEFORE slot acquisition.
 *
 * 2. **`consumeBuilderRunQuota` (quota phase)** — called AFTER the
 *    concurrent slot is acquired (a 429 at the cap must not burn a daily
 *    platform-key run). When the run is platform-key, count it against
 *    the plan's `platformDailyQuota` (lib/ratelimit, 24h sliding window).
 *    BYOK runs are exempt. DORMANT until Phase 3 publishing: builder runs
 *    are 100% BYOK today, so `platformKeyRun` is always false and this
 *    phase never fires — the wiring stays so publishing wakes it with a
 *    one-line change. SaaS-only: self-host never consumes quota — the
 *    operator pays the platform key bill themselves.
 *
 * Non-builder agents (manual/template rows) return the empty resolution —
 * catalog agents have their own gates (checkCatalogRunGates).
 */

import { NextResponse } from "next/server";
import { getCredentialSecrets } from "@/lib/credentials/credential-store";
import {
  depKeyForProvider,
  fieldForDepKey,
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
  /** Every dep key the gate owns — model key, every credential-contract
      field, mcp_connectors. The registry middleware strips any client-sent
      context item matching one of these so the client can never forge a
      server-resolved dependency (multi-field contracts like x_consumer_key
      are NOT covered by the mechanical `_api_key` family regex — they must
      come from here, exactly as delivered). */
  reservedDepKeys: string[];
}

export function emptyBuilderRunResolution(): BuilderRunResolution {
  return {
    response: null,
    contextItems: [],
    platformKeyRun: false,
    reservedDepKeys: [],
  };
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

  // The runner's saved credentials: provider → named field map (migration
  // 0014; single-key providers have exactly one field, "api_key").
  const runnerFields = await getCredentialSecrets(user.id);
  const contextItems: RunContextItem[] = [];
  const blockers: string[] = [];
  // TIER DORMANCY (wakes at Phase 3 publishing): builder runs are 100% BYOK
  // — the platform env key serves nothing today, so `platformKeyRun` is
  // never true (const — not a forgotten write; the mechanism is dormant).
  // `requirements.model.platformTier` and tool `platformFallback` stay in
  // the snapshot (and keep flowing through the builder/catalog for the
  // future), but the gate IGNORES both.
  const platformKeyRun = false;

  // --- Model: the runner's own key. The model dep key follows the wire ---
  // contract the AgentOS dispatcher resolves (<provider>_api_key — see
  // credentials.py); the field is the universal "api_key" constructor arg.
  // A snapshot that predates the requiresKey field treats every model as
  // keyed (undefined !== false) — keyless providers (ollama) are excluded
  // from the credentials catalog, so demanding a key for one would be a
  // requirement the runner can never satisfy.
  const modelProvider = requirements.model.provider;
  const modelKeyName = depKeyForProvider(modelProvider);
  const modelKey = runnerFields[modelProvider]?.api_key;
  // The exact dep-key set this gate owns. Derived from what the gate
  // actually delivers (model key + every tool contract field) — not from
  // a maintained list, which would rot the first time a contract grows a
  // non-_api_key field. mcp_connectors is the only non-contract key.
  const reservedDepKeys = new Set<string>(["mcp_connectors", modelKeyName]);
  if (requirements.model.requiresKey === false) {
    // Keyless provider (e.g. ollama) — no credential demanded, and the
    // provider is excluded from the credentials catalog, so demanding a
    // key would be a requirement the runner can never satisfy. Nothing
    // delivered for the model.
  } else if (modelKey) {
    contextItems.push({ description: modelKeyName, value: modelKey });
  } else {
    const providerLabel = prettifyProviderLabel(modelProvider);
    blockers.push(
      `This agent runs on ${requirements.model.id} — add your own ${providerLabel} key to run it.`,
    );
  }

  // --- Tools: every dep of the credential contract must resolve, or the ---
  // toolkit is skipped for the run (fail-closed). Multi-credential toolkits
  // deliver one context item per field. Everything comes from the
  // requirements snapshot — no live catalog, no hardcode. A snapshot that
  // predates the credentials/provider fields parses with the provider
  // re-derived from the dep key and the single dep as the contract.
  for (const tool of requirements.tools) {
    // A present credential contract is authoritative even when the legacy
    // single-dep field is null (upstream row inconsistency) — skipping it
    // would let a tool the gate can never satisfy run unrequested and
    // fail mid-run. Fail closed: demand the contract's deps.
    const contract = tool.credentials?.length
      ? tool.credentials
      : tool.requiresKey
        ? [{ depKey: tool.requiresKey, label: "API key" }]
        : [];
    if (contract.length === 0) continue;
    const provider =
      tool.provider ?? providerForDepKey(contract[0].depKey);
    for (const cred of contract) reservedDepKeys.add(cred.depKey);
    const fields = runnerFields[provider] ?? {};
    const missing = contract.filter(
      (c) => !fields[fieldForDepKey(provider, c.depKey)],
    );
    if (missing.length === 0) {
      for (const cred of contract) {
        contextItems.push({
          description: cred.depKey,
          value: fields[fieldForDepKey(provider, cred.depKey)],
        });
      }
    } else {
      const toolLabel = tool.label ?? tool.name;
      const providerLabel = prettifyProviderLabel(provider);
      const noun = contract.length > 1 ? "credentials" : "key";
      blockers.push(
        `This agent uses ${toolLabel} — add your own ${providerLabel} ${noun} to run it.`,
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
      reservedDepKeys: [...reservedDepKeys],
    };
  }

  return {
    response: null,
    contextItems,
    platformKeyRun,
    reservedDepKeys: [...reservedDepKeys],
  };
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

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
  fieldForDepKey,
  prettifyProviderLabel,
  providerForDepKey,
} from "@/lib/credentials/catalog";
import { getConnectorsByIds } from "@/lib/connectors/connector-store";
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
  /** Every dep key the gate owns — the model key, every credential-
      contract field, mcp_connectors, the knowledge embedder's key. The
      registry middleware strips any client-sent context item matching
      one of these so the client can never forge a server-resolved
      dependency (multi-field contracts like x_consumer_key are NOT
      covered by the mechanical `_api_key` family regex — they must
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
  if (!agent || agent.origin !== "builder") {
    return emptyBuilderRunResolution();
  }
  if (!agent.requirements) {
    // Builder rows ALWAYS carry a requirements snapshot — the builder
    // writes it at create and every config update. `undefined` here means
    // the stored blob FAILED the schema (parseRequirements logs and drops
    // it), i.e. a stale snapshot written before the current required
    // fields. Returning the empty resolution would skip every check AND
    // deliver no key — and the platform's env-key fallback would then run
    // the agent on the PLATFORM's credential, the exact leak this gate
    // exists to prevent. Fail closed with the re-save instruction.
    return {
      response: NextResponse.json(
        {
          error:
            "This agent's saved requirements are out of date — open it in the agent builder and save it again to run it.",
          code: "AGENT_REQUIREMENTS_MISSING",
        },
        { status: 402 },
      ),
      contextItems: [],
      platformKeyRun: false,
      reservedDepKeys: [],
    };
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

  // --- Model: the runner's own key. The dep key is DECLARED, not guessed ---
  // The requirements snapshot carries the platform's declared dep_key
  // (written at build time from the live catalog) — critical for door
  // slugs: openai-responses shares openai_api_key with the chat door, and
  // slug math would demand a key nothing can provide. The credential
  // itself is looked up under the VENDOR (providerForDepKey of the dep
  // key), not the door slug. A keyed model whose snapshot lacks a dep key
  // is a stale snapshot (the schema rejects it at read time) — fail
  // closed with a re-save instruction; never guess a dep key.
  const modelKeyName = requirements.model.depKey;
  const modelKey =
    modelKeyName ? runnerFields[providerForDepKey(modelKeyName)]?.api_key : undefined;
  // The exact dep-key set this gate owns. Derived from what the gate
  // actually delivers (model key + every tool contract field) — not from
  // a maintained list, which would rot the first time a contract grows a
  // non-_api_key field. mcp_connectors is the only non-contract key. A
  // stale snapshot (no declared dep key on a keyed model) reserves nothing
  // model-side — the blocker below stops the run before delivery anyway.
  const reservedDepKeys = new Set<string>([
    "mcp_connectors",
    ...(modelKeyName ? [modelKeyName] : []),
  ]);
  if (requirements.model.requiresKey === false) {
    // Keyless provider (e.g. ollama) — no credential demanded, and the
    // provider is excluded from the credentials catalog, so demanding a
    // key would be a requirement the runner can never satisfy. Nothing
    // delivered for the model.
  } else if (!modelKeyName) {
    // Stale snapshot: written before the declared dep key existed. The
    // schema rejects it at read time; this branch guards in-memory
    // callers. Guessing `<slug>_api_key` here would silently demand a
    // key nobody can save for door-slug providers — refuse instead.
    blockers.push(
      "This agent's saved requirements are out of date — open it in the agent builder and save it again to run it.",
    );
  } else if (modelKey) {
    contextItems.push({ description: modelKeyName, value: modelKey });
  } else {
    // The banner names the VENDOR the key is saved under ("OpenAI"), not
    // the door slug — the member's fix is the same key either way.
    const providerLabel = prettifyProviderLabel(providerForDepKey(modelKeyName));
    blockers.push(
      `This agent runs on ${requirements.model.id} — add your own ${providerLabel} key to run it.`,
    );
  }

  // --- Knowledge: the embedding provider's key. BYOK-only (no platform ---
  // fallback — knowledge never had one, consistent with tier dormancy) and
  // no quota change: the embedding spend rides the runner's own key, so a
  // knowledge-attached run is NOT a platform-key run. The dep key follows
  // the `<provider>_api_key` convention the dispatcher resolves the
  // embedder with (agent-builder/dispatcher.py resolves
  // `resolve_from_deps(deps, f"{embedder_cfg.provider}_api_key")` from the
  // run's EXISTING dependency context — no dedicated dep item), so the
  // gate demands exactly what the dispatcher reads.
  //
  // Delivery and blocker DEDUPE against the model check: when the model
  // demands the SAME dep key (an OpenAI model + OpenAI knowledge), the
  // model block above already delivered the key or produced the blocker —
  // pushing a second identical context item / blocker line would double
  // both (and the dispatcher's deps dict keys on the context description,
  // so a duplicate delivery would just overwrite itself). When the dep
  // keys DIFFER (an OpenRouter model + OpenAI knowledge), delivery is
  // per-need: BOTH keys ride the run, and the knowledge key gets its own
  // blocker line with its own remedy.
  if (requirements.knowledge?.provider) {
    const provider = requirements.knowledge.provider;
    const knowledgeDepKey = `${provider}_api_key`;
    reservedDepKeys.add(knowledgeDepKey);
    // The key is saved under the VENDOR (providerForDepKey of the dep key)
    // with the single "api_key" field — the same lookup shape the model
    // check uses. An empty provider can't reach here from the store (the
    // schema requires min(1)); an in-memory caller passing one gets no
    // demand, which degrades the same way the dispatcher does (strip +
    // warn, run without retrieval).
    const knowledgeProvider = providerForDepKey(knowledgeDepKey);
    const knowledgeKey =
      runnerFields[knowledgeProvider]?.[
        fieldForDepKey(knowledgeProvider, knowledgeDepKey)
      ];
    const modelCoversIt =
      modelKeyName === knowledgeDepKey && requirements.model.requiresKey !== false;
    // The requiresKey guard: a model row that names the same dep key but
    // is marked keyless (requiresKey false — a malformed platform row; the
    // live catalog pairs keyless with depKey null) delivered nothing, so
    // it does NOT cover the knowledge demand — the saved key must still
    // ride the run instead of being suppressed into a no-retrieval run.
    if (knowledgeKey && !modelCoversIt) {
      contextItems.push({ description: knowledgeDepKey, value: knowledgeKey });
    } else if (!knowledgeKey && !modelCoversIt) {
      blockers.push(
        `This agent uses knowledge — add your own ${prettifyProviderLabel(knowledgeProvider)} key to run it.`,
      );
    }
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
  // Resolution is BY ID: the snapshot carries {id, name} pairs captured at
  // builder save time, and the stored platform config declares those same
  // ids. A deleted-and-recreated connector keeps its NAME but gets a NEW
  // id — a name lookup would silently satisfy the gate and deliver a
  // token the dispatcher refuses (the stored config still declares the
  // old id): a mid-run failure instead of the pre-run 402 this gate
  // exists to produce.
  if (requirements.connectors.length > 0) {
    const connectors = await getConnectorsByIds(
      user.orgId,
      requirements.connectors.map((c) => c.id),
    );
    const missing = requirements.connectors.filter((c) => !connectors.has(c.id));
    if (missing.length > 0) {
      const names = missing.map((c) => c.name);
      blockers.push(
        `This agent uses the ${names.join(" and ")} connector${missing.length === 1 ? "" : "s"} — an org admin needs to add it and re-save this agent in the agent builder before it can run.`,
      );
    }
    // An undecryptable stored token is NOT "no auth": the run would attach
    // an empty bearer token and fail mid-run. 402 with the re-entry
    // remedy instead.
    const unreadable = [...connectors.values()].filter((c) => c.tokenUndecryptable);
    if (unreadable.length > 0) {
      const names = unreadable.map((c) => c.name);
      blockers.push(
        `The ${names.join(" and ")} connector${unreadable.length === 1 ? "'s saved token can't be read" : "s' saved tokens can't be read"} — an org admin needs to re-enter ${unreadable.length === 1 ? "it" : "them"} before the agent can run.`,
      );
    }
    if (connectors.size > 0 && unreadable.length === 0 && missing.length === 0) {
      // Keyed by the connector's stable ID, and deliberately carrying NO
      // URL: the platform resolves attach URLs from its connector registry
      // (push-first-synced by this server at connector save) and ignores
      // wire URLs outright — a wire URL would be an SSRF primitive. Only
      // the token rides the wire, per run.
      const payload: Record<string, { token: string }> = {};
      for (const connector of connectors.values()) {
        payload[connector.id] = { token: connector.token };
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

  // Final by-description dedupe — the single-delivery invariant, made
  // structural. The model-vs-knowledge check above dedupes only that one
  // pair, and it establishes keep-the-FIRST-item as the convention (the
  // model's delivery is pushed first; the knowledge branch pushes nothing
  // when the model covers the key). A tool contract can still name a dep
  // key another branch delivered (an OpenAI-keyed tool + OpenAI knowledge
  // on an OpenRouter model → two `openai_api_key` items), and two tool
  // contracts can share a key. agno's `extract_context` keys the deps
  // dict by description (last-wins), so duplicates never changed what the
  // run saw — but the gate itself delivers one item per dep key, whatever
  // demanded it. Every branch resolves the same saved credential field
  // for a given dep key, so the first occurrence is the right survivor.
  const deliveredDepKeys = new Set<string>();
  const dedupedContextItems = contextItems.filter((item) => {
    if (deliveredDepKeys.has(item.description)) return false;
    deliveredDepKeys.add(item.description);
    return true;
  });

  return {
    response: null,
    contextItems: dedupedContextItems,
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

/**
 * The knowledge attach/detach lifecycle — the knowledge routes are
 * agent-mutation routes. An agent's stored config only references its
 * corpus while ≥1 document exists:
 *
 * - first upload on a knowledge-less agent → publish a new config version
 *   WITH the ref (`"knowledge": {"name": "kb-<component_id>"}`);
 * - deleting the last doc → publish the config WITHOUT the ref.
 *
 * Both directions reuse the builder PATCH flow's machinery
 * (app/api/agents/builder/[id]/route.ts): the two-phase local-first
 * ordering, the `current_version` CAS guard, the compensating revert, and
 * the snapshot re-derivation through deriveRequirementsFromConfig. The
 * config diff here is ONLY the knowledge key, so when full re-derivation
 * can't run (an odd config shape, a catalog row gone), the fallback
 * applies the same single-key diff to the existing snapshot — the PATCH
 * revert's "fall back to the pre-patch snapshot" posture, scoped to the
 * key this lifecycle actually changed.
 *
 * Failure posture: the uploaded doc is NEVER deleted as compensation. The
 * service dedupes re-uploads by content hash (the id is hash-derived), so
 * the author's retry re-runs the attach and converges; a compensating
 * delete would instead race the async processing (a just-202'd doc has no
 * contents row yet) and could not be made reliable.
 */
import { NextResponse } from "next/server";
import {
  AgentosError,
  agentosErrorResponse,
  deriveRequirementsFromConfig,
  fetchAgentosModels,
  fetchBuilderTools,
  fetchKnowledgeConfig,
  fetchKnowledgeList,
  getAgentosComponent,
  getAgentosCurrentConfig,
  knowledgeCorpusName,
  updateAgentosConfig,
  type KnowledgeContentRow,
} from "@/lib/agents/builder";
import { updateAgent, getAgent } from "@/lib/agents/agent-store";
import { listConnectors } from "@/lib/connectors/connector-store";
import type { AgentEntry, AgentRequirements } from "@/lib/agents/agents.config";

/** The existing concurrent-edit copy (shared with the builder PATCH route). */
const CONCURRENT_EDIT_MESSAGE =
  "This agent was just updated by someone else — reload and try again.";

/**
 * Resolve the agent for the author-gated curation routes — the builder
 * PATCH/DELETE semantics: 404 for missing/non-builder rows (no existence
 * oracle for foreign rows), 403 for anyone-but-author (no admin override).
 * Returns the response to short-circuit with, or the row.
 */
export async function resolveCuratedAgent(
  id: string,
  orgId: string,
  userId: string,
): Promise<{ error: NextResponse } | { agent: AgentEntry }> {
  const existing = await getAgent(id, orgId);
  if (!existing) {
    return { error: NextResponse.json({ error: "Agent not found" }, { status: 404 }) };
  }
  if (existing.origin !== "builder" || !existing.remoteAgentId) {
    return { error: NextResponse.json({ error: "Agent not found" }, { status: 404 }) };
  }
  if (existing.authorUserId !== userId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { agent: existing };
}

/** The config's knowledge ref when well-formed (`{name}`), else null. */
function knowledgeRefOf(
  config: Record<string, unknown>,
): { name: string } | null {
  const ref = config.knowledge;
  if (ref === undefined || ref === null) return null;
  if (typeof ref !== "object" || Array.isArray(ref)) return null;
  const name = (ref as { name?: unknown }).name;
  return typeof name === "string" && name ? { name } : null;
}

/** The snapshot minus its knowledge field (the detach diff — exact, since
 *  attach/detach change nothing else in the config). Rest, not a hand-listed
 *  shape: a future AgentRequirements field must survive the fallback, not
 *  be silently dropped with knowledge. */
function withoutKnowledge(requirements: AgentRequirements): AgentRequirements {
  const rest: AgentRequirements = { ...requirements };
  delete rest.knowledge;
  return rest;
}

/**
 * Publish the config with (attach) or without (detach) the knowledge ref.
 * Returns null on success/no-op, or the error response the caller route
 * should return; throws only what agentosErrorResponse understands
 * (AgentosError).
 */
async function publishKnowledgeRefDiff(
  agent: AgentEntry,
  remoteAgentId: string,
  orgId: string,
  attach: boolean,
): Promise<NextResponse | null> {
  // Reads first — the current config is the diff base and the component
  // carries the CAS guard version. The catalogs are fetched only when the
  // diff will actually run (a no-op must not fail on an unrelated catalog
  // hiccup).
  const [currentConfig, component] = await Promise.all([
    getAgentosCurrentConfig(remoteAgentId),
    getAgentosComponent(remoteAgentId),
  ]);
  if (!currentConfig) {
    return NextResponse.json(
      { error: "Couldn't read this agent's current configuration — reload and try again." },
      { status: 409 },
    );
  }
  // No-op when the config is already in the requested state: subsequent
  // docs skip the attach; a ref-less config skips the detach.
  if (attach && knowledgeRefOf(currentConfig) !== null) return null;
  if (!attach && !("knowledge" in currentConfig)) return null;

  // The attach needs the embedding contract ({provider, model} — the
  // snapshot's knowledge field) from the capability signal, fetched once
  // at attach time. A 202 upload with a disabled capability is a raced
  // probe: fail loud, the doc stays, the retry re-runs the attach.
  const knowledgeCfg = attach ? await fetchKnowledgeConfig() : undefined;
  if (attach && knowledgeCfg && !knowledgeCfg.enabled) {
    return NextResponse.json(
      { error: "The knowledge upload was accepted but couldn't be attached to this agent — please try again." },
      { status: 502 },
    );
  }
  const knowledgeContract = knowledgeCfg
    ? { provider: knowledgeCfg.provider, model: knowledgeCfg.model }
    : undefined;

  const [models, tools, connectors] = await Promise.all([
    fetchAgentosModels(),
    fetchBuilderTools(),
    listConnectors(orgId),
  ]);

  const nextConfig: Record<string, unknown> = { ...currentConfig };
  if (attach) {
    nextConfig.knowledge = { name: knowledgeCorpusName(remoteAgentId) };
  } else {
    delete nextConfig.knowledge;
  }

  const derived = deriveRequirementsFromConfig(
    nextConfig,
    models,
    tools,
    new Map(connectors.map((c) => [c.id, c.name] as const)),
    knowledgeContract,
  );
  if (!derived) {
    // The single-key-diff fallback — the config diff IS only the
    // knowledge key, so the existing snapshot (derived from this same
    // config at the last save) ± knowledge is exact even when full
    // re-derivation can't run.
    console.warn("[knowledge] requirements re-derivation declined — applying the single-key diff", {
      agentId: agent.id,
      remoteAgentId,
      orgId,
      attach,
    });
  }
  const nextRequirements: AgentRequirements | null =
    derived ??
    (agent.requirements
      ? attach
        ? { ...agent.requirements, ...(knowledgeContract ? { knowledge: knowledgeContract } : {}) }
        : withoutKnowledge(agent.requirements)
      : null);

  // 1) Local row first (the projection never leads the AgentOS — and the
  //    compensating revert below restores it when the publish fails).
  let updated: AgentEntry | null;
  try {
    updated = await updateAgent(agent.id, { requirements: nextRequirements }, orgId);
  } catch (err) {
    console.error("[knowledge] local snapshot update failed", {
      agentId: agent.id,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't update this agent's knowledge — please try again." },
      { status: 500 },
    );
  }
  if (!updated) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // 2) The guarded platform publish — a 409 means a concurrent edit won.
  try {
    await updateAgentosConfig(
      remoteAgentId,
      nextConfig,
      component.current_version ?? 0,
    );
  } catch (err) {
    // Compensating revert — restore the pre-call snapshot so the local
    // row doesn't describe a config the platform refused. Same tradeoff
    // as the PATCH revert: a concurrent edit to the same field diverges
    // either way; the retry-after-reload path fixes it.
    await updateAgent(
      agent.id,
      { requirements: agent.requirements ?? null },
      orgId,
    ).catch((revertErr) => {
      console.error("[knowledge] compensating local revert failed", {
        agentId: agent.id,
        orgId,
        error: revertErr instanceof Error ? revertErr.message : String(revertErr),
      });
    });
    if (err instanceof AgentosError && err.status === 409) {
      return NextResponse.json({ error: CONCURRENT_EDIT_MESSAGE }, { status: 409 });
    }
    return agentosErrorResponse(err);
  }
  return null;
}

/**
 * Ensure the agent's stored config references its corpus — called after a
 * successful upload. A no-op when the ref is already present (subsequent
 * docs); the attach publish runs only on the agent's FIRST document.
 * Returns null on success/no-op, or the error response to return.
 */
export async function ensureKnowledgeAttached(
  agent: AgentEntry,
  orgId: string,
): Promise<NextResponse | null> {
  if (!agent.remoteAgentId) return null;
  return publishKnowledgeRefDiff(agent, agent.remoteAgentId, orgId, true);
}

/**
 * Drop the agent's config knowledge ref once its corpus is empty — called
 * after a successful content delete. The corpus list (fetched AFTER the
 * delete, so a raced concurrent upload's landed row keeps the ref) is the
 * truth about "last doc" — best-effort, not airtight: a just-202'd upload
 * inserts its contents row inside agno's background process_content, so
 * until it lands the doc is invisible to this list and an upload+delete
 * interleave can publish a ref-less config while the doc exists (the run
 * degrades to no retrieval — the snapshot's knowledge leaves in the same
 * publish, so the run gate doesn't 402 either). The invariant self-heals
 * on the next curation action (the next upload re-attaches); airtight
 * would need the service to insert the row synchronously with the 202,
 * which is agno's shape, not ours.
 *
 * The list fetch failure propagates (the route maps it): the delete
 * succeeded, the retry is idempotent and re-runs the detach.
 */
export async function maybeDetachKnowledge(
  agent: AgentEntry,
  orgId: string,
): Promise<NextResponse | null> {
  if (!agent.remoteAgentId) return null;
  let rows: KnowledgeContentRow[];
  try {
    rows = await fetchKnowledgeList(agent.remoteAgentId);
  } catch (err) {
    console.error("[knowledge] corpus list fetch failed after delete — detach deferred to the retry", {
      agentId: agent.id,
      remoteAgentId: agent.remoteAgentId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  if (rows.length > 0) return null; // docs remain — the ref stays
  return publishKnowledgeRefDiff(agent, agent.remoteAgentId, orgId, false);
}

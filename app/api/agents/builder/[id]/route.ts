/**
 * Builder agent update/delete route — PATCH + DELETE /api/agents/builder/[id].
 *
 * Author-only (authorUserId === user.id — no admin override; the plan keeps
 * builder agents under their creator's control). Members can READ via the
 * org's GET /api/agents; only the author can edit or delete.
 *
 * PATCH is two-phase (local row first, AgentOS second) with a compensating
 * revert when the AgentOS half fails, so the local projection never leads
 * the AgentOS. Config changes (instructions/model/tools) publish a new
 * component version guarded with the component's current_version; a 409
 * from the AgentOS means a concurrent edit landed first.
 */
import { NextResponse } from "next/server";
import {
  getAgent,
  updateAgent,
  deleteAgent,
  toPublicAgent,
} from "@/lib/agents/agent-store";
import {
  builderUpdateBodySchema,
  buildComponentConfig,
  buildRequirements,
  type AgentosModel,
  fetchAgentosModels,
  fetchBuilderTools,
  getAgentosComponent,
  getAgentosCurrentConfig,
  resolveBuilderModel,
  updateAgentosComponentMeta,
  updateAgentosConfig,
  deleteAgentosComponent,
  AgentosError,
  BuilderValidationError,
} from "@/lib/agents/builder";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { getConnectorsByNames } from "@/lib/connectors/connector-store";
import type { UpdateBuilderAgentInput } from "@/lib/agents/agent-store";
import { agentosErrorResponse } from "@/lib/agents/builder";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  const { id } = await params;
  const existing = await getAgent(id, user.orgId);
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  // Author-only edits; non-builder agents are not addressable here at all.
  if (existing.origin !== "builder" || !existing.remoteAgentId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (existing.authorUserId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = builderUpdateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  // Guard source for both AgentOS writes — one GET before any writes.
  // SAFE to reuse one version across both writes: agno's component meta
  // PATCH (name/description) does NOT bump the version — only config
  // publishes create versions. If an agno upgrade ever changes that, the
  // second write 409s and the compensating revert below silently discards
  // the user's edit — re-fetch the component between the writes in that
  // case. (Verified against agno's components router at the spike.)
  let component;
  try {
    component = await getAgentosComponent(existing.remoteAgentId);
  } catch (err) {
    return agentosErrorResponse(err);
  }
  if (component.deleted_at) {
    return NextResponse.json(
      { error: "Agent not found" },
      { status: 404 },
    );
  }

  const metaChanged = patch.name !== undefined || patch.description !== undefined;
  const configChanged =
    patch.instructions !== undefined ||
    patch.model !== undefined ||
    patch.tools !== undefined ||
    patch.connectors !== undefined;

  // Resolve the next local-row values (the compensating revert needs the
  // existing ones regardless).
  const nextLocal = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
  };
  let nextRequirements = existing.requirements;
  let nextConfig: Record<string, unknown> | undefined;

  if (configChanged) {
    // Config changes re-derive platformTier from the catalog + tool
    // parameters from the registry (same trust posture as create).
    let models, platformTools;
    try {
      [models, platformTools] = await Promise.all([
        fetchAgentosModels(),
        fetchBuilderTools(),
      ]);
    } catch (err) {
      return agentosErrorResponse(err);
    }

    // Model/tools/connectors replace wholesale when present; instructions
    // must come from the current config when not patched (it is not stored
    // locally — only the AgentOS component config holds it).
    let resolvedInstructions: string;    if (patch.instructions === undefined) {
      // The AgentOS must be reachable to read back the current instructions.
      let currentConfig;
      try {
        currentConfig = await getAgentosCurrentConfig(existing.remoteAgentId);
      } catch (err) {
        return agentosErrorResponse(err);
      }
      const currentEntries = currentConfig?.instructions;
      // An empty instructions array is as unusable as a missing one —
      // builder agents always carry a system prompt (min 1 char at create).
      const currentInstructions =
        Array.isArray(currentEntries) && currentEntries.length > 0
          ? currentEntries.join("\n")
          : undefined;
      if (currentInstructions === undefined) {
        return NextResponse.json(
          { error: "Cannot update the agent without its current instructions." },
          { status: 409 },
        );
      }
      resolvedInstructions = currentInstructions;
    } else {
      resolvedInstructions = patch.instructions;
    }

    // Model resolution against the catalog — client input, so a 400 (not a
    // 500) on an unknown model. This also covers the unpatched-model path:
    // if the agent's stored model has since left the catalog, a config
    // patch can't proceed without re-resolving it.
    let model: AgentosModel;
    try {
      if (patch.model) {
        model = resolveBuilderModel(patch.model, models);
      } else if (existing.requirements) {
        model = resolveBuilderModel(existing.requirements.model, models);
      } else {
        // No snapshot to re-resolve from — the config can't be rebuilt.
        // The row predates the snapshot column; ask the author to re-save
        // the model with the patch.
        return NextResponse.json(
          { error: "This agent's saved model could not be resolved — pick a model in this update and try again." },
          { status: 409 },
        );
      }
    } catch (err) {
      if (err instanceof BuilderValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // A snapshot-less row can only be config-patched with a FULL config
    // (model + tools + connectors): anything left unpatched can't be
    // re-derived, and defaulting it to [] would publish a config that
    // silently drops the agent's real tools/connectors — the same rule
    // the model 409 above applies to the model half. Unreachable through
    // the app (every builder create writes a snapshot); this guards
    // hand-edited rows and future create paths.
    if (
      !existing.requirements &&
      (patch.tools === undefined || patch.connectors === undefined)
    ) {
      return NextResponse.json(
        {
          error:
            "This agent's saved configuration is incomplete — include its model, tools, and connectors in this update.",
        },
        { status: 409 },
      );
    }
    // Reaching here with no snapshot means the patch supplied the full
    // config — the `?? []` fallbacks can no longer fire.
    const tools = patch.tools ?? existing.requirements?.tools.map((t) => ({ name: t.name })) ?? [];
    const connectors = patch.connectors ?? existing.requirements?.connectors ?? [];

    if (patch.connectors) {
      const orgConnectors = await getConnectorsByNames(user.orgId, patch.connectors);
      const missing = patch.connectors.filter((name) => !orgConnectors.has(name));
      if (missing.length) {
        return NextResponse.json(
          { error: `Unknown connector${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` },
          { status: 400 },
        );
      }
    }

    const spec = {
      name: nextLocal.name,
      instructions: resolvedInstructions,
      tools,
      connectors,
    };
    try {
      nextConfig = buildComponentConfig(existing.remoteAgentId, spec, model, platformTools);
      // Same tool validation as buildComponentConfig — guarded too so a
      // stale tool name can never escape as a raw 500.
      nextRequirements = buildRequirements(spec, model, platformTools);
    } catch (err) {
      if (err instanceof BuilderValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  // 1) Local row first, with a compensating revert below if the AgentOS
  //    half fails (the local projection never leads the AgentOS).
  let updated;
  try {
    updated = await updateAgent(
      id,
      {
        name: nextLocal.name,
        description: nextLocal.description,
        ...(nextRequirements ? { requirements: nextRequirements } : {}),
      },
      user.orgId,
    );
  } catch (err) {
    // Same guard as the create route — a zod failure on a merged legacy
    // row or a transient DB error must not escape as a raw stack-trace 500.
    console.error("[builder] local update failed", {
      agentId: id,
      orgId: user.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't update the agent — please try again." },
      { status: 500 },
    );
  }
  if (!updated) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  let metaApplied = false;
  try {
    if (metaChanged) {
      await updateAgentosComponentMeta(
        existing.remoteAgentId,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
        },
        component.current_version ?? 0,
      );
      metaApplied = true;
    }
    if (configChanged && nextConfig) {
      await updateAgentosConfig(
        existing.remoteAgentId,
        nextConfig,
        component.current_version ?? 0,
      );
    }
  } catch (err) {
    // Compensating revert — restore ONLY the fields this PATCH actually
    // wrote locally. A wholesale revert to the pre-patch snapshot would
    // also clobber fields this request never touched (e.g. a concurrent
    // meta edit landing between our read and our revert).
    //
    // Runs on a 409 too: the AgentOS write was refused, so the local row
    // currently LEADS the AgentOS — restoring our pre-patch values
    // re-converges the projection for any concurrent edit to a disjoint
    // field. A concurrent edit to the SAME field diverges either way
    // (the retry-after-reload path fixes it); reverting is never worse.
    // Restore ONLY the fields this PATCH actually wrote. requirements is
    // restored UNCONDITIONALLY on a config change — null included: a
    // snapshot-less row that gained a snapshot from this patch must lose
    // it again on failure, or the local projection would lead the
    // AgentOS (exactly the state this revert exists to prevent).
    const revert: UpdateBuilderAgentInput = {};
    if (patch.name !== undefined) revert.name = existing.name;
    if (patch.description !== undefined) revert.description = existing.description;
    if (configChanged) revert.requirements = existing.requirements ?? null;
    if (Object.keys(revert).length > 0) {
      await updateAgent(id, revert, user.orgId).catch((revertErr) => {
        console.error("[builder] compensating local revert failed", {
          agentId: id,
          orgId: user.orgId,
          error: revertErr instanceof Error ? revertErr.message : String(revertErr),
        });
      });
    }
    if (metaApplied) {
      // The meta write succeeded before the config publish failed: the
      // component now keeps the NEW name/description while the local row
      // reverted to the old ones (local LAGS the AgentOS). Left alone, a
      // later instructions-only PATCH publishes config.name from the
      // stale local name and clobbers the component. Best-effort re-PATCH
      // the component metadata back to the pre-patch values, reading the
      // component first for the post-meta-write CAS version. A concurrent
      // meta edit in this window diverges either way (same tradeoff the
      // local revert makes); log-and-continue like the delete path.
      try {
        const fresh = await getAgentosComponent(existing.remoteAgentId);
        await updateAgentosComponentMeta(
          existing.remoteAgentId,
          {
            ...(patch.name !== undefined ? { name: existing.name } : {}),
            ...(patch.description !== undefined ? { description: existing.description } : {}),
          },
          fresh.current_version ?? 0,
        );
      } catch (metaRevertErr) {
        console.error("[builder] compensating component-meta revert failed", {
          agentId: id,
          remoteAgentId: existing.remoteAgentId,
          error: metaRevertErr instanceof Error ? metaRevertErr.message : String(metaRevertErr),
        });
      }
    }
    if (err instanceof AgentosError && err.status === 409) {
      return NextResponse.json(
        { error: "This agent was just updated by someone else — reload and try again." },
        { status: 409 },
      );
    }
    return agentosErrorResponse(err);
  }

  return NextResponse.json(toPublicAgent(updated));
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  const { id } = await params;
  const existing = await getAgent(id, user.orgId);
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (existing.origin !== "builder" || !existing.remoteAgentId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (existing.authorUserId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // AgentOS soft-delete best-effort: when it fails the local row is still
  // removed (the registry stops resolving it → no more runs), and the
  // orphaned component is logged for platform-side cleanup. A 404 (already
  // deleted) is fine.
  try {
    await deleteAgentosComponent(existing.remoteAgentId);
  } catch (err) {
    if (!(err instanceof AgentosError) || err.status !== 404) {
      console.error("[builder] AgentOS delete failed (local row still removed)", {
        agentId: id,
        remoteAgentId: existing.remoteAgentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const deleted = await deleteAgent(id, user.orgId);
  if (!deleted) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

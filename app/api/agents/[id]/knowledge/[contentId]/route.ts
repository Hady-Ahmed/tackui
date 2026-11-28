/**
 * DELETE /api/agents/[id]/knowledge/[contentId] — remove one doc from the
 * agent's corpus. Author-only (the builder PATCH/DELETE semantics, shared
 * with the parent route). The service delete is idempotent (an unknown id
 * is still {ok: true}); after it succeeds, deleting the LAST doc runs the
 * detach lifecycle (the config's knowledge ref is dropped).
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import {
  agentosErrorResponse,
  deleteKnowledgeContent,
} from "@/lib/agents/builder";
import { maybeDetachKnowledge, resolveCuratedAgent } from "../lifecycle";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; contentId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = checkUserLimit(user.id, "knowledgeMutate");
  if (limited) return limited;

  const { id, contentId } = await params;
  const resolved = await resolveCuratedAgent(id, user.orgId, user.id);
  if ("error" in resolved) return resolved.error;
  const existing = resolved.agent;

  try {
    await deleteKnowledgeContent({
      componentId: existing.remoteAgentId!,
      contentId,
    });
  } catch (err) {
    return agentosErrorResponse(err);
  }

  // Detach phase — the corpus list (fetched after the delete) decides
  // whether the config's knowledge ref goes with it.
  let detachError: NextResponse | null;
  try {
    detachError = await maybeDetachKnowledge(existing, user.orgId);
  } catch (err) {
    return agentosErrorResponse(err);
  }
  if (detachError) return detachError;

  return NextResponse.json({ ok: true });
}

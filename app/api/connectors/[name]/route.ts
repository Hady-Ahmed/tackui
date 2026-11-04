/**
 * DELETE /api/connectors/[name] — remove one org connector (org-admin only).
 * 404 when the org has no connector by that name.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { AgentosError, agentosErrorResponse } from "@/lib/agents/builder";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { deleteConnector, getConnectorsByNames } from "@/lib/connectors/connector-store";
import { deletePlatformConnector } from "@/lib/connectors/platform-sync";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await canManageAgents(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = checkUserLimit(user.id, "connectorMutate");
  if (limited) return limited;

  const { name } = await params;
  // Push-first-then-commit (mirrors the upsert): remove the platform
  // registry entry BEFORE the local row, so a failed push means nothing
  // changed — the admin sees the error and retries. Deleting an entry the
  // registry doesn't have is success (the delete IS the state).
  const existing = (await getConnectorsByNames(user.orgId, [name])).get(name);
  if (!existing) {
    return NextResponse.json({ error: "Connector not found" }, { status: 404 });
  }
  try {
    await deletePlatformConnector(existing.id);
  } catch (err) {
    // A platform failure must surface as 502 (upstream), not 500 — the
    // local row was NOT deleted (push-first), so a retry is safe.
    if (err instanceof AgentosError) {
      console.error("[connectors] platform delete failed — local row unchanged", {
        orgId: user.orgId,
        name,
        error: err.message,
      });
      return agentosErrorResponse(err);
    }
    throw err;
  }
  const deleted = await deleteConnector(user.orgId, name);
  if (!deleted) {
    return NextResponse.json({ error: "Connector not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

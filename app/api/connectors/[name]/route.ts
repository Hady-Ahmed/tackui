/**
 * DELETE /api/connectors/[name] — remove one org connector (org-admin only).
 * 404 when the org has no connector by that name.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { deleteConnector } from "@/lib/connectors/connector-store";

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
  const deleted = await deleteConnector(user.orgId, name);
  if (!deleted) {
    return NextResponse.json({ error: "Connector not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

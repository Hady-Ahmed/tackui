/**
 * DELETE /api/credentials/[provider] — remove the runner's key for a
 * provider. Accepts ANY saved provider string: if a provider left the
 * platform catalog, its saved key must still be deletable (a stale
 * catalog must never lock a key in). 404 only when nothing is saved.
 *
 * This route is not gated on the platform being reachable — deletion is a
 * local-DB operation.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { deleteCredential } from "@/lib/credentials/credential-store";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = checkUserLimit(user.id, "credentialMutate");
  if (limited) return limited;

  const { provider } = await params;
  const deleted = await deleteCredential(user.id, provider);
  if (!deleted) {
    return NextResponse.json(
      { error: "No credential stored for this provider" },
      { status: 404 },
    );
  }
  return NextResponse.json({ provider, deleted: true });
}

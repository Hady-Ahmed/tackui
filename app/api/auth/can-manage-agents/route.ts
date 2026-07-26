import { NextResponse } from "next/server";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;
  const canManage = await canManageAgents(user);
  return NextResponse.json({ canManage });
}

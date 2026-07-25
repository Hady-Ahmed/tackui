import { NextResponse } from "next/server";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const canManage = await canManageAgents(user);
  return NextResponse.json({ canManage });
}

import { NextResponse } from "next/server";
import {
  listAgents,
  createAgent,
  agentEntrySchema,
} from "@/lib/agents/agent-store";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await listAgents(user.orgId));
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await canManageAgents(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = agentEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // Platform admin creates in their own org (or can override later).
    // For now, agents are created in the admin's active org.
    const created = await createAgent(parsed.data, user.orgId);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    // PG unique-violation SQLSTATE = 23505
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: `Agent with id "${parsed.data.id}" already exists` },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import {
  getAgent,
  updateAgent,
  deleteAgent,
  agentEntrySchema,
  toPublicAgent,
} from "@/lib/agents/agent-store";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";

const partialSchema = agentEntrySchema.partial();

const SSRF_MESSAGE =
  "Endpoint resolves to a private or internal address. " +
  "Set ALLOW_PRIVATE_ENDPOINTS=true if this is intentional (e.g. " +
  "agent backend running on the same host).";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const agent = await getAgent(id, user.orgId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;
  return NextResponse.json(toPublicAgent(agent));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await canManageAgents(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = partialSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // SSRF guard: when the endpoint is being changed, validate the new URL
  // before persisting it. Only fires when `endpoint` is in the PATCH body
  // — editing other fields (name, description) on an existing
  // private-endpoint agent does NOT re-trigger the guard.
  if (parsed.data.endpoint !== undefined) {
    try {
      await assertSafeUrl(parsed.data.endpoint);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        return NextResponse.json({ error: SSRF_MESSAGE }, { status: 400 });
      }
      throw err;
    }
  }

  const updated = await updateAgent(id, parsed.data, user.orgId);
  if (!updated) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
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
  if (!(await canManageAgents(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  const { id } = await params;
  const ok = await deleteAgent(id, user.orgId);
  if (!ok) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

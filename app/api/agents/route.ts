import { NextResponse } from "next/server";
import {
  listAgents,
  createAgent,
  createAgentBodySchema,
  toPublicAgents,
  toPublicAgent,
} from "@/lib/agents/agent-store";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";

const SSRF_MESSAGE =
  "Endpoint resolves to a private or internal address. " +
  "Set ALLOW_PRIVATE_ENDPOINTS=true if this is intentional (e.g. " +
  "agent backend running on the same host).";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;
  return NextResponse.json(toPublicAgents(await listAgents(user.orgId)));
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await canManageAgents(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createAgentBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // SSRF guard: reject endpoints that resolve to private/internal IPs
  // before persisting them. Set ALLOW_PRIVATE_ENDPOINTS=true to opt in
  // (for self-hosters running agent backends on the same host).
  try {
    await assertSafeUrl(parsed.data.endpoint);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ error: SSRF_MESSAGE }, { status: 400 });
    }
    throw err;
  }

  try {
    // The agent `id` is server-generated (never client-supplied) — see
    // generateAgentId in lib/agents/agent-store.ts. With the composite
    // PK `(id, org_id)` and 48-bit random ids, a 23505 here is a real
    // bug (not a retryable race) — log it loudly.
    const created = await createAgent(parsed.data, user.orgId);
    return NextResponse.json(toPublicAgent(created), { status: 201 });
  } catch (err) {
    // PG unique-violation SQLSTATE = 23505. Should be effectively
    // impossible with random ids; if it fires, surface the error rather
    // than masking it as a user-facing "already exists".
    if ((err as { code?: string }).code === "23505") {
      console.error("[agents] unexpected 23505 on create (random id collision?)", {
        orgId: user.orgId,
      });
      return NextResponse.json(
        { error: "Failed to generate a unique agent id. Please retry." },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

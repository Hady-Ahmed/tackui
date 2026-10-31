import { NextResponse } from "next/server";
import {
  getAgent,
  updateAgent,
  deleteAgent,
  updateAgentBodySchema,
  toPublicAgent,
} from "@/lib/agents/agent-store";
import { annotateAgentTemplateState } from "@/lib/catalog/template-store";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { SSRF_REJECTION_MESSAGE } from "@/lib/config/saas";
import { deleteAgentosComponent, AgentosError } from "@/lib/agents/builder";

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
  const [annotated] = await annotateAgentTemplateState([agent]);
  return NextResponse.json(annotated);
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
  // Managed agents (catalog installs) are references to their template:
  // the runtime resolves config live from the template, so org-side
  // edits would be ignored at run time — and the endpoint is curator
  // infrastructure. Fully locked; only Remove (DELETE) is offered.
  const existing = await getAgent(id, user.orgId);
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (existing.sourceTemplateId) {
    return NextResponse.json(
      {
        error:
          "This agent is managed by the agent catalog and can't be edited. Remove it from your workspace instead.",
        code: "AGENT_MANAGED",
      },
      { status: 400 },
    );
  }
  // Builder-origin rows are projection-only on this route: their runtime
  // config lives in the AgentOS component (versioned, edited via
  // /api/agents/builder), so PATCHing endpoint/authMode/jwtSecret here
  // would write fields the registry ignores while desyncing the local
  // name/description from the AgentOS component with no sync path. The
  // builder route owns every edit for these rows (author or org admin).
  if (existing.origin === "builder") {
    return NextResponse.json(
      {
        error:
          "This agent was built with the agent builder and is edited there — not through this page.",
        code: "AGENT_BUILDER_MANAGED",
      },
      { status: 400 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = updateAgentBodySchema.safeParse(body);
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
        return NextResponse.json({ error: SSRF_REJECTION_MESSAGE }, { status: 400 });
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
  const agent = await getAgent(id, user.orgId);

  // Builder-origin rows carry a remote AgentOS component — removing the
  // local row alone would orphan it (a live component with no projection).
  // Best-effort soft-delete mirrors the builder route: a failure doesn't
  // block the local removal (the registry stops resolving the row → no
  // more runs; the orphan is logged for platform-side cleanup). A 404
  // (already deleted) is fine.
  if (agent?.origin === "builder" && agent.remoteAgentId) {
    try {
      await deleteAgentosComponent(agent.remoteAgentId);
    } catch (err) {
      if (!(err instanceof AgentosError) || err.status !== 404) {
        console.error("[agents] builder component delete failed (local row still removed)", {
          agentId: id,
          remoteAgentId: agent.remoteAgentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const ok = await deleteAgent(id, user.orgId);
  if (!ok) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

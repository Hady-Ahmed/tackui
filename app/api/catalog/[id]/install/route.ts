import { NextResponse } from "next/server";
import {
  getTemplate,
  findInstalledAgentId,
  installTemplate,
  toPublicTemplate,
} from "@/lib/catalog/template-store";
import { toPublicAgent } from "@/lib/agents/agent-store";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import {
  checkAgentCountLimit,
  checkTemplateInstall,
} from "@/lib/plans/enforcement";

/**
 * POST /api/catalog/[id]/install — one-click install of a catalog
 * template into the caller's workspace.
 *
 * Idempotent: installing an already-installed template RE-SYNCS the
 * stored config from the template (endpoint fixes, secret rotation)
 * onto the existing agent row — agent id preserved, threads intact.
 * That's the "Update" button on the catalog card.
 *
 * Gates, in order:
 *   1. canManageAgents — installing changes the org's agent list, so it
 *      needs org owner/admin (same as manual agent creation).
 *   2. checkTemplateInstall — requiredPlan gate (SaaS). Applies on the
 *      re-sync path too: a downgraded org must not refresh a gated agent.
 *   3. checkAgentCountLimit — plan agent cap (SaaS). Skipped on the
 *      re-sync path (no new row).
 */
export async function POST(
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
  const template = await getTemplate(id);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  if (!template.isActive) {
    return NextResponse.json(
      { error: "This template is no longer available." },
      { status: 400 },
    );
  }

  const planLimited = await checkTemplateInstall(template, user.orgId);
  if (planLimited) return planLimited;

  const existingAgentId = await findInstalledAgentId(template.id, user.orgId);
  if (!existingAgentId) {
    // New install only: enforce the plan's agent-count cap (SaaS).
    const countLimited = await checkAgentCountLimit(user.orgId);
    if (countLimited) return countLimited;
  }

  try {
    const result = await installTemplate(template, user.orgId);
    return NextResponse.json(
      {
        agent: toPublicAgent(result.agent),
        installed: result.installed,
        updated: result.updated,
        template: toPublicTemplate(template),
      },
      { status: result.installed ? 201 : 200 },
    );
  } catch (err) {
    console.error("[catalog] install failed", {
      templateId: id,
      orgId: user.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to install template. Check server logs." },
      { status: 500 },
    );
  }
}

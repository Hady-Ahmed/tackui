import { NextResponse } from "next/server";
import {
  getTemplate,
  updateTemplate,
  deleteTemplate,
  updateTemplateBodySchema,
  toPublicTemplate,
  countTemplateInstalls,
} from "@/lib/catalog/template-store";
import { getCurrentUser } from "@/lib/auth/context";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { SSRF_REJECTION_MESSAGE } from "@/lib/config/saas";

function isPlatformAdmin(role: string): boolean {
  return role === "admin";
}

/**
 * GET /api/catalog/[id] — template detail + install count (platform
 * admin only). The count powers the delete confirmation's "N workspaces
 * have this installed" blast-radius warning.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPlatformAdmin(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

  const { id } = await params;
  const template = await getTemplate(id);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  const installCount = await countTemplateInstalls(id);
  return NextResponse.json({ ...toPublicTemplate(template), installCount });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPlatformAdmin(user.role)) {
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

  const parsed = updateTemplateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // SSRF guard: only when the endpoint is being changed (same rule as
  // agent PATCH — editing other fields never re-triggers the guard).
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

  try {
    const updated = await updateTemplate(id, parsed.data);
    if (!updated) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    return NextResponse.json(toPublicTemplate(updated));
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "A template with that slug already exists." },
        { status: 409 },
      );
    }
    console.error("[catalog] update failed", {
      templateId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to update template. Check server logs." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPlatformAdmin(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  const { id } = await params;
  const ok = await deleteTemplate(id);
  if (!ok) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  // Installed copies are deliberately NOT deleted — they belong to the
  // orgs that installed them (see countTemplateInstalls for the UI's
  // blast-radius warning before this fires).
  return new NextResponse(null, { status: 204 });
}

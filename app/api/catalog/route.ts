import { NextResponse } from "next/server";
import {
  listTemplates,
  createTemplate,
  createTemplateBodySchema,
  toPublicTemplates,
  toPublicTemplate,
} from "@/lib/catalog/template-store";
import { getCurrentUser } from "@/lib/auth/context";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { SSRF_REJECTION_MESSAGE } from "@/lib/config/saas";

/**
 * Catalog templates are managed by PLATFORM admins (role === "admin"),
 * not org owners — the catalog is a global, cross-org surface. The
 * admin CRUD reuses the agentMutate/agentRead rate-limit buckets.
 */

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

  // ?all=1 (platform admins only) includes deactivated templates for
  // the admin CRUD UI. Everyone else sees the active catalog only.
  const url = new URL(request.url);
  const wantsAll = url.searchParams.get("all") === "1";
  const templates = await listTemplates({ activeOnly: !(wantsAll && user.role === "admin") });
  return NextResponse.json(toPublicTemplates(templates));
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== "admin") {
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

  const parsed = createTemplateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // SSRF guard on the template endpoint — same posture as agent
  // create/edit. Templates are curated by platform admins, but the
  // guard is defense in depth (and self-host platform admins are just
  // the first user).
  try {
    await assertSafeUrl(parsed.data.endpoint);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ error: SSRF_REJECTION_MESSAGE }, { status: 400 });
    }
    throw err;
  }

  try {
    const created = await createTemplate(parsed.data);
    return NextResponse.json(toPublicTemplate(created), { status: 201 });
  } catch (err) {
    // PG unique-violation = slug collision (the id is random, so the
    // only unique constraint that can fire is slug).
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: `A template with the slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    // Mask internal errors (DB topology/schema leak) — log server-side.
    console.error("[catalog] create failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to create template. Check server logs." },
      { status: 500 },
    );
  }
}

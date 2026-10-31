/**
 * Platform catalog admin — tackui's proxy for the AgentOS admin catalog API.
 *
 * GET  /api/admin/platform/catalog  — discovery ∪ durable rows, both catalogs
 * PUT  /api/admin/platform/catalog  — full-state replace {providers?, tools?}
 *
 * This is the ONLY path the admin page gets: the AgentOS JWT secret never
 * reaches the browser (tackui mints the service token server-side). Gated
 * to platform admins only (role === "admin") — the catalog is global (one
 * shared AgentOS), so who may edit it must be global too; org owners/admins
 * must not set platform-wide policy. Rate-limited on the agentMutate
 * bucket. PUT validates nothing itself — the AgentOS is the source of
 * truth for the entry grammar and rejects bad entries with a 400 that is
 * passed through verbatim.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import {
  fetchPlatformCatalog,
  putPlatformCatalogModels,
  putPlatformCatalogTools,
  AgentosError,
} from "@/lib/agents/builder";

const putBodySchema = z
  .object({
    providers: z
      .array(
        z.object({
          slug: z.string().trim().min(1).max(64),
          enabled: z.boolean(),
          models: z.array(z.string().trim().min(1).max(300)),
        }),
      )
      .optional(),
    tools: z
      .array(
        z.object({
          slug: z.string().trim().min(1).max(64),
          enabled: z.boolean(),
        }),
      )
      .optional(),
  })
  .refine((body) => body.providers !== undefined || body.tools !== undefined, {
    message: "Nothing to update — send providers, tools, or both",
  });

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

  try {
    const catalog = await fetchPlatformCatalog();
    return NextResponse.json(catalog);
  } catch (err) {
    if (err instanceof AgentosError) {
      // Admin surface: the clean user message plus the upstream validation
      // detail (parsed) — operators need the platform's own "why".
      return NextResponse.json(
        { error: err.message, ...(err.detail ? { detail: err.detail } : {}) },
        { status: err.status },
      );
    }
    console.error("[admin/platform] catalog fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "The agent builder is unavailable right now — please try again shortly." },
      { status: 502 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  const body = await request.json().catch(() => null);
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Tracks whether the providers PUT succeeded — visible in the catch so a
  // partial failure can say "the models half applied" instead of implying
  // nothing was saved.
  let providersApplied = false;
  try {
    // Two independent PUTs; apply both, report the higher revision. An
    // AgentOS 400 (bad model entry, unknown slug) passes through verbatim
    // so the admin sees the platform's own validation message.
    let revision = 0;
    const warnings: string[] = [];
    if (parsed.data.providers) {
      const result = await putPlatformCatalogModels(parsed.data.providers);
      providersApplied = true;
      revision = Math.max(revision, result.revision);
      warnings.push(...result.warnings);
    }
    if (parsed.data.tools) {
      const result = await putPlatformCatalogTools(parsed.data.tools);
      revision = Math.max(revision, result.revision);
      warnings.push(...result.warnings);
    }
    return NextResponse.json({
      ok: true,
      revision,
      // The platform's soft notes on a successful save (skipped rows,
      // normalized entries) — the admin never sees them otherwise, since
      // hard failures already 400 with full detail.
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (err) {
    if (err instanceof AgentosError) {
      // Admin surface: the clean user message plus the upstream validation
      // detail (parsed) — operators need the platform's own "why". When
      // the providers half already applied, say so: a bare 400 would read
      // as "nothing saved" when the models half is live.
      const appliedNote = providersApplied
        ? "The model providers were saved before this failure. "
        : "";
      return NextResponse.json(
        {
          error: err.message,
          ...(err.detail || appliedNote
            ? { detail: `${appliedNote}${err.detail ?? ""}`.trim() || undefined }
            : {}),
        },
        { status: err.status },
      );
    }
    console.error("[admin/platform] catalog update failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "The agent builder is unavailable right now — please try again shortly." },
      { status: 502 },
    );
  }
}

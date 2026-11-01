/**
 * POST /api/admin/platform/test-model — probe one model entry through the
 * AgentOS admin test endpoint (one "hi" completion straight to the provider
 * via the platform's own env key). Answers one question before the admin
 * enables the entry: does this model id exist and does the platform key
 * work? Runner keys are unaffected (BYOK runs bring their own).
 *
 * Body: {entry: "provider:model-id[:tier][:k=v ...]"} — the AgentOS
 * validates the grammar + attributes and answers 400 with its own message
 * when the entry is malformed; 502/503 when the provider or key is broken.
 * Gated to platform admins only (role === "admin") — same as the catalog
 * proxy; this endpoint mutates nothing but probes with platform keys.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { testPlatformModel, AgentosError } from "@/lib/agents/builder";

const testBodySchema = z.object({
  entry: z.string().trim().min(1).max(300),
});

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = checkUserLimit(user.id, "adminMutate");
  if (limited) return limited;

  const body = await request.json().catch(() => null);
  const parsed = testBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await testPlatformModel(parsed.data.entry);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AgentosError) {
      // Admin surface: the clean user message plus the upstream validation
      // detail (parsed) — operators need the platform's own "why".
      return NextResponse.json(
        { error: err.message, ...(err.detail ? { detail: err.detail } : {}) },
        { status: err.status },
      );
    }
    console.error("[admin/platform] model test failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "The agent builder is unavailable right now — please try again shortly." },
      { status: 502 },
    );
  }
}

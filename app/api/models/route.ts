/**
 * GET /api/models — the builder's model picker source.
 *
 * Server-side proxy to the AgentOS /platform/models catalog (service
 * token — the catalog is admin-only on the AgentOS; tackui re-exposes it
 * to signed-in org members for the builder UI). Every entry carries
 * `platform_tier`: platform-key models run without a runner key, everything
 * else shows the "needs your own key" badge and 402s at run time when the
 * runner hasn't connected the provider key.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { fetchAgentosModels, AgentosError } from "@/lib/agents/builder";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

  try {
    const models = await fetchAgentosModels();
    return NextResponse.json({
      models: models.map((m) => ({
        provider: m.provider,
        id: m.id,
        // platformTier is the canonical server-derived flag — dormant for
        // builder runs (100% BYOK; wakes at Phase 3 publishing) but kept in
        // the wire so the future needs no shape change.
        platformTier: m.platform_tier,
        // false for keyless providers (e.g. ollama) — no credential demanded.
        requiresKey: m.requires_key,
      })),
    });
  } catch (err) {
    if (err instanceof AgentosError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[models] unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "The agent platform is unavailable. Please retry shortly." },
      { status: 502 },
    );
  }
}

/**
 * GET /api/tools — the builder's tool palette, proxied server-side from the
 * AgentOS /platform/tools catalog (service token; the AgentOS catalog is
 * admin-only). Signed-in org members get it for the builder UI.
 *
 * Wire shape: camelCase flags the builder UI reads (requiresKey /
 * platformFallback); the json-schema parameters are included for
 * transparency but never trusted from the client — the server re-fetches
 * the catalog at create/update time (the run-gate/registry rehydration is
 * server-derived).
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { fetchBuilderTools, AgentosError } from "@/lib/agents/builder";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

  try {
    const tools = await fetchBuilderTools();
    return NextResponse.json({
      tools: tools.map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description ?? null,
        requiresKey: t.requires_key,
        fallbackEnv: t.fallback_env,
        platformFallback: t.platform_fallback,
        // The toolkit slug (the credential provider) + the full credential
        // contract — multi-credential toolkits list several fields.
        toolkit: t.toolkit,
        credentials: t.credentials,
        parameters: t.parameters ?? null,
      })),
    });
  } catch (err) {
    if (err instanceof AgentosError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[tools] unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "The agent builder is unavailable right now — please try again shortly." },
      { status: 502 },
    );
  }
}

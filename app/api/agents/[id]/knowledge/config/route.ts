/**
 * GET /api/agents/[id]/knowledge/config — the knowledge capability signal
 * for the builder form's Knowledge section, proxied server-side from the
 * service's GET /platform/knowledge/config with the service token (the
 * /api/tools proxy pattern).
 *
 * Member-accessible (any signed-in org member can build agents — the same
 * gate /api/tools applies) and addressed per agent so the form's edit
 * route owns the URL. Two distinct states ride the SAME 200 shape, per
 * fetchKnowledgeConfig's contract: `{enabled: true, provider, model}` is
 * "knowledge available", `{enabled: false, …, unsupported: true}` is "the
 * service answered and predates knowledge", and `{enabled: false, …}`
 * without the flag is "the service answered, knowledge is off". A
 * transport/5xx failure is the standard AgentosError shaping (502/503) —
 * the form's error banner covers it, NOT a "knowledge is off" claim.
 *
 * NOT author-gated: this is read-only capability metadata (no corpus rows,
 * no agent mutation) — the same posture as /api/tools' palette data. The
 * curation routes (list/upload/delete) keep the author-only gate. The
 * [id] in the URL is not looked up against the agents table — the
 * capability is deployment-wide, not per-agent, and a stale id must not
 * make a healthy capability read "unreachable" (the section's gating
 * decision is the same either way); the id only makes the URL
 * member-addressable alongside the section's other per-agent loads.
 *
 * Signature note: no params binding — the id is deliberately unread (see
 * above); Next still requires the file to live under the dynamic segment
 * so the form addresses it per agent.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { fetchKnowledgeConfig, AgentosError } from "@/lib/agents/builder";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

  try {
    const config = await fetchKnowledgeConfig();
    return NextResponse.json(config);
  } catch (err) {
    if (err instanceof AgentosError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[knowledge-config] unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "The agent builder is unavailable right now — please try again shortly." },
      { status: 502 },
    );
  }
}

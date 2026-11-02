/**
 * Builder create route — POST /api/agents/builder.
 *
 * Member-accessible (any signed-in org member can build an agent; unlike
 * the admin /api/agents routes there's no canManageAgents gate). The
 * request carries the builder form: name/description/instructions + model
 * (provider+id) + tool names + connector names. Everything builder-shaped
 * is re-derived server-side (see lib/agents/builder.ts trust posture):
 * platformTier from the AgentOS models catalog, tool parameters from the
 * registry, connector names against the org's connector store.
 *
 * No SSRF guard: the endpoint is builderEndpoint(remoteAgentId) —
 * platform-configured infrastructure, not user-supplied.
 *
 * Two-phase create with compensation: the local row is written first, then
 * the AgentOS component; if the AgentOS call fails, the local row is
 * deleted (compensating) so a retried create doesn't orphan half an agent.
 */
import { NextResponse } from "next/server";
import {
  createAgent,
  deleteAgent,
  generateAgentId,
  toPublicAgent,
} from "@/lib/agents/agent-store";
import {
  agentosErrorResponse,
  builderCreateBodySchema,
  buildComponentConfig,
  buildRequirements,
  createAgentosComponent,
  fetchAgentosModels,
  fetchBuilderTools,
  resolveBuilderModel,
  BuilderValidationError,
  AGENTOS_USER_SCOPE,
} from "@/lib/agents/builder";
import { builderEndpoint } from "@/lib/config/agentos";
import { getConnectorsByNames } from "@/lib/connectors/connector-store";
import { ensurePlatformConnectors } from "@/lib/connectors/platform-sync";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { checkAgentCountLimit } from "@/lib/plans/enforcement";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = checkUserLimit(user.id, "agentMutate");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = builderCreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const spec = parsed.data;

  // Plan enforcement (SaaS only): the org's agent cap counts builder
  // agents like any other (the cap counts LIVE rows).
  const planLimited = await checkAgentCountLimit(user.orgId);
  if (planLimited) return planLimited;

  // AgentOS round trips first — models catalog (tiering) + tools catalog
  // (palette + parameters). Failures here are 502/503 before anything is
  // written.
  let models, platformTools;
  try {
    [models, platformTools] = await Promise.all([
      fetchAgentosModels(),
      fetchBuilderTools(),
    ]);
  } catch (err) {
    return agentosErrorResponse(err);
  }

  let model;
  try {
    model = resolveBuilderModel(spec.model, models);
  } catch (err) {
    if (err instanceof BuilderValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Connectors must exist in the org's connector store at create time —
  // the run gate re-checks at run time, but a typo'd name shouldn't be
  // storable in the first place. The stored config references connector
  // IDS (the platform registry's keys), so the validated rows double as
  // the name→id map.
  let connectorIds: string[] = [];
  let referencedConnectors: Array<{ id: string; url: string; name: string }> = [];
  if (spec.connectors.length) {
    const orgConnectors = await getConnectorsByNames(user.orgId, spec.connectors);
    const missing = spec.connectors.filter((name) => !orgConnectors.has(name));
    if (missing.length) {
      return NextResponse.json(
        { error: `Unknown connector${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` },
        { status: 400 },
      );
    }
    referencedConnectors = spec.connectors.map((name) => {
      const row = orgConnectors.get(name)!;
      return { id: row.id, url: row.url, name: row.name };
    });
    connectorIds = referencedConnectors.map((row) => row.id);
  }

  const remoteAgentId = generateAgentId();
  // Tool names are validated against the platform tools catalog here —
  // a stale/typo'd name is client input, so a 400 (not a 500).
  let config: Record<string, unknown>;
  let requirements;
  try {
    config = buildComponentConfig(remoteAgentId, { ...spec, connectorIds }, model, platformTools);
    // Same tool validation as buildComponentConfig — guarded too so a
    // stale tool name can never escape as a raw 500. buildRequirements
    // keeps the org-facing NAMES (the local snapshot renders them).
    requirements = buildRequirements(spec, model, platformTools);
  } catch (err) {
    if (err instanceof BuilderValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  const endpoint = builderEndpoint(remoteAgentId);
  if (!endpoint) {
    // Unreachable in practice (AGENTOS_ENABLED was checked by the fetches
    // above) — but a half-configured env must never produce a broken row.
    return NextResponse.json(
      { error: "The agent builder is not enabled on this deployment." },
      { status: 503 },
    );
  }

  // 1) Local row first (provenance + the sidebar-facing record). The
  //    endpoint/authMode/jwtScopes mirror the run contract: the registry's
  //    builder branch mints the AGENTOS user token at run time.
  let created;
  try {
    created = await createAgent(
      {
        name: spec.name,
        description: spec.description,
        endpoint,
        authMode: "jwt",
        jwtScopes: [AGENTOS_USER_SCOPE],
        origin: "builder",
        authorUserId: user.id,
        remoteAgentId,
        requirements,
      },
      user.orgId,
    );
  } catch (err) {
    console.error("[builder] local create failed", {
      orgId: user.orgId,
      remoteAgentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't create the agent — please try again." },
      { status: 500 },
    );
  }

  // 2) The AgentOS component (the "brain" the dispatcher rehydrates).
  try {
    // Belt-and-braces connector registration: connector edits push-first,
    // so the registry normally already holds every referenced connector —
    // re-upserting here additionally covers a restored/wiped platform
    // database (otherwise the saved config would reference ids the
    // registry lost, and runs would silently skip those connectors).
    // Idempotent; failures compensate like any other platform failure.
    if (referencedConnectors.length) {
      await ensurePlatformConnectors(referencedConnectors);
    }
    await createAgentosComponent({
      componentId: remoteAgentId,
      name: spec.name,
      description: spec.description,
      config,
    });
  } catch (err) {
    // Compensating delete — never leave a half-created agent. If the
    // AgentOS POST actually succeeded server-side but the RESPONSE timed
    // out (agentosRequest's fetch-catch logs nothing contextual), the
    // component now exists platform-side with zero tackui-side trace —
    // this log line is the only record an operator can clean it up from.
    console.error("[builder] AgentOS component create failed — compensating local delete", {
      agentId: created.id,
      remoteAgentId,
      orgId: user.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    await deleteAgent(created.id, user.orgId).catch((delErr) => {
      console.error("[builder] compensating local delete failed", {
        agentId: created.id,
        orgId: user.orgId,
        error: delErr instanceof Error ? delErr.message : String(delErr),
      });
    });
    return agentosErrorResponse(err);
  }

  return NextResponse.json(toPublicAgent(created), { status: 201 });
}

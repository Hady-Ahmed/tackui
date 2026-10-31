/**
 * The agent builder service — tackui's server-side client for the shared
 * AgentOS platform (agent-warehouse `agents/platform-os`).
 *
 * Builder-created agents live in two places at once: the AgentOS component
 * store (the versioned config the dispatcher rehydrates at run time — the
 * "brain") and tackui's own `agents` table (provenance + the org-facing row
 * the sidebar lists). This module owns the AgentOS half: service-token
 * minting, the component CRUD client, and the builder-input → stored-config
 * translation (the spike-proven shape).
 *
 * Trust posture — nothing builder-shaped is client-trusted:
 *  - the model's `platformTier` is re-derived from the AgentOS models
 *    catalog at create/update time (the client sends provider+id only).
 *    This flag drives the run gate's platform-key quota exemption, so a
 *    forged `platformTier: true` would let a non-tier model run free on
 *    the platform key — it must never come from the wire.
 *  - tool `parameters` (json-schema) and the credential contract
 *    (`requiresKey`/`platformFallback`) are sourced from the AgentOS
 *    platform tools catalog at create/update time; the client sends tool
 *    names only.
 *  - `connector` names are validated against the org's connector store.
 *
 * Wire contracts (proven live in the phase-0 spike):
 *  - JWT: HS256, claims {sub, scopes: [...], exp}. `app:superadmin` gates
 *    CRUD + platform routes; `app:user` gates POST /agui/* (runs).
 *  - Component CRUD (Agno stock /components router): POST /components
 *    {name, component_id, component_type: "agent", description?, config,
 *    stage: "published", set_current: true} → 201 ComponentResponse;
 *    POST /components/{id}/configs {config, stage, set_current,
 *    guard: {latest_version}} for config updates; PATCH /components/{id}
 *    (name/description) with guard: {current_version} → 409 on mismatch;
 *    DELETE /components/{id} is a soft-delete.
 *  - Stored config shape: {"id": <component_id>, "name": ..., "model":
 *    {"id": "<model-id>"}, "instructions": ["..."],
 *    "add_history_to_context": true, "num_history_runs": 10, "tools":
 *    [{"name": ..., "parameters": {json-schema}}]}. The model ref is
 *    {"id": ...} ONLY — extra fields break registry rehydration. The
 *    history flags must always be present (sessions live Agno-side).
 */

import jwt from "jsonwebtoken";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AGENTOS_BASE_URL, AGENTOS_ENABLED, AGENTOS_JWT_SECRET } from "@/lib/config/agentos";
import { providerForDepKey } from "@/lib/credentials/catalog";
import type { AgentRequirements } from "./agents.config";

/** Seconds a minted service token stays valid — minted per request. */
const SERVICE_TOKEN_TTL_SECONDS = 600;

export const AGENTOS_SERVICE_SUB = "tackui-service";
export const AGENTOS_ADMIN_SCOPE = "app:superadmin";
export const AGENTOS_USER_SCOPE = "app:user";

/**
 * Mint a short-lived HS256 service token for tackui → AgentOS calls
 * (component CRUD, models/registry proxies). `sub` is the fixed service
 * identity — the AgentOS pins admin ownership to it, so component rows it
 * creates are owned by "tackui-service" (single shared identity, matching
 * the spike's smoke test).
 */
export function mintServiceToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: AGENTOS_SERVICE_SUB,
      scopes: [AGENTOS_ADMIN_SCOPE],
      iat: now,
      exp: now + SERVICE_TOKEN_TTL_SECONDS,
    },
    AGENTOS_JWT_SECRET,
    { algorithm: "HS256" },
  );
}

/**
 * The curated builder tool palette — gone. It is the platform tools
 * catalog (GET /platform/tools) now: the AgentOS allowlist is the single
 * source of truth for which tools the builder may attach, their labels,
 * their credential contract, and their json-schema parameters. Adding a
 * tool = registry import + one env line on the AgentOS; zero tackui
 * changes, not even env.
 *
 * `AgentosTool` below mirrors one entry of that catalog (snake_case wire
 * shape, same convention as AgentosModel).
 */

/** A model in the AgentOS platform catalog (GET /platform/models). */
export interface AgentosModel {
  provider: string;
  id: string;
  platform_tier: boolean;
  /** false for keyless providers (e.g. ollama) — no credential demanded. */
  requires_key: boolean;
}

/** One credential of a toolkit's delivery contract (scan-derived). */
export interface AgentosToolCredential {
  /** The AG-UI context dep key ("<toolkit>_<constructor-arg>"). */
  dep_key: string;
  /** Display copy for the connect-form field. */
  label: string;
}

/** One tool in the AgentOS platform tool catalog (GET /platform/tools). */
export interface AgentosTool {
  name: string;
  label: string;
  description?: string;
  /** The AG-UI context dep key the runner delivers (null = keyless). */
  requires_key: string | null;
  /** The platform env key that serves a runner without one. */
  fallback_env: string | null;
  /** true when the platform key is actually set on this deployment. */
  platform_fallback: boolean;
  /** The toolkit slug this function belongs to (the credential provider). */
  toolkit: string;
  /** The full credential contract — multi-credential toolkits list several. */
  credentials: AgentosToolCredential[];
  parameters?: Record<string, unknown>;
}

/** Error thrown when the AgentOS is unreachable or rejects a call.
    `message` is always end-user-safe (no internal names, no raw bodies) —
    it's what every route may show verbatim. `detail` carries the upstream
    4xx/5xx validation text, parsed out of the response body when possible;
    admin-only surfaces opt into showing it, member surfaces never do. */
export class AgentosError extends Error {
  constructor(
    /** HTTP-ish status the caller route should surface (503 when disabled). */
    readonly status: number,
    message: string,
    /** Upstream validation detail (e.g. "test failed: … is not a valid model
        ID") — sanitized of transport framing; admin surfaces only. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AgentosError";
  }
}

/**
 * Map a service-layer error to the route response — the single place the
 * `message`-only (member surfaces) vs `detail` (admin-only surfaces)
 * boundary is enforced for AgentOS failures. Lives here (not in a route
 * file) so no route imports a route.
 */
export function agentosErrorResponse(err: unknown): NextResponse {
  if (err instanceof AgentosError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[builder] unexpected error (not an AgentosError)", {
    error: err instanceof Error ? err.message : String(err),
  });
  return NextResponse.json(
    { error: "The agent builder is unavailable right now — please try again shortly." },
    { status: 502 },
  );
}

/** Error thrown when builder input references something that doesn't exist. */
export class BuilderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderValidationError";
  }
}

interface AgentosComponentResponse {
  component_id: string;
  component_type: string;
  name: string | null;
  description: string | null;
  current_version: number | null;
  deleted_at: number | null;
}

/** Pull the human-readable validation text out of an AgentOS error body.
    FastAPI answers {"detail": "..."}; accept a plain string too. Returns
    undefined when nothing usable is present (empty body, non-JSON). */
function extractDetail(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed.slice(0, 300) || undefined;
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail ??
        (parsed as { message?: unknown }).message;
      if (typeof detail === "string" && detail.trim()) return detail.slice(0, 300);
      if (detail != null) return JSON.stringify(detail).slice(0, 300);
    }
  } catch {
    // Not JSON — FastAPI validation errors can arrive as pre-rendered text.
  }
  return raw.slice(0, 300) || undefined;
}

/**
 * The single AgentOS HTTP entry point. Mints a fresh service token per
 * call, throws AgentosError with a caller-safe status on any failure.
 * 10s timeout — the AgentOS is same-host infrastructure; a hung call
 * should fail the builder request, not hold it open.
 *
 * Error copy discipline: `message` is end-user-safe (the platform is
 * called "the agent platform" — never "AgentOS", never method/path/status
 * framing, never a raw body). The upstream validation text rides in
 * `detail`, which only admin-gated routes may surface; 5xx bodies can
 * carry infra detail (agno internals, DB errors) but the same rule holds
 * — detail goes only where an operator is reading. Same boundary
 * discipline as the dispatcher's run-error sanitization (platform-os
 * commit fac65cf).
 */
async function agentosRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!AGENTOS_ENABLED) {
    throw new AgentosError(503, "The agent builder isn't enabled on this deployment.");
  }
  let res: Response;
  try {
    res = await fetch(`${AGENTOS_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${mintServiceToken()}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    throw new AgentosError(
      502,
      "The agent builder is unavailable right now — please try again shortly.",
    );
  }
  if (!res.ok) {
    const detail = extractDetail(await res.text().catch(() => ""));
    const status = res.status === 401 || res.status === 403 ? 502 : res.status;
    // Log the full body server-side (it keeps method/path framing — that's
    // for operators reading logs, not for the browser).
    console.error(`[agentos] ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`);
    if (status < 500) {
      throw new AgentosError(
        status,
        "The agent builder couldn't process that request. Refresh and try again.",
        detail,
      );
    }
    throw new AgentosError(
      status,
      "The agent builder is unavailable right now — please try again shortly.",
      detail,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  // A 2xx with a non-JSON body is an upstream bug — map it to the same
  // end-user-safe failure as any other transport error (an uncaught
  // SyntaxError here would surface as a raw 500).
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AgentosError(
      502,
      "The agent builder is unavailable right now — please try again shortly.",
    );
  }
}

/** GET /platform/models — the model catalog the builder's picker renders. */
export async function fetchAgentosModels(): Promise<AgentosModel[]> {
  const body = await agentosRequest<{ models?: AgentosModel[] }>(
    "GET",
    "/platform/models",
  );
  return body?.models ?? [];
}

/**
 * GET /platform/tools — the platform tool catalog. The allowlist is the
 * single source of truth: the palette renders exactly this list, and the
 * BYOK provider list is derived from it (tool providers = `requires_key`
 * dep keys; LLM providers come from the models catalog). No tackui-side
 * policy, no curated subset.
 */
export async function fetchBuilderTools(): Promise<AgentosTool[]> {
  const body = await agentosRequest<{ tools?: AgentosTool[] }>(
    "GET",
    "/platform/tools",
  );
  return body?.tools ?? [];
}

/* ---------------------------------------------------------------------- */
/* Builder input schemas (what the builder UI sends)                       */
/* ---------------------------------------------------------------------- */

const builderCreateFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(300),
  /** System prompt — stored as the config's single instructions entry. */
  instructions: z.string().trim().min(1).max(8000),
  /** provider+id only — platformTier is re-derived server-side. */
  model: z.object({
    provider: z.string().trim().min(1).max(120),
    id: z.string().trim().min(1).max(200),
  }),
  /** Tool names only — parameters come from the registry server-side. */
  tools: z
    .array(z.object({ name: z.string().trim().min(1).max(200) }))
    .max(10)
    .default([]),
  /** Org connector names (lib/connectors store). */
  connectors: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
};

export const builderCreateBodySchema = z.object(builderCreateFields);
export type BuilderCreateInput = z.infer<typeof builderCreateBodySchema>;

/** All fields optional; model/tools/connectors replace wholesale. */
export const builderUpdateBodySchema = z
  .object({
    name: builderCreateFields.name.optional(),
    description: builderCreateFields.description.optional(),
    instructions: builderCreateFields.instructions.optional(),
    model: builderCreateFields.model.optional(),
    tools: builderCreateFields.tools.optional(),
    connectors: builderCreateFields.connectors.optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    "At least one field must be provided",
  );
export type BuilderUpdateInput = z.infer<typeof builderUpdateBodySchema>;

/* ---------------------------------------------------------------------- */
/* Spec → AgentOS config + requirements snapshot                           */
/* ---------------------------------------------------------------------- */

/**
 * Resolve the builder's model selection against the AgentOS catalog and
 * derive platformTier. Throws BuilderValidationError for an unknown model —
 * the catalog is the single source of truth (the picker is populated from
 * the same endpoint, so a mismatch means a stale client or tampering).
 */
export function resolveBuilderModel(
  model: BuilderCreateInput["model"],
  catalog: AgentosModel[],
): AgentosModel {
  const match = catalog.find(
    (m) => m.provider === model.provider && m.id === model.id,
  );
  if (!match) {
    throw new BuilderValidationError(
      `Unknown model "${model.provider}:${model.id}" — refresh the model list and try again.`,
    );
  }
  return match;
}

/**
 * Build the stored config for a builder agent (the spike-proven shape).
 * Tool names are validated against the platform tools catalog fetched for
 * this request — a tool that isn't in it (stale client or tampering) is a
 * validation error; parameters json-schemas come from the catalog, never
 * the wire.
 */
export function buildComponentConfig(
  componentId: string,
  spec: {
    name: string;
    instructions: string;
    tools: Array<{ name: string }>;
    connectors: string[];
  },
  model: AgentosModel,
  tools: AgentosTool[],
): Record<string, unknown> {
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const resolvedTools = spec.tools.map((t) => {
    const entry = toolByName.get(t.name);
    if (!entry) {
      throw new BuilderValidationError(
        `Tool "${t.name}" is not available on the platform — refresh the tool list and try again.`,
      );
    }
    return {
      name: t.name,
      ...(entry.parameters ? { parameters: entry.parameters } : {}),
    };
  });
  return {
    id: componentId,
    name: spec.name,
    model: { id: model.id },
    instructions: [spec.instructions],
    // History lives Agno-side for builder agents — these flags are part of
    // the stored config contract (sessions align via AG-UI session_id).
    add_history_to_context: true,
    num_history_runs: 10,
    // Connector names the agent references — written to the stored config so
    // the dispatcher can enforce "wire mcp_connectors ⊆ config-declared" at
    // run time (defense in depth against client-supplied context bypassing
    // the run gate). Never a URL or token — those stay run-scoped deps.
    ...(spec.connectors.length ? { connectors: spec.connectors } : {}),
    ...(resolvedTools.length ? { tools: resolvedTools } : {}),
  };
}

/** The local requirements snapshot persisted with the agent row. */
export function buildRequirements(
  spec: { tools: Array<{ name: string }>; connectors: string[] },
  model: AgentosModel,
  tools: AgentosTool[],
): AgentRequirements {
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  return {
    model: {
      provider: model.provider,
      id: model.id,
      platformTier: model.platform_tier,
      requiresKey: model.requires_key,
    },
    tools: spec.tools.map((t) => {
      const entry = toolByName.get(t.name);
      if (!entry) {
        throw new BuilderValidationError(
          `Tool "${t.name}" is not available on the platform — refresh the tool list and try again.`,
        );
      }
      return {
        name: t.name,
        label: entry.label,
        requiresKey: entry.requires_key,
        // The toolkit slug is the credential provider (dep keys derive from
        // it — multi-credential toolkits keep one provider). Fall back to
        // the mechanical single-key derivation when the slug is absent.
        provider: entry.toolkit ?? (entry.requires_key ? providerForDepKey(entry.requires_key) : null),
        platformFallback: entry.platform_fallback,
        // The full credential contract — multi-credential toolkits carry
        // several; single-key tools carry exactly one.
        // Fail closed: a platform catalog entry missing its contract
        // fields (upstream bug) yields a tool with no key requirement
        // rather than a raw TypeError → 500.
        credentials: (entry.credentials ?? []).map((c) => ({ depKey: c.dep_key, label: c.label })),
      };
    }),
    connectors: spec.connectors,
  };
}

/* ---------------------------------------------------------------------- */
/* Component CRUD client                                                   */
/* ---------------------------------------------------------------------- */

/** Create the versioned component on the AgentOS. `componentId` is the
 * caller-chosen id (the local row's remoteAgentId). */
export async function createAgentosComponent(input: {
  componentId: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
}): Promise<AgentosComponentResponse> {
  return agentosRequest<AgentosComponentResponse>("POST", "/components", {
    name: input.name,
    component_id: input.componentId,
    component_type: "agent",
    ...(input.description ? { description: input.description } : {}),
    config: input.config,
    stage: "published",
    set_current: true,
  });
}

/** Fetch a component (also the guard source for config/metadata updates). */
export async function getAgentosComponent(
  componentId: string,
): Promise<AgentosComponentResponse> {
  return agentosRequest<AgentosComponentResponse>(
    "GET",
    `/components/${encodeURIComponent(componentId)}`,
  );
}

/** Fetch the current published config of a component (partial PATCH source). */
export async function getAgentosCurrentConfig(
  componentId: string,
): Promise<Record<string, unknown> | undefined> {
  const body = await agentosRequest<{ config?: Record<string, unknown> } | undefined>(
    "GET",
    `/components/${encodeURIComponent(componentId)}/configs/current`,
  );
  return body?.config;
}

/**
 * Publish a new config version for a component (instructions/model/tools
 * changes). Guarded with the component's current_version as the latest
 * version — a 409 (AgentosError) means a concurrent edit landed first and
 * the caller should reload + retry.
 */
export async function updateAgentosConfig(
  componentId: string,
  config: Record<string, unknown>,
  currentVersion: number,
): Promise<void> {
  await agentosRequest(
    "POST",
    `/components/${encodeURIComponent(componentId)}/configs`,
    {
      config,
      stage: "published",
      set_current: true,
      guard: { latest_version: currentVersion },
    },
  );
}

/** Update component metadata (name/description) with a CAS guard. */
export async function updateAgentosComponentMeta(
  componentId: string,
  patch: { name?: string; description?: string },
  currentVersion: number,
): Promise<void> {
  await agentosRequest(
    "PATCH",
    `/components/${encodeURIComponent(componentId)}`,
    {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      guard: { current_version: currentVersion },
    },
  );
}

/** Soft-delete the component on the AgentOS. */
export async function deleteAgentosComponent(componentId: string): Promise<void> {
  await agentosRequest(
    "DELETE",
    `/components/${encodeURIComponent(componentId)}`,
  );
}

/* ---------------------------------------------------------------------- */
/* Platform catalog admin (the /admin/platform page's server client)      */
/* ---------------------------------------------------------------------- */

/**
 * The admin catalog API mirrors the AgentOS admin routes (admin scope).
 * Everything derived (class names, env keys, credential contracts) comes
 * from the platform's discovery scan and is rendered read-only; the
 * admin's only actions are ticking checkboxes and typing model ids.
 */

/** One provider row merged from discovery ∪ durable rows. */
export interface PlatformCatalogProvider {
  slug: string;
  available: boolean;
  enabled: boolean;
  class_name: string | null;
  requires_key: boolean;
  platform_env_key: string | null;
  env_key_set: boolean;
  models: Array<{ id: string; attrs: Record<string, unknown>; tier: boolean }>;
}

/** One toolkit row merged from discovery ∪ durable rows. */
export interface PlatformCatalogTool {
  slug: string;
  available: boolean;
  enabled: boolean;
  class_name: string | null;
  label: string;
  functions: string[];
  credentials: Array<{ dep_key: string; env: string; arg: string; label: string }>;
  /** false = has credential-shaped env vars with no delivery path. */
  deliverable: boolean;
}

export interface PlatformCatalog {
  providers: PlatformCatalogProvider[];
  tools: PlatformCatalogTool[];
}

export interface PlatformCatalogUpdate {
  providers?: Array<{ slug: string; enabled: boolean; models: string[] }>;
  tools?: Array<{ slug: string; enabled: boolean }>;
}

export interface PlatformCatalogWriteResult {
  ok: boolean;
  revision: number;
  warnings: string[];
}

/** GET /platform/catalog/models + /tools, merged — the admin page's one load. */
export async function fetchPlatformCatalog(): Promise<PlatformCatalog> {
  const [models, tools] = await Promise.all([
    agentosRequest<{ providers?: PlatformCatalogProvider[] }>("GET", "/platform/catalog/models"),
    agentosRequest<{ tools?: PlatformCatalogTool[] }>("GET", "/platform/catalog/tools"),
  ]);
  return { providers: models?.providers ?? [], tools: tools?.tools ?? [] };
}

/** PUT the full provider/model state. Validation errors surface as 400s. */
export async function putPlatformCatalogModels(
  providers: NonNullable<PlatformCatalogUpdate["providers"]>,
): Promise<PlatformCatalogWriteResult> {
  return agentosRequest<PlatformCatalogWriteResult>("PUT", "/platform/catalog/models", {
    providers,
  });
}

/** PUT the full toolkit enable/disable state. */
export async function putPlatformCatalogTools(
  tools: NonNullable<PlatformCatalogUpdate["tools"]>,
): Promise<PlatformCatalogWriteResult> {
  return agentosRequest<PlatformCatalogWriteResult>("PUT", "/platform/catalog/tools", {
    tools,
  });
}

/** POST /platform/test/model — one "hi" completion via the platform key. */
export async function testPlatformModel(
  entry: string,
): Promise<{ ok: boolean; reply: string }> {
  return agentosRequest<{ ok: boolean; reply: string }>("POST", "/platform/test/model", {
    entry,
  });
}

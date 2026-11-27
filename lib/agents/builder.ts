/**
 * The agent builder service — tackui's server-side client for the shared
 * AgentOS platform.
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
import { requirementsSchema } from "./agent-store";

/** Seconds a minted service token stays valid — minted per request. */
const SERVICE_TOKEN_TTL_SECONDS = 600;

const AGENTOS_SERVICE_SUB = "tackui-service";
const AGENTOS_ADMIN_SCOPE = "app:superadmin";
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
  /**
   * The vendor's DECLARED dependency key (e.g. "openai_api_key") — never
   * derived from the slug, which would miss for door slugs
   * ("openai-responses" shares the chat door's key). Null for keyless
   * providers.
   */
  dep_key: string | null;
  /**
   * The agno registry binding name (e.g. "OpenAIResponses") — component
   * configs carry `model: { id, name }` so same-id doors bind exactly
   * instead of first-matching on id.
   */
  name: string;
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
 * Bodies: JSON objects are serialized and sent with the application/json
 * Content-Type; a FormData body (the knowledge multipart uploads) passes
 * through UNTOUCHED with no Content-Type — fetch derives the multipart
 * boundary itself. Never base64 a file into JSON.
 *
 * Error copy discipline: `message` is end-user-safe (the platform is
 * called "the agent builder" — never "the agent platform", never
 * "AgentOS", never method/path/status framing, never a raw body). The
 * upstream validation text rides in
 * `detail`, which only admin-gated routes may surface; 5xx bodies can
 * carry infra detail (agno internals, DB errors) but the same rule holds
 * — detail goes only where an operator is reading. Same boundary
 * discipline as the dispatcher's run-error sanitization (platform-os
 * commit fac65cf).
 */
export async function agentosRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!AGENTOS_ENABLED) {
    throw new AgentosError(503, "The agent builder isn't enabled on this deployment.");
  }
  // Path hygiene (defense-in-depth). Every caller pre-encodes
  // interpolated ids with encodeURIComponent (the ids are server-generated
  // 12-hex today); this guard refuses — loudly, as a 500 — the characters
  // that would turn a forgotten encoding into a URL-injection primitive
  // carrying the app:superadmin service token to an attacker-chosen
  // platform route: query strings, fragments, whitespace, control chars.
  // Raw "/" inside a segment stays syntactically valid (it is the segment
  // separator); the encoding discipline at the call sites covers it.
  if (!/^\/[A-Za-z0-9._~/%-]*$/.test(path)) {
    throw new AgentosError(500, "Internal error building the platform request.");
  }
  let res: Response;
  try {
    // A FormData body is passed through as-is (fetch sets the multipart
    // boundary); anything else is JSON-serialized.
    const isForm = body instanceof FormData;
    res = await fetch(`${AGENTOS_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${mintServiceToken()}`,
        ...(body !== undefined && !isForm
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
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
/* Knowledge clients (the corpus management half of the builder service)   */
/* ---------------------------------------------------------------------- */

/**
 * The knowledge capability signal — GET /platform/knowledge/config. The
 * service NEVER errors on this route: `enabled=false` with the config
 * echoed is "the service answered, knowledge is off", while a failed
 * fetch (AgentosError) is "the service is unreachable" — distinct states
 * the builder UI must tell apart (same degradation thinking as the
 * catalog's `{catalog: null, catalogError}`).
 *
 * `unsupported` marks a 404: the service predates knowledge, so an old
 * deployment reads as unsupported — not broken.
 */
export interface KnowledgeConfig {
  enabled: boolean;
  provider: string;
  model: string;
  /** true = the service answered 404 (predates knowledge) — reachable but unsupported. */
  unsupported?: boolean;
}

const knowledgeConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.string(),
  model: z.string(),
});

/** GET /platform/knowledge/config — never throws for a 404 (unsupported);
 *  transport/5xx failures propagate as AgentosError (unreachable). */
export async function fetchKnowledgeConfig(): Promise<KnowledgeConfig> {
  try {
    const body = await agentosRequest<unknown>(
      "GET",
      "/platform/knowledge/config",
    );
    const parsed = knowledgeConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentosError(
        502,
        "The agent builder is unavailable right now — please try again shortly.",
      );
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof AgentosError && err.status === 404) {
      // The service predates knowledge — an old deployment reads as
      // unsupported, not broken.
      return { enabled: false, provider: "", model: "", unsupported: true };
    }
    throw err;
  }
}

/**
 * One content row of a corpus (GET /platform/knowledge/{id} — camelCase,
 * the frontend consumes these directly). `status` mirrors agno's
 * ContentStatus (processing/completed/partial/failed) or null on a row
 * that predates a status write; `statusMessage` is agno's classified
 * failure reason (null on healthy rows — the service normalizes agno's
 * empty-string default to null); `createdAt`/`updatedAt` are epoch
 * seconds. Unknown extra fields are tolerated (zod strips them).
 */
export interface KnowledgeContentRow {
  id: string;
  name: string;
  status: string | null;
  statusMessage?: string | null;
  size: number | null;
  createdAt: number;
  updatedAt: number;
}

const knowledgeContentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().nullable(),
  statusMessage: z.string().nullable().optional(),
  size: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** GET /platform/knowledge/{id} — the corpus's content list (unknown/empty
 *  corpus is an empty list; component existence is tackui's gate). */
export async function fetchKnowledgeList(
  componentId: string,
): Promise<KnowledgeContentRow[]> {
  const body = await agentosRequest<unknown>(
    "GET",
    `/platform/knowledge/${encodeURIComponent(componentId)}`,
  );
  const parsed = z.array(knowledgeContentRowSchema).safeParse(body ?? []);
  if (!parsed.success) {
    // A 2xx with a body that isn't the contracted shape is an upstream
    // bug — the same end-user-safe failure as any transport error.
    throw new AgentosError(
      502,
      "The agent builder is unavailable right now — please try again shortly.",
    );
  }
  return parsed.data;
}

/** 202 response of the upload route — the caller's content handle. */
export interface KnowledgeUploadResult {
  id: string;
  name?: string;
  status?: string;
}

const knowledgeUploadResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  status: z.string().optional(),
});

export interface KnowledgeUploadInput {
  componentId: string;
  /** Exactly one of file/text/url (the route's validation runs first —
   *  this client forwards whatever it's given). */
  file?: File;
  text?: string;
  url?: string;
  name?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  /**
   * The creator's embedding key (BYOK) — rides in the multipart body ONLY.
   * Never logged, never persisted, never echoed in a response or error.
   */
  embeddingKey: string;
}

/**
 * POST /platform/knowledge/{id}/content — the multipart ingest. The body
 * is built here as FormData and passed through agentosRequest untouched
 * (no JSON encoding, no Content-Type — fetch sets the boundary);
 * `embedding_key` rides in the body only.
 */
export async function uploadKnowledgeContent(
  input: KnowledgeUploadInput,
): Promise<KnowledgeUploadResult> {
  const form = new FormData();
  if (input.file) {
    form.set("file", input.file, input.file.name);
  } else if (input.text !== undefined) {
    form.set("text_content", input.text);
  } else if (input.url !== undefined) {
    form.set("url", input.url);
  }
  if (input.name) form.set("name", input.name);
  if (input.chunkSize !== undefined) form.set("chunk_size", String(input.chunkSize));
  if (input.chunkOverlap !== undefined) form.set("chunk_overlap", String(input.chunkOverlap));
  form.set("embedding_key", input.embeddingKey);
  const body = await agentosRequest<unknown>(
    "POST",
    `/platform/knowledge/${encodeURIComponent(input.componentId)}/content`,
    form,
  );
  const parsed = knowledgeUploadResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AgentosError(
      502,
      "The agent builder is unavailable right now — please try again shortly.",
    );
  }
  return parsed.data;
}

/**
 * DELETE /platform/knowledge/{id}/content/{content_id} — idempotent
 * service-side (an unknown id is still {ok: true}); a foreign-corpus id
 * is a 404, surfaced through the normal AgentosError shaping.
 */
export async function deleteKnowledgeContent(input: {
  componentId: string;
  contentId: string;
}): Promise<void> {
  const body = await agentosRequest<unknown>(
    "DELETE",
    `/platform/knowledge/${encodeURIComponent(input.componentId)}/content/${encodeURIComponent(input.contentId)}`,
  );
  const parsed = z.object({ ok: z.boolean() }).safeParse(body);
  if (!parsed.success) {
    throw new AgentosError(
      502,
      "The agent builder is unavailable right now — please try again shortly.",
    );
  }
}

/**
 * The corpus name a builder agent's knowledge ref carries:
 * `kb-<component_id>`. BOTH sides derive it from the component id —
 * tackui's attach here, the dispatcher's run-time attach there — so the
 * config's ref and the corpus agree by construction.
 */
export function knowledgeCorpusName(componentId: string): string {
  return `kb-${componentId}`;
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
  /** Tool names only — parameters come from the registry server-side.
   *  Shape shared by create and update; the DEFAULT belongs to create
   *  only (a fresh config starts with none). No max: a single toolkit
   *  carries 30+ tools, and the cap made large toolkits unusable (the
   *  run-time dispatcher still strips unknown/disabled references). */
  tools: z.array(z.object({ name: z.string().trim().min(1).max(200) })),
  /** Org connector names (lib/connectors store). Same default split. */
  connectors: z.array(z.string().trim().min(1).max(120)).max(10),
};

export const builderCreateBodySchema = z.object({
  ...builderCreateFields,
  // zod 4 note: a defaulted field MATERIALIZES for absent keys, so the
  // create schema defaults tools/connectors to [] here, at the leaf —
  // the update schema below must keep them plain-optional.
  tools: builderCreateFields.tools.default([]),
  connectors: builderCreateFields.connectors.default([]),
});
export type BuilderCreateInput = z.infer<typeof builderCreateBodySchema>;

/** All fields optional; model/tools/connectors replace wholesale.
 *
 *  The tools/connectors entries are deliberately NOT the create fields'
 *  `.default([])` versions: under zod 4 a defaulted field materializes
 *  for absent keys, which would (a) defeat the "at least one field"
 *  refine on an empty patch (tools/connectors would count as provided)
 *  and (b) make the route treat unpatched tools/connectors as patched —
 *  re-deriving the config with wiped lists (the exact regression the
 *  builder route tests pin: 400-on-empty and 409-on-partial). Under zod
 *  3 absent keys stayed absent either way, so this is a no-op there. */
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
    /**
     * Connector IDS — the platform connector registry's keys — NOT the
     * org-facing names. Names are org-scoped and collide across orgs; the
     * id is globally unique and is what the dispatcher matches the run
     * wire's mcp_connectors keys against. The URLs live only in the
     * platform registry (push-first-synced by this server); the config
     * never carries one.
     */
    connectorIds: string[];
    /**
     * The knowledge ref to carry in the config — present ⇔ the agent's
     * corpus has ≥1 doc (the knowledge routes' attach/detach lifecycle
     * owns this key; the builder create path passes nothing, since a
     * fresh component has no corpus). A config-publishing PATCH must
     * carry the ref through, or every unrelated edit would silently
     * detach the corpus.
     */
    knowledgeRef?: { name: string };
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
    // Binding name rides along so the registry binds this component to the
    // exact model instance — agno's resolve_model matches (id, name), which
    // disambiguates same-id API doors (openai-chat vs openai-responses).
    // Without it, a same-id second door would first-match on id alone.
    model: { id: model.id, name: model.name },
    instructions: [spec.instructions],
    // History lives Agno-side for builder agents — these flags are part of
    // the stored config contract (sessions align via AG-UI session_id).
    add_history_to_context: true,
    num_history_runs: 10,
    // Connector IDS the agent references — written to the stored config so
    // the dispatcher can enforce "wire mcp_connectors ⊆ config-declared" at
    // run time (defense in depth against client-supplied context bypassing
    // the run gate). Ids match the platform connector registry's keys; the
    // wire keys and registry keys are the same namespace. Never a URL or
    // token — URLs live in the registry, tokens stay run-scoped deps.
    ...(spec.connectorIds.length ? { connectors: spec.connectorIds } : {}),
    ...(resolvedTools.length ? { tools: resolvedTools } : {}),
    ...(spec.knowledgeRef ? { knowledge: spec.knowledgeRef } : {}),
  };
}

/** The local requirements snapshot persisted with the agent row. */
export function buildRequirements(
  spec: {
    tools: Array<{ name: string }>;
    /** Resolved connector refs — the org's stable ids + org-facing names. */
    connectors: Array<{ id: string; name: string }>;
    /**
     * The knowledge contract attached in this same save — present ⇔ the
     * config being published carries the knowledge ref. `{provider, model}`
     * comes from fetchKnowledgeConfig() at attach time (the knowledge
     * routes), or from the snapshot's own copy when a builder PATCH
     * preserves the ref through an unrelated edit.
     */
    knowledge?: { provider: string; model: string };
  },
  model: AgentosModel,
  tools: AgentosTool[],
): AgentRequirements {
  // Cross-field check the snapshot schema can't express: a keyed model
  // with NO declared dep key is a broken platform row
  // (deriveCredentialsCatalog already refuses it on the read side). If
  // it saved, the agent would be permanently unrunnable with an
  // unworkable remedy — the run gate 402s telling the user to re-save
  // in the agent builder, but a re-save persists the same null. Fail at
  // save time with the real cause.
  if (model.requires_key && !model.dep_key) {
    throw new BuilderValidationError(
      `Platform catalog data is inconsistent: the model "${model.provider}:${model.id}" requires an API key but declares no credential slot. Refresh the platform catalog and try again, or pick a different model.`,
    );
  }
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const requirements: AgentRequirements = {
    model: {
      provider: model.provider,
      id: model.id,
      platformTier: model.platform_tier,
      requiresKey: model.requires_key,
      // The platform's declared dep key — the run gate consumes this instead
      // of deriving `<slug>_api_key` from the provider slug, which would
      // miss for door slugs (openai-responses shares openai_api_key). Null
      // for keyless providers.
      depKey: model.dep_key,
      // The registry binding name — buildComponentConfig sends it back with
      // the config so same-id doors bind exactly.
      name: model.name,
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
        // Cosmetic-only upstream gap: an empty catalog label is omitted
        // rather than stored (an empty string would fail the read schema
        // and poison the whole snapshot). The UI renders the live catalog
        // label anyway; the snapshot label is for gate/KeyForm copy.
        label: entry.label || undefined,
        requiresKey: entry.requires_key,
        // The toolkit slug is the credential provider (dep keys derive from
        // it — multi-credential toolkits keep one provider). Fall back to
        // the mechanical single-key derivation when the slug is absent.
        // `||` not `??`: an empty-string toolkit (bad upstream row) must
        // fall through to the dep-key derivation too, matching
        // lib/credentials/catalog.ts — otherwise the snapshot stores
        // provider "" and the gate 402s with an empty provider label.
        provider: entry.toolkit || (entry.requires_key ? providerForDepKey(entry.requires_key) : null),
        platformFallback: entry.platform_fallback,
        // The full credential contract — multi-credential toolkits carry
        // several; single-key tools carry exactly one.
        // Fail closed: a platform catalog entry missing its contract
        // fields (upstream bug) yields a tool with no credential contract
        // rather than a raw TypeError → 500. (The gate's legacy
        // single-dep fallback still demands the requiresKey dep when the
        // contract is absent — the snapshot is merely less precise.)
        credentials: (entry.credentials ?? []).map((c) => ({
          depKey: c.dep_key,
          // Cosmetic: an empty upstream label falls back to the dep key
          // (functional gap — empty dep_key — is caught by the write-
          // boundary validation below, not papered over here).
          label: c.label || c.dep_key,
        })),
      };
    }),
    // Connector refs carried as {id, name}: the id is the stable
    // reference (stored config + dispatcher wire contract), the name is
    // for gate copy.
    connectors: spec.connectors,
    // The knowledge contract — present ⇔ the published config references
    // the corpus. Absent must stay absent (no default materializes): the
    // run gate reads this field's PRESENCE as "this agent needs the
    // embedding provider's key".
    ...(spec.knowledge ? { knowledge: spec.knowledge } : {}),
  };
  // Write-boundary validation: the snapshot must parse with the SAME
  // schema every read applies. A malformed platform-catalog row (empty
  // model provider, empty credential dep_key, …) previously wrote fine
  // and then silently ungated the agent — parseRequirements dropped the
  // blob on every read, the run gate returned the empty resolution, no
  // 402, no delivery. Failing loudly at save time is the fail-closed
  // posture this module already applies to missing contract fields.
  const parsed = requirementsSchema.safeParse(requirements);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "requirements";
    throw new BuilderValidationError(
      `Platform catalog data is inconsistent (${where}) — saving would create an agent that runs without its credential gates. Refresh the platform catalog and try again.`,
    );
  }
  return parsed.data as AgentRequirements;
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

/**
 * Derive the requirements snapshot from a component config — the inverse
 * of buildComponentConfig for failure-path reverts. The builder PATCH
 * revert uses this when a platform publish fails: a 409 means a
 * concurrent edit won the version race, so the platform now serves THEIR
 * config — restoring the caller's pre-patch snapshot would leave the
 * local projection describing a config that no longer exists (stale
 * model binding → the run gate gates the wrong credential).
 *
 * Best-effort by design: returns null when anything is unresolvable
 * (config shape unexpected, model not in the catalog, connector id with
 * no local name, broken catalog row) and the caller falls back to the
 * pre-patch snapshot — the reload-and-retry path heals the row anyway.
 */
export function deriveRequirementsFromConfig(
  config: Record<string, unknown> | undefined,
  models: AgentosModel[],
  tools: AgentosTool[],
  connectorIdToName: Map<string, string>,
  /**
   * The knowledge contract for the config's knowledge ref — REQUIRED
   * when the config references knowledge (a ref without the embedding
   * contract can't produce a truthful snapshot: refuse the derivation
   * and let the caller fall back, never write a lossy snapshot). When
   * the config references NO knowledge, the field stays absent even
   * when a contract is supplied (detach-time re-derivation).
   */
  knowledge?: { provider: string; model: string },
): AgentRequirements | null {
  try {
    if (!config) return null;

    const modelRef = config.model as { id?: unknown; name?: unknown } | undefined;
    if (
      !modelRef ||
      typeof modelRef.id !== "string" ||
      typeof modelRef.name !== "string"
    ) {
      return null;
    }
    // Same (id, name) binding the dispatcher resolves with — name
    // disambiguates same-id API doors (openai-chat vs openai-responses).
    const model =
      models.find((m) => m.id === modelRef.id && m.name === modelRef.name) ??
      models.find((m) => m.id === modelRef.id);
    if (!model) return null;

    // The knowledge ref mirrors the config exactly: a well-formed ref
    // demands the embedding contract, a missing ref stays absent, a
    // malformed ref refuses the whole derivation (fail-closed).
    const knowledgeRef = config.knowledge as { name?: unknown } | null | undefined;
    let knowledgeContract: { provider: string; model: string } | undefined;
    if (knowledgeRef !== undefined && knowledgeRef !== null) {
      if (
        typeof knowledgeRef !== "object" ||
        Array.isArray(knowledgeRef) ||
        typeof knowledgeRef.name !== "string" ||
        !knowledgeRef.name
      ) {
        return null;
      }
      if (!knowledge) return null;
      knowledgeContract = knowledge;
    }

    const toolNames = Array.isArray(config.tools)
      ? config.tools
          .map((t) =>
            t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string"
              ? (t as { name: string }).name
              : null,
          )
          .filter((n): n is string => n !== null)
      : [];

    const connectorIds = Array.isArray(config.connectors)
      ? config.connectors.filter((c): c is string => typeof c === "string")
      : [];
    // A config referencing a connector id we can't name locally would
    // produce a lossy snapshot (silently dropped connector) — refuse
    // the derivation rather than write it.
    const connectorRefs: Array<{ id: string; name: string }> = [];
    for (const id of connectorIds) {
      const name = connectorIdToName.get(id);
      if (name === undefined) return null;
      connectorRefs.push({ id, name });
    }

    return buildRequirements(
      {
        tools: toolNames.map((name) => ({ name })),
        connectors: connectorRefs,
        ...(knowledgeContract ? { knowledge: knowledgeContract } : {}),
      },
      model,
      tools,
    );
  } catch {
    return null;
  }
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

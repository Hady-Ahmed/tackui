import { randomUUID } from "node:crypto";
import { query } from "@/lib/db/pg";
import { z } from "zod";
import type { AgentAuthMode, AgentEntry, PublicAgent } from "./agents.config";
const agentAuthModeSchema = z.enum(["none", "jwt"]);

// Shared field definitions — used by the create + update input schemas
// below. `id` is intentionally absent: it is server-generated on create
// (see generateAgentId) and comes from the URL path param on update.
const fieldShapes = {
  name: z.string().min(1).max(100),
  description: z.string().max(300),
  endpoint: z.string().url(),
  authMode: agentAuthModeSchema.default("none"),
  // HS256 needs ≥256 bits = 32 chars. Only validated when present
  // (blank submit on PATCH preserves the existing value — see
  // updateAgent's blank-preserve pattern).
  jwtSecret: z.string().min(32).optional(),
  // Optional JWT `scopes` claim — a list of permission scopes included
  // in the JWT payload when the backend has authorization=True enabled.
  // Only needed when the backend requires specific scopes; omit
  // entirely when the backend's authorization is off (the default).
  jwtScopes: z.array(z.string()).optional(),
};

/**
 * Body schema for POST /api/agents. `id` is never accepted from the
 * client — the server generates it. If a client sends `id`, zod's
 * default `.strip()` behavior drops unknown keys, so it's ignored.
 */
export const createAgentBodySchema = z.object(fieldShapes);
export type CreateAgentInput = z.infer<typeof createAgentBodySchema>;

/**
 * Body schema for PATCH /api/agents/[id]. All fields optional; `id`
 * is never accepted (comes from the URL path param).
 */
export const updateAgentBodySchema = z.object(fieldShapes).partial();
export type UpdateAgentInput = z.infer<typeof updateAgentBodySchema>;

/**
 * Internal schema used to validate a fully-merged agent row before
 * persisting (in updateAgent). Includes `id` because it's part of the
 * row, but `id` here comes from the URL param / existing row — never
 * from client input.
 */
const agentRowSchema = z.object({
  id: z.string().min(1).max(64),
  ...fieldShapes,
});

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  endpoint: string;
  org_id: string;
  auth_mode: string | null;
  jwt_secret: string | null;
  jwt_scopes: string | null;
}

function rowToEntry(row: AgentRow): AgentEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    endpoint: row.endpoint,
    orgId: row.org_id,
    authMode: (row.auth_mode ?? "none") as AgentAuthMode,
    jwtSecret: row.jwt_secret ?? undefined,
    jwtScopes: row.jwt_scopes
      ? row.jwt_scopes.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
}

/**
 * Strip raw secrets (`jwtSecret`) from an AgentEntry and replace them
 * with a boolean. Use this for any response that leaves the server (REST
 * GET endpoints, admin UI fetches). The raw secrets are only ever read
 * by `lib/agents/registry.ts` server-side.
 */
export function toPublicAgent(entry: AgentEntry): PublicAgent {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    endpoint: entry.endpoint,
    orgId: entry.orgId,
    authMode: entry.authMode,
    hasJwtSecret: Boolean(entry.jwtSecret),
    ...(entry.jwtScopes !== undefined ? { jwtScopes: entry.jwtScopes } : {}),
  };
}

export function toPublicAgents(entries: AgentEntry[]): PublicAgent[] {
  return entries.map(toPublicAgent);
}

/**
 * Generate a random 12-char lowercase hex agent id.
 *
 * 48 bits of entropy — birthday-collision threshold is ~16M rows per
 * org, far beyond any realistic deploy. Combined with the composite
 * PK `(id, org_id)` (migration 0003), collisions on INSERT are
 * effectively impossible; the 23505 catch in the route handler is a
 * loud-error safety net, not a retry path.
 *
 * Uses crypto.randomUUID() (zero new deps). Hex chars are URL-safe.
 */
export function generateAgentId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * List agents scoped to an org. Platform admins (role === "admin") bypass
 * the org filter to see/manage all agents across orgs.
 *
 * NOTE: `bypassOrgScope` is currently test-only (cleanup loops). It is
 * scaffolding for a future platform-admin "manage agents across orgs"
 * feature in the org-switcher track. No production caller passes it.
 * Kept here so the composite PK `(id, org_id)` migration doesn't churn
 * test plumbing — `DELETE WHERE id = $1` still works (deletes across
 * orgs, which is what cleanup wants).
 */
export async function listAgents(
  orgId: string,
  opts?: { bypassOrgScope?: boolean },
): Promise<AgentEntry[]> {
  if (opts?.bypassOrgScope) {
    const result = await query<AgentRow>(
      `SELECT id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes
       FROM agents ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToEntry);
  }
  const result = await query<AgentRow>(
    `SELECT id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes
     FROM agents WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return result.rows.map(rowToEntry);
}

/**
 * Get a single agent scoped to an org. Platform admins can bypass the org
 * filter to look up agents in any org.
 */
export async function getAgent(
  id: string,
  orgId: string,
  opts?: { bypassOrgScope?: boolean },
): Promise<AgentEntry | null> {
  if (opts?.bypassOrgScope) {
    const result = await query<AgentRow>(
      `SELECT id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes
       FROM agents WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : null;
  }
  const result = await query<AgentRow>(
    `SELECT id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes
     FROM agents WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  return result.rows[0] ? rowToEntry(result.rows[0]) : null;
}

/**
 * Create an agent. The orgId is server-stamped from the session, never
 * from the client body (the client cannot control which org an agent
 * belongs to). The `id` is server-generated (never client-supplied).
 */
export async function createAgent(
  input: CreateAgentInput,
  orgId: string,
): Promise<AgentEntry> {
  const id = generateAgentId();
  const result = await query<AgentRow>(
    `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes`,
    [
      id,
      input.name,
      input.description,
      input.endpoint,
      orgId,
      input.authMode,
      input.jwtSecret ?? null,
      input.jwtScopes?.join(",") ?? null,
    ],
  );
  return rowToEntry(result.rows[0]);
}

/**
 * Update an agent scoped to an org. Platform admins can bypass the org
 * filter to update agents in any org. The `id` comes from the URL path
 * param (never from the patch body).
 */
export async function updateAgent(
  id: string,
  patch: UpdateAgentInput,
  orgId: string,
  opts?: { bypassOrgScope?: boolean },
): Promise<AgentEntry | null> {
  const existing = await getAgent(id, orgId, opts);
  if (!existing) return null;
  const merged = {
    id,
    name: existing.name,
    description: existing.description,
    endpoint: existing.endpoint,
    authMode: existing.authMode,
    jwtSecret: existing.jwtSecret,
    jwtScopes: existing.jwtScopes,
    ...patch,
  };
  const parsed = agentRowSchema.parse(merged);
  if (opts?.bypassOrgScope) {
    const result = await query<AgentRow>(
      `UPDATE agents
       SET name = $1, description = $2, endpoint = $3,
           auth_mode = $4, jwt_secret = $5, jwt_scopes = $6, updated_at = now()
       WHERE id = $7
       RETURNING id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes`,
      [
        parsed.name,
        parsed.description,
        parsed.endpoint,
        parsed.authMode,
        parsed.jwtSecret ?? null,
        parsed.jwtScopes?.join(",") ?? null,
        id,
      ],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : null;
  }
  const result = await query<AgentRow>(
    `UPDATE agents
     SET name = $1, description = $2, endpoint = $3,
         auth_mode = $4, jwt_secret = $5, jwt_scopes = $6, updated_at = now()
     WHERE id = $7 AND org_id = $8
     RETURNING id, name, description, endpoint, org_id, auth_mode, jwt_secret, jwt_scopes`,
    [
      parsed.name,
      parsed.description,
      parsed.endpoint,
      parsed.authMode,
      parsed.jwtSecret ?? null,
      parsed.jwtScopes?.join(",") ?? null,
      id,
      orgId,
    ],
  );
  return result.rows[0] ? rowToEntry(result.rows[0]) : null;
}

/**
 * Delete an agent scoped to an org. Platform admins can bypass the org
 * filter to delete agents in any org.
 */
export async function deleteAgent(
  id: string,
  orgId: string,
  opts?: { bypassOrgScope?: boolean },
): Promise<boolean> {
  if (opts?.bypassOrgScope) {
    const result = await query(`DELETE FROM agents WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
  const result = await query(
    `DELETE FROM agents WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  return (result.rowCount ?? 0) > 0;
}

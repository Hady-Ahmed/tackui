import { randomUUID } from "node:crypto";
import { query } from "@/lib/db/pg";
import { z } from "zod";
import type { AgentEntry, AgentKind, PublicAgent } from "./agents.config";
const agentKindSchema = z.enum(["langgraph", "agno", "agui"]);

// Shared field definitions — used by the create + update input schemas
// below. `id` is intentionally absent: it is server-generated on create
// (see generateAgentId) and comes from the URL path param on update.
const fieldShapes = {
  name: z.string().min(1).max(100),
  description: z.string().max(300),
  kind: agentKindSchema,
  endpoint: z.string().url(),
  graphId: z.string().optional(),
  langsmithApiKey: z.string().optional(),
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
  kind: string;
  endpoint: string;
  org_id: string;
  graph_id: string | null;
  langsmith_api_key: string | null;
}

function rowToEntry(row: AgentRow): AgentEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    kind: row.kind as AgentKind,
    endpoint: row.endpoint,
    orgId: row.org_id,
    graphId: row.graph_id ?? undefined,
    langsmithApiKey: row.langsmith_api_key ?? undefined,
  };
}

/**
 * Strip the raw `langsmithApiKey` from an AgentEntry and replace it
 * with a boolean `hasLangsmithApiKey`. Use this for any response that
 * leaves the server (REST GET endpoints, admin UI fetches). The raw key
 * is only ever read by `lib/agents/registry.ts` server-side.
 */
export function toPublicAgent(entry: AgentEntry): PublicAgent {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    kind: entry.kind,
    endpoint: entry.endpoint,
    orgId: entry.orgId,
    ...(entry.graphId !== undefined ? { graphId: entry.graphId } : {}),
    hasLangsmithApiKey: Boolean(entry.langsmithApiKey),
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
      `SELECT id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key
       FROM agents ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToEntry);
  }
  const result = await query<AgentRow>(
    `SELECT id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key
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
      `SELECT id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key
       FROM agents WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : null;
  }
  const result = await query<AgentRow>(
    `SELECT id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key
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
    `INSERT INTO agents (id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key`,
    [
      id,
      input.name,
      input.description,
      input.kind,
      input.endpoint,
      orgId,
      input.graphId ?? null,
      input.langsmithApiKey ?? null,
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
    kind: existing.kind,
    endpoint: existing.endpoint,
    graphId: existing.graphId,
    langsmithApiKey: existing.langsmithApiKey,
    ...patch,
  };
  const parsed = agentRowSchema.parse(merged);
  if (opts?.bypassOrgScope) {
    const result = await query<AgentRow>(
      `UPDATE agents
       SET name = $1, description = $2, kind = $3, endpoint = $4,
           graph_id = $5, langsmith_api_key = $6, updated_at = now()
       WHERE id = $7
       RETURNING id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key`,
      [
        parsed.name,
        parsed.description,
        parsed.kind,
        parsed.endpoint,
        parsed.graphId ?? null,
        parsed.langsmithApiKey ?? null,
        id,
      ],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : null;
  }
  const result = await query<AgentRow>(
    `UPDATE agents
     SET name = $1, description = $2, kind = $3, endpoint = $4,
         graph_id = $5, langsmith_api_key = $6, updated_at = now()
     WHERE id = $7 AND org_id = $8
     RETURNING id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key`,
    [
      parsed.name,
      parsed.description,
      parsed.kind,
      parsed.endpoint,
      parsed.graphId ?? null,
      parsed.langsmithApiKey ?? null,
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

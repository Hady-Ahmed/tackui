import { query } from "@/lib/db/pg";
import { z } from "zod";
import type { AgentEntry, AgentKind, PublicAgent } from "./agents.config";
const agentKindSchema = z.enum(["langgraph", "agno", "agui"]);

export const agentEntrySchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "id must be lowercase kebab-case"),
  name: z.string().min(1).max(100),
  description: z.string().max(300),
  kind: agentKindSchema,
  endpoint: z.string().url(),
  graphId: z.string().optional(),
  langsmithApiKey: z.string().optional(),
});

export type CreateAgentInput = z.infer<typeof agentEntrySchema>;
export type UpdateAgentInput = Partial<CreateAgentInput>;

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
 * List agents scoped to an org. Platform admins (role === "admin") bypass
 * the org filter to see/manage all agents across orgs.
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
 * belongs to).
 */
export async function createAgent(
  input: CreateAgentInput,
  orgId: string,
): Promise<AgentEntry> {
  const result = await query<AgentRow>(
    `INSERT INTO agents (id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, description, kind, endpoint, org_id, graph_id, langsmith_api_key`,
    [
      input.id,
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
 * filter to update agents in any org.
 */
export async function updateAgent(
  id: string,
  patch: UpdateAgentInput,
  orgId: string,
  opts?: { bypassOrgScope?: boolean },
): Promise<AgentEntry | null> {
  const existing = await getAgent(id, orgId, opts);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id, orgId: existing.orgId };
  const parsed = agentEntrySchema.parse(merged);
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

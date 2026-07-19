import { query } from "@/lib/db/pg";
import { z } from "zod";
import type { AgentEntry, AgentKind } from "./agents.config";

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
    graphId: row.graph_id ?? undefined,
    langsmithApiKey: row.langsmith_api_key ?? undefined,
  };
}

export async function listAgents(): Promise<AgentEntry[]> {
  const result = await query<AgentRow>(
    `SELECT id, name, description, kind, endpoint, graph_id, langsmith_api_key
     FROM agents ORDER BY created_at ASC`,
  );
  return result.rows.map(rowToEntry);
}

export async function getAgent(id: string): Promise<AgentEntry | null> {
  const result = await query<AgentRow>(
    `SELECT id, name, description, kind, endpoint, graph_id, langsmith_api_key
     FROM agents WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? rowToEntry(result.rows[0]) : null;
}

export async function createAgent(input: CreateAgentInput): Promise<AgentEntry> {
  const result = await query<AgentRow>(
    `INSERT INTO agents (id, name, description, kind, endpoint, graph_id, langsmith_api_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, description, kind, endpoint, graph_id, langsmith_api_key`,
    [
      input.id,
      input.name,
      input.description,
      input.kind,
      input.endpoint,
      input.graphId ?? null,
      input.langsmithApiKey ?? null,
    ],
  );
  return rowToEntry(result.rows[0]);
}

export async function updateAgent(
  id: string,
  patch: UpdateAgentInput,
): Promise<AgentEntry | null> {
  const existing = await getAgent(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id };
  const parsed = agentEntrySchema.parse(merged);
  const result = await query<AgentRow>(
    `UPDATE agents
     SET name = $1, description = $2, kind = $3, endpoint = $4,
         graph_id = $5, langsmith_api_key = $6, updated_at = now()
     WHERE id = $7
     RETURNING id, name, description, kind, endpoint, graph_id, langsmith_api_key`,
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

export async function deleteAgent(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM agents WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

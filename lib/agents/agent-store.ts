import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentEntry, AgentKind } from "./agents.config";

const DB_PATH = process.env.AGENT_DB_PATH || "./data/agent-state.db";

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
  created_at: number;
  updated_at: number;
}

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (!dbInstance) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        graph_id TEXT,
        langsmith_api_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }
  return dbInstance;
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

export function listAgents(): AgentEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agents ORDER BY created_at ASC`)
    .all() as AgentRow[];
  return rows.map(rowToEntry);
}

export function getAgent(id: string): AgentEntry | null {
  const row = getDb()
    .prepare(`SELECT * FROM agents WHERE id = ?`)
    .get(id) as AgentRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function createAgent(input: CreateAgentInput): AgentEntry {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO agents (id, name, description, kind, endpoint, graph_id, langsmith_api_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.description,
      input.kind,
      input.endpoint,
      input.graphId ?? null,
      input.langsmithApiKey ?? null,
      now,
      now,
    );
  return getAgent(input.id)!;
}

export function updateAgent(id: string, patch: UpdateAgentInput): AgentEntry | null {
  const existing = getAgent(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id };
  const parsed = agentEntrySchema.parse(merged);
  getDb()
    .prepare(
      `UPDATE agents SET name = ?, description = ?, kind = ?, endpoint = ?, graph_id = ?, langsmith_api_key = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      parsed.name,
      parsed.description,
      parsed.kind,
      parsed.endpoint,
      parsed.graphId ?? null,
      parsed.langsmithApiKey ?? null,
      Date.now(),
      id,
    );
  return getAgent(id);
}

export function deleteAgent(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  return result.changes > 0;
}

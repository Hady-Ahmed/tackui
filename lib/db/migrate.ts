import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction, query, type PgQueryable } from "./pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const MIGRATION_FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/i;

interface MigrationFile {
  id: string;
  filename: string;
  path: string;
}

function listMigrationFiles(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .map((filename) => {
      const match = MIGRATION_FILENAME_RE.exec(filename);
      return match
        ? { id: match[1], filename, path: join(MIGRATIONS_DIR, filename) }
        : null;
    })
    .filter((m): m is MigrationFile => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function ensureSchemaMigrationsTable(
  client: PgQueryable,
): Promise<void> {
  const exists = await client.query<{ exists: number }>(`
    SELECT count(*)::int as exists
    FROM information_schema.tables
    WHERE table_name = 'schema_migrations'
  `);
  if ((exists.rows[0]?.exists ?? 0) > 0) return;
  await client.query(`
    CREATE TABLE schema_migrations (
      id          TEXT        PRIMARY KEY,
      filename    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrationIds(
  client: PgQueryable,
): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM schema_migrations",
  );
  return new Set(result.rows.map((r) => r.id));
}

export interface MigrationRun {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(): Promise<MigrationRun> {
  const files = listMigrationFiles();
  const applied: string[] = [];
  const skipped: string[] = [];

  await withTransaction(async (client) => {
    await ensureSchemaMigrationsTable(client);
    const appliedIds = await getAppliedMigrationIds(client);

    for (const file of files) {
      if (appliedIds.has(file.id)) {
        skipped.push(file.id);
        continue;
      }
      const sql = await readFile(file.path, "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (id, filename) VALUES ($1, $2)",
        [file.id, file.filename],
      );
      applied.push(file.id);
    }
  });

  return { applied, skipped };
}

export interface AppliedMigration {
  id: string;
  filename: string;
  applied_at: string | Date;
  [key: string]: unknown;
}

export async function listAppliedMigrations(): Promise<AppliedMigration[]> {
  const result = await query<AppliedMigration>(
    "SELECT id, filename, applied_at FROM schema_migrations ORDER BY id ASC",
  );
  return result.rows;
}

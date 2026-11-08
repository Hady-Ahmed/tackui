/**
 * E2E migrations runner — reuses the app's REAL migration files
 * (lib/db/migrations/*.sql) so the seeded schema matches production
 * exactly. The app's lib/db/migrate.ts is TypeScript — not importable
 * from a plain .mjs — so this is a minimal faithful port: same
 * filename pattern, same ordering, same schema_migrations tracking
 * table, same transactional apply. The suite asserts this indirectly:
 * the smoke tests exercise the real tables, so a divergence between
 * this port and the app's migrations would fail loudly.
 */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/i;

export async function runMigrations(pool) {
  const applied = [];
  const skipped = [];

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .map((f) => {
      const m = MIGRATION_FILENAME_RE.exec(f);
      return m ? { id: m[1], filename: f } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));

  const existing = await pool.query("SELECT id FROM schema_migrations");
  const done = new Set(existing.rows.map((r) => r.id));

  for (const file of files) {
    if (done.has(file.id)) {
      skipped.push(file.id);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file.filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file.id]);
      await client.query("COMMIT");
      applied.push(file.id);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

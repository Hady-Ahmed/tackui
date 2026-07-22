import { runMigrations } from "@/lib/db/migrate";
import { ensureAuthTables } from "@/lib/auth/migrate";

/**
 * Next.js instrumentation hook — runs ONCE on server boot, before any
 * request is accepted. Used to auto-run database migrations so self-hosters
 * can just `docker-compose up` without manually running migrate commands.
 *
 * Both migrations are idempotent — safe to run on every boot:
 *   1. `runMigrations()` — creates/updates app tables (agents, agent_runs,
 *      run_state, thread_messages, thread_metadata) from lib/db/migrations/*.sql
 *   2. `ensureAuthTables()` — creates Better Auth tables (user, session,
 *      account, verification) via Better Auth's getMigrations() API
 *
 * If PG isn't ready yet (shouldn't happen with docker-compose healthcheck),
 * the lazy `ensureAuthTables()` call in lib/auth/context.ts is a fallback
 * that retries on the first auth request. App table migrations will retry
 * on the next boot.
 */
export async function register() {
  try {
    const result = await runMigrations();
    if (result.applied.length > 0) {
      console.log(`[migrate] applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`);
    } else {
      console.log("[migrate] no new migrations to apply");
    }
  } catch (err) {
    console.error("[migrate] failed — app may not function correctly", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await ensureAuthTables();
    console.log("[auth] tables ensured");
  } catch (err) {
    console.error("[auth] table migration failed — will retry on first auth request", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

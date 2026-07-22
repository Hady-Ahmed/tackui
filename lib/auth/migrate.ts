import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";

let migrationRan = false;

export async function ensureAuthTables(): Promise<void> {
  if (migrationRan) return;

  try {
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
    if (toBeCreated.length > 0 || toBeAdded.length > 0) {
      await runMigrations();
    }
    // Only mark as ran on success — allows retry on next request if PG
    // wasn't ready yet (e.g. app boots before docker-compose healthcheck
    // passes, or transient connection failure).
    migrationRan = true;
  } catch (err) {
    // Tables may already exist, PG may not be ready yet, or migration may
    // not be needed. Don't crash — the lazy call in context.ts retries on
    // the next auth request, and instrumentation.ts retries on next boot.
    console.error("[auth] ensureAuthTables failed (will retry)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

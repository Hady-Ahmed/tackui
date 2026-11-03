import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";

let migrationRan = false;

/**
 * Returns true when the Better Auth tables are ensured (already present
 * or migrations just ran), false when the attempt failed. The boolean —
 * not `void` and not a throw — is the contract instrumentation.ts's boot
 * fail-fast depends on: a `void` return made success indistinguishable
 * from failure there (the boot exited non-zero on EVERY start), while a
 * throw would skip the lazy-retry contract the non-boot callers rely on
 * (they call this per request and retry naturally on the next request).
 */
export async function ensureAuthTables(): Promise<boolean> {
  if (migrationRan) return true;

  try {
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
    if (toBeCreated.length > 0 || toBeAdded.length > 0) {
      await runMigrations();
    }
    // Only mark as ran on success — allows retry on next request if PG
    // wasn't ready yet (e.g. app boots before docker-compose healthcheck
    // passes, or transient connection failure).
    migrationRan = true;
    return true;
  } catch (err) {
    // Tables may already exist, PG may not be ready yet, or migration may
    // not be needed. Don't crash — the lazy call in context.ts retries on
    // the next auth request, and instrumentation.ts retries on next boot.
    console.error("[auth] ensureAuthTables failed (will retry)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

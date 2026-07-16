import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";

let migrationRan = false;

export async function ensureAuthTables(): Promise<void> {
  if (migrationRan) return;
  migrationRan = true;

  try {
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
    if (toBeCreated.length > 0 || toBeAdded.length > 0) {
      await runMigrations();
    }
  } catch {
    // Tables may already exist or migration may not be needed.
    // The CLI (`npx @better-auth/cli migrate`) is the canonical way;
    // this is a best-effort auto-creation for dev convenience.
  }
}

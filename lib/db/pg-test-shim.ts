/**
 * pg-mem shims for the test emulator — native Postgres functions that
 * migrations use but pg-mem doesn't implement ("implements very few
 * native functions"). Registered by vitest.setup.ts for the shared
 * per-file emulator and by lib/db/migrate.test.ts, which builds its own
 * fresh db per test.
 *
 * This is test-only scaffolding: production SQL stays clean, real
 * Postgres (the same discipline as the documented WITH RECURSIVE gap in
 * lib/agents/pg-runner.test.ts).
 */
import { DataType, type IMemoryDb } from "pg-mem";

export function registerPgMemShims(db: IMemoryDb): void {
  // Migration 0014 (credential fields) backfills the fields map with
  // jsonb_build_object — the correct, injection-safe way to build a jsonb
  // literal in Postgres.
  db.public.registerFunction({
    name: "jsonb_build_object",
    argsVariadic: DataType.text,
    returns: DataType.jsonb,
    implementation: (...args: string[]) => {
      const out: Record<string, string | null> = {};
      for (let i = 0; i < args.length; i += 2) {
        out[args[i]] = i + 1 < args.length ? args[i + 1] : null;
      }
      return out;
    },
  });
}

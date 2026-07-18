import { runMigrations } from "../lib/db/migrate";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Set it in your environment or .env.local.");
    console.error("Example: postgres://user:pass@localhost:5432/agent_frontend");
    process.exit(1);
  }

  try {
    const result = await runMigrations();
    if (result.applied.length > 0) {
      console.log(`Applied ${result.applied.length} migration(s):`);
      for (const id of result.applied) console.log(`  - ${id}`);
    } else {
      console.log("No new migrations to apply.");
    }
    if (result.skipped.length > 0) {
      console.log(`Skipped ${result.skipped.length} already-applied migration(s).`);
    }
  } catch (err) {
    console.error("Migration failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();

import { PostgresAgentRunner } from "./pg-runner";

// Module-level singleton. Uses the shared pg.Pool from lib/db/pg (configured
// via DATABASE_URL). No dbPath — the runner, agent store, and Better Auth
// all share the same connection pool.
export const runner = new PostgresAgentRunner();

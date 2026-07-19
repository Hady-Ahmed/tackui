import { newDb } from "pg-mem";
import { setTestDb } from "@/lib/db/pg";

// Inject a fresh in-memory Postgres for every test file. vitest's `isolate: true`
// gives each file a fresh module registry, so this runs once per file and the
// injected client persists for the duration of that file.
const db = newDb();
const { Pool } = db.adapters.createPg();
const pool = new Pool();
setTestDb(Object.assign(pool, { release: () => {} }) as never);

// Agent store + persistent runner still use SQLite (migrated in PR3/PR4).
// `:memory:` + vitest's isolate:true gives each test file its own fresh SQLite.
process.env.AGENT_DB_PATH = ":memory:";

process.env.AUTH_DISABLED = "true";
process.env.BETTER_AUTH_SECRET = "test-secret";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

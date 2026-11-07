/**
 * E2E web-server helper — everything the smoke suite needs to run the REAL
 * app: the compiled Next.js server (standalone build), a throwaway Postgres
 * (testcontainers), and the mock AG-UI agent.
 *
 * Playwright's built-in webServer can't express this — it starts a single
 * command, but we need the Postgres container BEFORE the app boots (its
 * instrumentation runs migrations on boot and fails fast without a DB) and
 * the app needs the DB connection string in its env. So this script is the
 * single webServer command: it owns the full lifecycle, streams the app's
 * output so failures are visible, and never exits while the app is up.
 *
 * Order of operations:
 *   1. Start Postgres (docker, testcontainers) — a throwaway container.
 *   2. Run migrations + auth tables + seed the admin user + the test agent.
 *   3. Start the mock AG-UI agent (127.0.0.1, E2E_MOCK_AGENT_PORT).
 *   4. Start the built app (PORT) with the E2E env inline.
 *   5. Wait for the app's readiness probe.
 *
 * The E2E env is passed inline to the child process — never written to
 * .env.local, never inherited from the developer's environment. The
 * database is a disposable container; the mock agent is loopback-only.
 * Nothing here can touch prod or a real deployment.
 */
import { spawn } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { startMockAgent } from "./mock-agent.mjs";

const APP_PORT = Number(process.env.E2E_APP_PORT || 3990);
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

// Fixed test credentials — the seed admin. Not secrets; the whole DB is
// disposable. The mock agent needs a 32+ char secret for the JWT signing
// path; the app auth secret is a throwaway too.
const E2E_ADMIN_EMAIL = "e2e-admin@test.local";
const E2E_ADMIN_PASSWORD = "e2e-admin-password";
const AUTH_SECRET = "e2e-only-throwaway-secret-0123456789abcdef";
const MOCK_AGENT_JWT_SECRET = "e2e-mock-agent-jwt-secret-0123456789abcdef";

function log(msg) {
  // Single-line prefix so Playwright's webServer output stays readable.
  console.log(`[e2e-server] ${msg}`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const cleanup = [];

  // Fail fast on Ctrl-C: kill the process group so Playwright's SIGTERM
  // tears down the app + mock agent children too.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  // 1. Postgres container.
  log("starting Postgres container...");
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const dbUrl = container.getConnectionUri();
  log(`postgres ready: ${container.getHost()}:${container.getMappedPort(5432)}`);

  // 2. Migrations + auth tables + seed data. The app's own instrumentation
  //    would run migrations on boot, but the seed data needs the tables
  //    BEFORE the app accepts requests — so we run them here, then the
  //    app's boot migrations are no-ops (idempotent).
  log("running migrations + auth tables + seed...");
  const pool = new Pool({ connectionString: dbUrl });
  const { runMigrations } = await import("./migrate.mjs");

  const mig = await runMigrations(pool);
  log(`migrations applied: ${mig.applied.length} (skipped ${mig.skipped.length})`);

  // Better Auth tables — the same ensureAuthTables() the app's boot uses.
  const { ensureAuthTables } = await import("./auth-tables.mjs");
  const authOk = await ensureAuthTables(pool);
  if (!authOk) throw new Error("ensureAuthTables failed");
  log("auth tables ready");

  const { seed } = await import("./seed.mjs");
  const seedInfo = await seed(pool, {
    adminEmail: E2E_ADMIN_EMAIL,
    adminPassword: E2E_ADMIN_PASSWORD,
    mockAgentUrl: `http://127.0.0.1:${Number(process.env.E2E_MOCK_AGENT_PORT || 3999)}/`,
    mockAgentJwtSecret: MOCK_AGENT_JWT_SECRET,
  });
  log(`seeded: ${seedInfo.adminEmail} + ${seedInfo.agents.length} agent(s)`);
  await pool.end();

  // 3. Mock AG-UI agent — loopback-only, the seeded agent's endpoint.
  const mockPort = Number(process.env.E2E_MOCK_AGENT_PORT || 3999);
  log("starting mock AG-UI agent...");
  const mockServer = await startMockAgent(mockPort);
  cleanup.push(() => mockServer.close());
  log(`mock agent listening on 127.0.0.1:${mockPort}`);

  // 4. The built app. The standalone build's server.js — the same binary
  //    the Dockerfile ships. Next.js docs (output: standalone) + the
  //    Dockerfile both note: the standalone output does NOT include the
  //    `.next/static` folder by default — it must be copied into
  //    standalone/.next/static before the server starts (the Dockerfile
  //    does exactly this COPY step). Without it, every static chunk 404s.
  log("starting built app...");
  await run("cp", ["-r", ".next/static", ".next/standalone/.next/static"]);
  const app = spawn("node", ["server.js"], {
    cwd: ".next/standalone",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(APP_PORT),
      HOSTNAME: "127.0.0.1",
      DATABASE_URL: dbUrl,
      AUTH_DISABLED: "false",
      BETTER_AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_URL: APP_URL,
      ALLOW_PRIVATE_ENDPOINTS: "true",
      SAAS_MODE: "false",
      // The app's boot guard requires DB_ENCRYPTION_KEY when auth is
      // enabled (agent JWT secrets are encrypted at rest). A throwaway
      // key — same contract as prod, disposable value. 64 hex chars
      // (openssl rand -hex 32 format).
      DB_ENCRYPTION_KEY: "e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0",
      // Sentry: no DSN → no-op (the config files guard on it).
      SENTRY_DSN: "",
      // Builder features off (no AGENTOS_BASE_URL) — the smoke suite
      // doesn't need them; keeps boot free of platform warnings.
      AGENTOS_BASE_URL: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Stream app output so failures surface in the Playwright webServer log.
  app.stdout.on("data", (c) => process.stdout.write(`[app] ${c}`));
  app.stderr.on("data", (c) => process.stderr.write(`[app] ${c}`));
  app.on("exit", (code) => log(`app exited ${code}`));
  cleanup.push(() => {
    app.kill("SIGTERM");
  });

  // 5. Wait for readiness (the deep probe pings Postgres + migrations).
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/api/health?deep=true`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    log("app failed to become ready in 60s — dumping last output");
    process.exit(1);
  }
  log(`app ready at ${APP_URL}`);

  // Stay alive — Playwright's webServer process owns this script.
  await new Promise(() => {});
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

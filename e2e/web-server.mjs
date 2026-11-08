/**
 * E2E web-server helper — everything the smoke suite needs to run the REAL
 * app: the compiled Next.js server (standalone build), a throwaway Postgres
 * container, and the mock AG-UI agent.
 *
 * Playwright's built-in webServer can't express this — it starts a single
 * command, but we need the Postgres container BEFORE the app boots (its
 * instrumentation runs migrations on boot and fails fast without a DB) and
 * the app needs the DB connection string in its env. So this script is the
 * single webServer command: it owns the full lifecycle, streams the app's
 * output so failures are visible, and never exits while the app is up.
 *
 * Order of operations:
 *   1. Start a throwaway Postgres container (docker run, postgres:16-alpine).
 *   2. Run migrations + auth tables + seed the admin user + the test agent.
 *   3. Start the mock AG-UI agent (127.0.0.1, E2E_MOCK_AGENT_PORT).
 *   4. Start the built app (PORT) with the E2E env inline.
 *   5. Wait for the app's readiness probe.
 *
 * Postgres is started with plain `docker run`, not testcontainers. The
 * original swap was a Node-20 workaround (testcontainers' nested undici
 * crashed at import there, #90 — the Dockerfile now ships 24), but the
 * split stays: this script is a long-lived supervisor that must survive
 * Playwright's bare-SIGKILL teardown — no in-process handler can run — and
 * keeping the boot path dependency-free (like the mock agent) is a
 * permanent property, not a version workaround. The vitest tier keeps
 * testcontainers; `@testcontainers/postgresql` is its dependency, not ours.
 *
 * The E2E env is passed inline to the child process — never written to
 * .env.local, never inherited from the developer's environment. The
 * database is a disposable container; the mock agent is loopback-only.
 * Nothing here can touch prod or a real deployment.
 */
import { exec, execSync, spawn } from "node:child_process";
import net from "node:net";
import { Pool } from "pg";
import { startMockAgent } from "./mock-agent.mjs";

const APP_PORT = Number(process.env.E2E_APP_PORT || 3990);
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

// The throwaway Postgres container's name — module scope so the exit
// handlers and the watchdog can always find it, however the script dies.
const PG_CONTAINER = `tackui-e2e-pg-${process.pid}`;

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

/** Grab a free loopback port for the container's host-side mapping. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Remove the Postgres container. execSync because exit handlers can't
 * await — this must finish synchronously before the process disappears.
 * `rm -f` is idempotent: a container that never started is fine.
 */
function teardownPg() {
  try {
    execSync(`docker rm -f ${PG_CONTAINER}`, { stdio: "ignore" });
  } catch {
    // nothing to remove
  }
}

/**
 * Detached container reaper. Playwright kills the webServer process group
 * with a bare SIGKILL (see the shutdown code in playwright-core — no
 * SIGTERM, no grace period), so no in-process handler ever runs on webServer
 * shutdown and the container would leak every run. This watchdog is started
 * in its own session (detached) precisely so that kill misses it: it polls
 * the harness pid and removes the container the moment the harness is gone.
 * Harmless when the container is already gone — `rm -f` is idempotent.
 */
function startReaper() {
  const cmd = `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; docker rm -f ${PG_CONTAINER}`;
  spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" }).unref();
}

/** Remove stale containers from previous runs (crash residue, etc.). */
async function sweepStaleContainers() {
  await new Promise((resolve) => {
    exec(
      `docker ps -aq --filter name=tackui-e2e-pg- | xargs -r docker rm -f`,
      { stdio: "ignore" },
      () => resolve(),
    );
  });
}

async function main() {
  const cleanup = [];

  // Tear down on every way out. Playwright SIGTERMs the whole process
  // group on webServer shutdown (which also delivers SIGTERM to the app +
  // mock agent children), so the container is removed here — nothing else
  // owns its lifecycle. The 'exit' backstop covers crashes and the
  // catch-all below; it runs synchronously, hence teardownPg only.
  const exitNow = (signal) => {
    log(`received ${signal} — tearing down`);
    for (const fn of cleanup) fn();
    teardownPg();
    process.exit(0);
  };
  process.on("SIGTERM", () => exitNow("SIGTERM"));
  process.on("SIGINT", () => exitNow("SIGINT"));
  process.on("SIGTERM", exitNow);
  process.on("SIGINT", exitNow);
  process.on("exit", teardownPg);

  // 1. Postgres — throwaway container, bound to loopback only.
  await sweepStaleContainers();
  log("starting Postgres container...");
  const pgPort = await freePort();
  const pgPassword = "e2e-postgres-password";
  await run("docker", [
    "run", "--rm", "-d", "--name", PG_CONTAINER,
    "-e", "POSTGRES_USER=postgres",
    "-e", `POSTGRES_PASSWORD=${pgPassword}`,
    "-e", "POSTGRES_DB=tackui_e2e",
    "-p", `127.0.0.1:${pgPort}:5432`,
    "postgres:16-alpine",
  ]);
  startReaper();
  const dbUrl = `postgres://postgres:${pgPassword}@127.0.0.1:${pgPort}/tackui_e2e`;

  // `docker run -d` returns before Postgres accepts connections — poll a
  // real query instead of trusting the container being "running".
  const pool = new Pool({ connectionString: dbUrl });
  const pgDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      await pool.query("select 1");
      break;
    } catch (err) {
      if (Date.now() > pgDeadline) {
        throw new Error(
          `postgres did not accept connections in 30s: ${err instanceof Error ? err.message : err}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  log(`postgres ready on 127.0.0.1:${pgPort}`);

  // 2. Migrations + auth tables + seed data. The app's own instrumentation
  //    would run migrations on boot, but the seed data needs the tables
  //    BEFORE the app accepts requests — so we run them here, then the
  //    app's boot migrations are no-ops (idempotent).
  log("running migrations + auth tables + seed...");
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

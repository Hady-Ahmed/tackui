/**
 * Image smoke — CI's packaging gate (#96).
 *
 * The e2e job certifies the standalone `server.js` under the CI runner's
 * Node 24 — Ubuntu/glibc. This script certifies what actually ships: the
 * `node:24-alpine` image built from the PR. Alpine runs musl libc, the one
 * environment where native (C/C++) addon resolution can differ from CI
 * (`sharp`/libvips is the obvious resident) — a musl-broken dep would pass
 * every other job and fail at container boot, in someone's production
 * compose stack.
 *
 * The recipe is the one-off certification done 2026-11-08 (image
 * `tackui:node24-check`), made repeatable:
 *
 *   1. Create a docker network.
 *   2. Run `postgres:16-alpine` on it (plain `docker run`, same pattern as
 *      `web-server.mjs`; no host port — the app reaches it by name).
 *   3. Boot the image wired to it (`AUTH_DISABLED=true` boot env, matching
 *      the compose default) and poll `/api/health?deep=true`.
 *   4. Tear down (rm -f both + network rm; idempotent like `web-server.mjs`).
 *
 * Dependency-free on purpose — same property as `web-server.mjs`: this runs
 * on the CI runner with nothing but docker and stock Node. Readiness uses
 * `psql` inside the pg container (a real query, like the e2e harness's
 * `select 1` poll) — `pg_isready` can answer during the init server's
 * start-up window, before the real server accepts connections.
 *
 * Usage: node e2e/image-smoke.mjs <image-tag>   (default: tackui:ci)
 */
import { execSync } from "node:child_process";
import net from "node:net";

const IMAGE = process.argv[2] || process.env.IMAGE || "tackui:ci";
const NETWORK = "tackui-ci-net";
const PG_CONTAINER = "tackui-ci-pg";
const APP_CONTAINER = "tackui-ci-app";
// Fixed throwaway credentials for the disposable container — same contract
// as web-server.mjs. Not secrets; the whole database is throwaway.
const PG_PASSWORD = "ci-postgres-password";
const PG_DB = "tackui_ci";
const DATABASE_URL = `postgres://postgres:${PG_PASSWORD}@${PG_CONTAINER}:5432/${PG_DB}`;
// The deep probe rate-limits itself per client IP (30/min) — poll slower
// than that so a healthy-but-slow boot can never 429 its way to failure.
const POLL_INTERVAL_MS = 2_500;
const PG_DEADLINE_MS = 30_000;
const APP_DEADLINE_MS = 90_000;

function log(msg) {
  console.log(`[image-smoke] ${msg}`);
}

/**
 * Idempotent teardown — `rm -f`/`network rm` tolerate resources that were
 * never created. Runs on every way out, success or failure.
 */
function teardown() {
  for (const cmd of [
    `docker rm -f ${APP_CONTAINER}`,
    `docker rm -f ${PG_CONTAINER}`,
    `docker network rm ${NETWORK}`,
  ]) {
    try {
      execSync(cmd, { stdio: "ignore" });
    } catch {
      // nothing to remove
    }
  }
}

/** Sweep residue from a previous crashed run (idempotent, like web-server.mjs). */
function sweep() {
  teardown();
}

/** Run a command; throws on non-zero exit. Output inherited. */
function sh(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

/** Run a command and capture stdout as a string. */
function shOut(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString();
}

/** Grab a free loopback port for the app's host-side mapping. */
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll a shell command until it exits 0 (a real readiness signal), with a
 * deadline. Used for pg: `psql -c "select 1"` inside the container.
 */
async function pollCommand(cmd, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      execSync(cmd, { stdio: "ignore" });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`${label} not ready in ${deadlineMs / 1000}s`);
      }
      await sleep(1_000);
    }
  }
}

/**
 * Is the app container still running? Boot crashes (the exact failure mode
 * this gate exists for — e.g. a native addon that didn't resolve under
 * musl) kill the container long before the health deadline would fire;
 * detecting that fails fast with the logs instead of after 90s of silence.
 */
function appContainerRunning() {
  try {
    return shOut(`docker inspect -f '{{.State.Running}}' ${APP_CONTAINER}`).trim() === "true";
  } catch {
    return false;
  }
}

/** Dump the app container's logs — the forensics for any failure. */
function dumpAppLogs() {
  try {
    log(`--- ${APP_CONTAINER} logs ---`);
    console.log(shOut(`docker logs ${APP_CONTAINER} 2>&1 | tail -100`));
  } catch {
    log("(app logs unavailable — container may be gone)");
  }
}

async function main() {
  // Tear down on every way out, however we exit.
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  process.on("exit", teardown);

  sweep();

  // 1. Network + throwaway Postgres, bound to nothing on the host.
  sh(`docker network create ${NETWORK}`);
  log("starting Postgres container...");
  sh(
    `docker run -d --name ${PG_CONTAINER} --network ${NETWORK} ` +
      `-e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=${PG_PASSWORD} -e POSTGRES_DB=${PG_DB} ` +
      `postgres:16-alpine`,
  );
  await pollCommand(
    `docker exec ${PG_CONTAINER} psql -U postgres -d ${PG_DB} -tAc "select 1"`,
    PG_DEADLINE_MS,
    "postgres",
  );
  log("postgres ready (real query answered)");

  // 2. The image under test — the container the PR actually ships. Boot env
  //    is exactly the certified minimal set: AUTH_DISABLED=true (compose
  //    default; skips the secret boot guards) + DATABASE_URL pointing at
  //    the pg container by name over the docker network.
  const port = await freePort();
  log(`booting ${IMAGE} on 127.0.0.1:${port} ...`);
  sh(
    `docker run -d --name ${APP_CONTAINER} --network ${NETWORK} ` +
      `-p 127.0.0.1:${port}:3000 ` +
      `-e AUTH_DISABLED=true -e DATABASE_URL=${DATABASE_URL} ` +
      IMAGE,
  );

  // 3. Deep health — the certification itself: the app booted, connected to
  //    Postgres, auto-migrated, and serves. Assert the response SHAPE, not
  //    a hard migration count — a new migration must never break the gate.
  let health = null;
  {
    const url = `http://127.0.0.1:${port}/api/health?deep=true`;
    const deadline = Date.now() + APP_DEADLINE_MS;
    for (;;) {
      try {
        const res = await fetch(url);
        const body = await res.json();
        if (res.ok && body.ok === true && body.db === true && typeof body.migrations === "number") {
          health = body;
          break;
        }
        log(`health answered, not ready yet: ${res.status} ${JSON.stringify(body)}`);
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        throw new Error(`app did not answer deep health in ${APP_DEADLINE_MS / 1000}s`);
      }
      if (!appContainerRunning()) {
        throw new Error("app container exited before answering health — boot crash");
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
  log(`DEEP HEALTH: ${JSON.stringify(health)} — image certified`);
}

const exit = (code, err) => {
  if (err) log(`FATAL: ${err instanceof Error ? err.message : err}`);
  // Forensics before teardown: the app container's last words are the whole
  // point of the gate (e.g. "Cannot find module ... sharp" under musl).
  if (code !== 0) dumpAppLogs();
  process.exit(code);
};

main()
  .then(() => exit(0))
  .catch((err) => exit(1, err));

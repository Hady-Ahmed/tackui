/**
 * Real-Postgres test harness (testcontainers) — for the paths pg-mem
 * cannot emulate: `WITH RECURSIVE` CTEs, cross-statement ROLLBACK inside
 * `withTransaction`, and pg_catalog index metadata.
 *
 * `useRealPostgres()` swaps the shared query() test client (normally the
 * per-file pg-mem injection from vitest.setup.ts) to a throwaway Postgres
 * container for the duration of ONE test, runs the idempotent migrations
 * against it, and returns a restore function that puts the previous
 * client back. Returns null only when the local environment genuinely
 * can't run containers (no Docker daemon) — callers should `ctx.skip()`
 * with a note so Docker-less environments stay green. On CI there is no
 * legitimate skip: any probe failure throws and fails the job.
 *
 * The container is a module-level singleton per test file (vitest's
 * `isolate: true` gives each file its own module registry, so each file
 * using this harness starts its own container — a few seconds of startup
 * amortized across that file's real-PG tests). Cleanup on process exit
 * is handled by testcontainers' Ryuk reaper; no explicit stop needed.
 */
import { setTestDb, getPoolOrTestClient, type PgClient } from "./pg";
import { runMigrations } from "./migrate";

// Structural types only — the real classes come from the lazy import so
// this module's import graph stays cheap and the container is only
// started when a real-PG test actually asks for it.
let container: { stop: () => Promise<unknown> } | null = null;
let pool: { end: () => Promise<unknown>; query: PgClient["query"] } | null =
  null;
let starting: Promise<boolean> | null = null;

/**
 * Does this error mean "this environment can't run containers" — the only
 * condition allowed to skip the real-Postgres tier (locally; on CI nothing
 * may skip)? Deliberately narrow: connection/permission errors on the
 * Docker socket and daemon-level errors. Anything else — a library crash,
 * a bug — is NOT docker-unavailability and must surface. The cautionary
 * tale (#90): testcontainers' nested undici crashed at import on Node 20,
 * the catch-all labeled it "Docker down", and CI ran green with zero
 * real-Postgres coverage.
 */
function isDockerUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = `${err.message} ${(err as NodeJS.ErrnoException).code ?? ""}`;
  return (
    /\bECONNREFUSED\b/.test(msg) || // daemon not listening
    /\bENOENT\b/.test(msg) || // docker socket missing
    /\bEACCES\b|\bEPERM\b/.test(msg) || // no permission on the socket
    /error response from daemon|cannot connect to the docker daemon|is the docker daemon running/i.test(
      msg,
    )
  );
}

async function ensureStarted(): Promise<boolean> {
  if (container && pool) return true;
  if (!starting) {
    starting = (async () => {
      try {
        const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
        const c = await new PostgreSqlContainer("postgres:16-alpine").start();
        const { Pool } = await import("pg");
        // Pool sizing honors PG_POOL_MAX / PG_CONNECT_TIMEOUT when a test
        // file sets them inline (never env files) to prove pool-exhaustion
        // behavior deterministically — e.g. the hot-row semaphore tests
        // shrink the pool below the writer count. Defaults mirror pg
        // (max 10, no connect timeout).
        const p = new Pool({
          connectionString: c.getConnectionUri(),
          max: process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : undefined,
          connectionTimeoutMillis: process.env.PG_CONNECT_TIMEOUT
            ? Number(process.env.PG_CONNECT_TIMEOUT)
            : undefined,
        });
        container = c;
        pool = p;
        return true;
      } catch (err) {
        // CI provisions Docker — a probe failure there is always a bug or
        // an environment break, never a legitimate skip. Locally, only
        // genuine docker-unavailability skips; anything else throws.
        if (process.env.CI || !isDockerUnavailable(err)) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        console.warn(
          "[test-postgres] Real Postgres unavailable (Docker down or image pull failed) — " +
            "skipping the real-Postgres tests:",
          err instanceof Error ? err.message : String(err),
        );
        return false;
      } finally {
        starting = null;
      }
    })();
  }
  return starting;
}

// Serializes useRealPostgres end-to-end. Vitest abandons a hook when it
// times out but the abandoned async keeps running — without this mutex,
// the next hook's runMigrations() can race the abandoned one on the same
// container: concurrent CREATE TABLE schema_migrations crashes with a
// pg_type duplicate-key error (seen on the first Node-24 CI run, #90 —
// the 10s hookTimeout expired during a slow container start).
let tail: Promise<unknown> = Promise.resolve();

export async function useRealPostgres(): Promise<(() => void) | null> {
  // .catch shields the chain: a prior abandoned call that eventually
  // rejects must not poison everyone queued behind it.
  const run = tail
    .catch(() => {})
    .then(async (): Promise<(() => void) | null> => {
      const ok = await ensureStarted();
      if (!ok || !pool) return null;
      // The callers' beforeEach injects a fresh pg-mem client per test —
      // capture exactly what's live right now and restore it afterwards.
      const previous = getPoolOrTestClient() as unknown as PgClient;
      setTestDb(pool as unknown as PgClient);
      await runMigrations();
      return () => {
        setTestDb(previous);
      };
    });
  tail = run;
  return run;
}

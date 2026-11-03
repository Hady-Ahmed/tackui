import * as Sentry from "@sentry/nextjs";

const PG_RETRY_INTERVAL_MS = 2_000;
const PG_MAX_RETRIES = 15;

/**
 * Retry an async operation with backoff. PG may not be ready for TCP
 * connections when the app boots (the docker-compose healthcheck checks
 * local socket readiness, not cross-container TCP). Retries until PG
 * accepts connections.
 *
 * Returns null when every attempt failed — callers that leave the app
 * NON-FUNCTIONAL in that state must fail fast (exit non-zero) instead of
 * booting a server that 500s everything while the orchestrator's liveness
 * probe keeps it "healthy" forever.
 */
async function retryPg<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries = PG_MAX_RETRIES,
): Promise<T | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        console.error(`[${label}] failed after ${maxRetries} attempts`, { error: msg });
      } else {
        console.log(`[${label}] attempt ${attempt}/${maxRetries} failed, retrying in ${PG_RETRY_INTERVAL_MS / 1000}s...`);
      }
      await new Promise((r) => setTimeout(r, PG_RETRY_INTERVAL_MS));
    }
  }
  return null;
}

/**
 * Fail fast when a boot step that leaves the app non-functional exhausted
 * its retries: without app tables (migrations) or auth tables, every
 * request 500s — and a merely-logged error would let orchestrators keep a
 * permanently-broken container "healthy". Exiting non-zero makes the
 * container unhealthy (Docker/k8s restart it; compose dependency gates
 * never go green), which is the truthful signal. Real PG connectivity is
 * verified by the retries themselves — this fires only when PG accepted
 * connections but the step still failed, OR PG never came up in ~30s.
 */
function failFast(step: string, err?: unknown): never {
  const detail = err instanceof Error ? err.message : err ? String(err) : "retries exhausted";
  console.error(
    `[boot] FATAL: ${step} failed (${detail}) — the app cannot serve requests without it. Exiting non-zero so the orchestrator restarts/reports unhealthy.`,
  );
  process.exit(1);
}

/**
 * Next.js instrumentation hook — runs ONCE on server boot, before any
 * request is accepted. Used to auto-run database migrations so self-hosters
 * can just `docker-compose up` without manually running migrate commands.
 *
 * This file is bundled for BOTH Node.js and Edge runtimes. We guard the
 * Node.js-only code with NEXT_RUNTIME so the Edge bundler skips it
 * entirely (dynamic import() prevents node:fs/pg from being pulled into
 * the Edge bundle, which would produce warnings).
 *
 * All three steps retry until PG is ready (up to ~30s). Idempotent — safe
 * to run on every boot:
 *   1. Sentry server-side SDK init (nodejs + edge runtimes)
 *   2. `runMigrations()` — creates/updates app tables (agents, agent_runs,
 *      run_state, thread_messages, thread_metadata) from lib/db/migrations/*.sql
 *   3. `ensureAuthTables()` — creates Better Auth tables (user, session,
 *      account, verification, organization, member, invitation) via Better
 *      Auth's getMigrations() API
 *   4. `ensureSoloOrg()` — when AUTH_DISABLED=true, creates a real org row
 *      so the synthetic admin has a valid org_id for scoping (NOT NULL)
 */
export async function register() {
  // Initialize the Sentry server-side SDK. withSentryConfig does NOT
  // auto-import these files — instrumentation.ts must import them so
  // Sentry.init() runs in the matching runtime. The config files
  // themselves guard on env var presence (no-op if SENTRY_DSN is unset).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }

  // Migrations are Node.js-only — they need node:fs, node:path, and pg.
  if (process.env.NEXT_RUNTIME === "edge") return;

  const { runMigrations } = await import("@/lib/db/migrate");
  const { ensureAuthTables } = await import("@/lib/auth/migrate");
  const { ensureSoloOrg } = await import("@/lib/auth/solo-org");
  const { logAgentosWarnings } = await import("@/lib/config/agentos");

  const migrationResult = await retryPg("migrate", () => runMigrations());
  if (!migrationResult) failFast("migrations");
  if (migrationResult.applied.length > 0) {
    console.log(`[migrate] applied ${migrationResult.applied.length} migration(s): ${migrationResult.applied.join(", ")}`);
  } else {
    console.log("[migrate] no new migrations to apply");
  }

  // Stale run-state reset: is_running=true rows surviving a crash or
  // restart previously made those threads permanently unrunnable —
  // "Thread already running" with no recovery path, because no process
  // owns them anymore (ACTIVE_CONNECTIONS is empty at boot and stop()
  // only reaches in-process connections). Safe at boot: no run can be
  // in flight in a process that is still starting. Single-instance
  // deployments only (the documented constraint) — a second instance
  // booting would reset the first one's live locks.
  // Non-fatal: a failed reset strands threads as "already running"
  // (annoying, recoverable by rerunning boot) but does not 500 the app.
  const resetResult = await retryPg("run-state-reset", async () => {
    const { query } = await import("@/lib/db/pg");
    return query(
      `UPDATE run_state SET is_running = false, current_run_id = NULL WHERE is_running = true`,
    );
  });
  if (resetResult && resetResult.rowCount && resetResult.rowCount > 0) {
    console.log(
      `[boot] reset ${resetResult.rowCount} stale in-flight run state(s) from a previous process`,
    );
  }

  const authOk = await retryPg("auth", () => ensureAuthTables());
  if (!authOk) failFast("auth tables");
  console.log("[auth] tables ensured");

  if (process.env.AUTH_DISABLED === "true") {
    await retryPg("solo-org", () => ensureSoloOrg());
  }

  // Platform misconfiguration surface: AGENTOS_BASE_URL without its JWT
  // secret boots fine but every builder run 401s at the dispatcher — warn
  // at boot where the operator is looking, not at first-run failure.
  logAgentosWarnings();

  // Encrypt-at-rest backfill: re-encrypt agent JWT secrets stored in
  // plaintext before DB_ENCRYPTION_KEY was configured. Idempotent —
  // rows already carrying the `enc:v1:` prefix are filtered out. When
  // no key is configured, warn loudly (secrets stay plaintext) instead
  // of backfilling.
  // Encryption at rest is a boot REQUIREMENT outside solo-dev mode: with
  // DB_ENCRYPTION_KEY unset, BYOK keys, connector tokens and agent JWT
  // secrets would be stored unencrypted with only a console.warn — a
  // config mistake that silently betrays the at-rest-encryption invariant
  // (and the marketing/docs claim) in production. Solo mode
  // (AUTH_DISABLED=true, a local playground with no real tenants or
  // secrets) keeps the plaintext fallback so a bare `docker-compose up`
  // demo still boots.
  const { isEncryptionConfigured } = await import("@/lib/crypto/encrypt");
  if (!isEncryptionConfigured()) {
    if (process.env.AUTH_DISABLED === "true") {
      console.warn(
        "[encrypt] DB_ENCRYPTION_KEY is not set — solo mode keeps the plaintext fallback (local playground only).",
      );
    } else {
      throw new Error(
        "DB_ENCRYPTION_KEY is required: BYOK keys, connector tokens and agent JWT secrets are encrypted at rest, and booting without the key would store them in plaintext. Set DB_ENCRYPTION_KEY (generate with: openssl rand -hex 32) — or set AUTH_DISABLED=true for a solo local playground.",
      );
    }
  } else {
    const { backfillEncryptedSecrets } = await import("@/lib/crypto/backfill");
    const backfillResult = await retryPg("encrypt-backfill", () =>
      backfillEncryptedSecrets(),
    );
    if (backfillResult && backfillResult.encrypted > 0) {
      console.log(
        `[encrypt] encrypted ${backfillResult.encrypted} agent JWT secret(s) at rest (previously plaintext)`,
      );
    }
  }
}

// Capture errors from Server Components, route handlers, middleware, and
// proxies. Required for Sentry to receive server-side errors under the
// App Router — without this, route-handler throws (e.g. in /api/* routes)
// are logged by Next.js but never reach Sentry.
export const onRequestError = Sentry.captureRequestError;

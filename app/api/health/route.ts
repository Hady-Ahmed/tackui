import { NextResponse } from "next/server";
import { query } from "@/lib/db/pg";
import { checkLimit } from "@/lib/ratelimit/store";
import { LIMITS } from "@/lib/ratelimit/limits";
import { getClientIp } from "@/lib/ratelimit/client-ip";

/**
 * Liveness health check. Returns 200 if the Node process is alive and
 * can serve requests. Does NOT check database connectivity — a flaky PG
 * would make this flap and cause orchestrators to bounce the app
 * unnecessarily.
 *
 * `GET /api/health?deep=true` is the READINESS probe: it pings Postgres
 * and counts the applied migrations (schema_migrations — created by
 * migration 0001, so a count success proves the DB is reachable AND the
 * app tables bootstrapped). 503 with `db: false` otherwise. Use it for
 * orchestrator readiness gates and post-deploy smoke checks; keep the
 * plain probe for liveness.
 *
 * This route is exempt from the proxy.ts cookie gate AND per-IP flood
 * limiter so orchestrators (Docker Compose healthcheck, k8s liveness
 * probe, load balancers) can poll it without a session cookie. That
 * exemption is safe for liveness (pure CPU, no I/O) but NOT for the deep
 * probe (a PG roundtrip per call) — so the deep branch rate-limits
 * itself per client IP. Legitimate orchestrators poll every few seconds
 * (≤30/min, one or two IPs); an anonymous flood of deep probes 429s
 * like any other /api route would.
 */
export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "true";
  if (!deep) {
    return NextResponse.json({ ok: true });
  }

  const ip = getClientIp((name) => request.headers.get(name));
  const limited = checkLimit(`healthDeep:${ip}`, LIMITS.healthDeep.max, LIMITS.healthDeep.windowMs);
  if (!limited.allowed) {
    const retryAfter = Math.ceil((limited.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { ok: false, error: "Too many requests. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, retryAfter)),
        },
      },
    );
  }

  try {
    const result = await query<{ applied: number }>(
      `SELECT count(*)::int AS applied FROM schema_migrations`,
    );
    return NextResponse.json({
      ok: true,
      db: true,
      migrations: result.rows[0]?.applied ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log the detail server-side; the body stays generic — this route is
    // unauthenticated and errors can carry connection-string fragments.
    console.error("[health] deep probe failed:", message);
    return NextResponse.json(
      { ok: false, db: false, error: "database unreachable" },
      { status: 503 },
    );
  }
}

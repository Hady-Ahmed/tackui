import { NextResponse } from "next/server";
import { query } from "@/lib/db/pg";

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
 * This route is exempt from the proxy.ts cookie gate so orchestrators
 * (Docker Compose healthcheck, k8s liveness probe, load balancers) can
 * poll it without a session cookie.
 */
export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "true";
  if (!deep) {
    return NextResponse.json({ ok: true });
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
      { ok: true, db: false, error: "database unreachable" },
      { status: 503 },
    );
  }
}

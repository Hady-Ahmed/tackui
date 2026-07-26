import { NextResponse } from "next/server";

/**
 * Liveness health check. Returns 200 if the Node process is alive and
 * can serve requests. Does NOT check database connectivity — a flaky PG
 * would make this flap and cause orchestrators to bounce the app
 * unnecessarily. For a deeper readiness check, add a PG ping variant
 * behind a query param (e.g. ?deep=true) in the future.
 *
 * This route is exempt from the proxy.ts cookie gate so orchestrators
 * (Docker Compose healthcheck, k8s liveness probe, load balancers) can
 * poll it without a session cookie.
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { checkLimit } from "@/lib/ratelimit/store";
import { LIMITS } from "@/lib/ratelimit/limits";

const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

const PUBLIC_ROUTES = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"];
const AUTH_API_PREFIX = "/api/auth";
const HEALTH_PREFIX = "/api/health";

// Pin to Node.js runtime — the in-memory rate-limit store requires it.
// Switching to edge would break the shared Map (each request gets a fresh
// isolate). For edge deployment, replace the store with a Redis backend.
export const runtime = "nodejs";

/**
 * Extract the client IP from the request. Behind a reverse proxy, reads
 * the first non-private hop from X-Forwarded-For. In dev (no proxy),
 * falls back to request.ip.
 */
function getClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    // X-Forwarded-For: client, proxy1, proxy2 — take the first (client).
    // Trim whitespace; ignore empty entries.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export async function proxy(request: NextRequest) {
  if (AUTH_DISABLED) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // /api/health is always unlimited (orchestrator probes have no session).
  if (pathname.startsWith(HEALTH_PREFIX)) {
    return NextResponse.next();
  }

  // Per-IP global flood protection on all /api/* routes (except /api/health
  // which is already bypassed above, and /api/auth which has its own
  // Better Auth rate limiter configured in lib/auth/auth.ts).
  if (pathname.startsWith("/api/") && !pathname.startsWith(AUTH_API_PREFIX)) {
    const ip = getClientIp(request);
    const result = checkLimit(
      `globalIp:${ip}`,
      LIMITS.globalIp.max,
      LIMITS.globalIp.windowMs,
    );
    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
      return NextResponse.json(
        { error: "Too many requests. Try again later." },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": String(LIMITS.globalIp.max),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.floor(result.resetAt / 1000)),
            "Retry-After": String(Math.max(1, retryAfter)),
          },
        },
      );
    }
  }

  if (
    pathname.startsWith(AUTH_API_PREFIX) ||
    PUBLIC_ROUTES.includes(pathname)
  ) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

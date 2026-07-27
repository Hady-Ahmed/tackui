import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { checkLimit } from "@/lib/ratelimit/store";
import { LIMITS } from "@/lib/ratelimit/limits";

const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

const PUBLIC_ROUTES = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"];
const AUTH_API_PREFIX = "/api/auth";
const HEALTH_PREFIX = "/api/health";

// The proxy always runs on Node.js in Next.js 16 (it was the default for
// middleware too, but now it's the only option). The in-memory rate-limit
// store relies on this — a shared Map persists across requests in the same
// process. For edge deployment (not supported by the proxy), replace the
// store with a Redis backend.

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

import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { checkLimit } from "@/lib/ratelimit/store";
import { LIMITS } from "@/lib/ratelimit/limits";

const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";
const SAAS_MODE = process.env.SAAS_MODE === "true";

// Number of trusted reverse-proxy hops in front of this server. The
// client IP is the Nth-from-RIGHT entry in X-Forwarded-For, where N is
// this count. Default 1 (Vercel / Railway / Render / a single Nginx in
// front all set the real client IP as the LAST entry).
//
// Why rightmost, not leftmost: X-Forwarded-For is client-appendable. A
// malicious client can send `X-Forwarded-For: fake-ip` and, if the
// proxy appends the real IP (the standard behaviour), the header
// becomes `fake-ip, real-ip`. Taking the leftmost would rate-limit
// against the spoofed value — attacker rotates it to bypass the
// 300/min cap. Taking the rightmost-trusted-hop reads the real client
// IP set by YOUR proxy.
//
// Set to 2 if you run Cloudflare -> Nginx -> app (two hops), 3 for
// three hops, etc. If unset, defaults to 1.
const TRUSTED_PROXY_HOPS = Math.max(
  1,
  Number(process.env.TRUSTED_PROXY_HOPS ?? "1") || 1,
);

// Auth pages are always public. Under SaaS mode the marketing landing page
// (`/`) plus legal pages (`/terms`, `/privacy`) are also public so anonymous
// visitors can read the marketing site. Self-host mode keeps `/` gated (it
// IS the chat app, auth-required).
const AUTH_ROUTES = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"];
const SAAS_PUBLIC_ROUTES = ["/", "/terms", "/privacy"];
const PUBLIC_ROUTES = SAAS_MODE
  ? [...AUTH_ROUTES, ...SAAS_PUBLIC_ROUTES]
  : AUTH_ROUTES;
const AUTH_API_PREFIX = "/api/auth";
const HEALTH_PREFIX = "/api/health";
// Stripe webhooks are server-to-server with no session cookie and carry
// their own signature verification (app/api/billing/webhook/route.ts).
// Bypass the cookie gate + per-IP rate limit so Stripe's retries aren't
// throttled. Auth-disabled mode already returns next() before this runs.
const WEBHOOK_PREFIX = "/api/billing/webhook";

// The proxy always runs on Node.js in Next.js 16 (it was the default for
// middleware too, but now it's the only option). The in-memory rate-limit
// store relies on this — a shared Map persists across requests in the same
// process. For edge deployment (not supported by the proxy), replace the
// store with a Redis backend.

/**
 * Extract the client IP from the request. Behind a reverse proxy,
 * reads the Nth-from-right entry of X-Forwarded-For where N is
 * TRUSTED_PROXY_HOPS (default 1 — the last entry, set by the trusted
 * proxy). This defeats the leftmost-spoofing attack: a client can
 * prepend arbitrary IPs to XFF, but the proxy appends the real client
 * IP LAST, and we read from the trusted side.
 *
 * If there are fewer XFF entries than TRUSTED_PROXY_HOPS (the proxy
 * didn't append, or direct connection in dev), fall back to the
 * leftmost available — and if no XFF at all, "unknown".
 */
function getClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      // Take the Nth-from-right. If we have fewer hops than trusted
      // proxies (direct connection, or proxy didn't forward), fall
      // back to the leftmost available entry.
      const idx = Math.max(0, hops.length - TRUSTED_PROXY_HOPS);
      return hops[idx] ?? hops[0] ?? "unknown";
    }
  }
  return "unknown";
}

export async function proxy(request: NextRequest) {
  if (AUTH_DISABLED) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // /api/health is always unlimited (orchestrator probes have no session).
  // /api/billing/webhook is verified by Stripe signature, not a session.
  if (pathname.startsWith(HEALTH_PREFIX) || pathname.startsWith(WEBHOOK_PREFIX)) {
    return NextResponse.next();
  }

  // Per-IP global flood protection on all /api/* routes (except the
  // bypassed health + billing webhook routes, and /api/auth which has its
  // own Better Auth rate limiter configured in lib/auth/auth.ts).
  if (pathname.startsWith("/api/") && !pathname.startsWith(AUTH_API_PREFIX)) {
    const ip = getClientIp(request);
    const result = checkLimit(
      `globalIp:${ip}`,
      LIMITS.globalIp.max,
      LIMITS.globalIp.windowMs,
    );
    // TEMP DEBUG — remove after diagnosing the rate-limit issue.
    console.log("[proxy-debug] rate-limit", {
      ip,
      allowed: result.allowed,
      remaining: result.remaining,
      xff: request.headers.get("x-forwarded-for"),
    });
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

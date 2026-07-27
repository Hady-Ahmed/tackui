import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock better-auth/cookies — the proxy uses getSessionCookie for the
// session check. Default: no session cookie (unauthenticated).
const mockGetSessionCookie = vi.fn().mockReturnValue(null);
vi.mock("better-auth/cookies", () => ({
  getSessionCookie: (...args: unknown[]) => mockGetSessionCookie(...args),
}));

// Use the real rate-limit store — reset between tests so limits don't
// bleed across test cases.
import { _resetForTests } from "@/lib/ratelimit/store";

function makeRequest(
  pathname: string,
  opts: { ip?: string; cookie?: string } = {},
) {
  const url = `http://localhost${pathname}`;
  const headers = new Headers();
  if (opts.ip) headers.set("x-forwarded-for", opts.ip);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(url, { headers });
}

async function importProxy() {
  vi.resetModules();
  const mod = await import("./proxy");
  return mod.proxy;
}

beforeEach(() => {
  _resetForTests();
  mockGetSessionCookie.mockReturnValue(null);
  vi.clearAllMocks();
});

afterEach(() => {
  _resetForTests();
});

describe("proxy — AUTH_DISABLED=true", () => {
  it("bypasses all checks when AUTH_DISABLED", async () => {
    // AUTH_DISABLED is set to "true" in vitest.setup.ts, so the default
    // import already has it. But we reset modules in importProxy, so
    // we need to ensure the env is still "true".
    const proxy = await importProxy();
    const res = await proxy(makeRequest("/api/agents"));
    expect(res.status).toBe(200);
  });
});

describe("proxy — per-IP rate limiting (AUTH_DISABLED=false)", () => {
  let proxy: (req: NextRequest) => Promise<NextResponse>;

  beforeEach(async () => {
    const orig = process.env.AUTH_DISABLED;
    process.env.AUTH_DISABLED = "false";
    proxy = await importProxy();
    process.env.AUTH_DISABLED = orig;
  });

  it("allows requests under the limit", async () => {
    const res = await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    // Passes the rate limit → hits the cookie gate → 401 (no session).
    // The point is it's NOT 429.
    expect(res.status).toBe(401);
  });

  it("blocks requests over the limit with 429", async () => {
    // Exhaust the limit (300/min)
    for (let i = 0; i < 300; i++) {
      await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    }
    const res = await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toContain("Too many requests");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("300");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("tracks IPs independently", async () => {
    // Exhaust IP 1.2.3.4
    for (let i = 0; i < 300; i++) {
      await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    }
    // Different IP should still be allowed
    const res = await proxy(makeRequest("/api/agents", { ip: "5.6.7.8" }));
    expect(res.status).not.toBe(429);
  });

  it("/api/health is exempt from rate limiting", async () => {
    // Exhaust the limit
    for (let i = 0; i < 300; i++) {
      await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    }
    // /api/health should still pass
    const res = await proxy(makeRequest("/api/health", { ip: "1.2.3.4" }));
    expect(res.status).toBe(200);
  });

  it("/api/auth/* is exempt from the global IP limiter", async () => {
    // Exhaust the limit
    for (let i = 0; i < 300; i++) {
      await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    }
    // /api/auth/* should not be limited by the global IP limiter
    const res = await proxy(makeRequest("/api/auth/sign-in", { ip: "1.2.3.4" }));
    expect(res.status).not.toBe(429);
  });

  it("extracts IP from X-Forwarded-For (first hop)", async () => {
    // Send 300 requests with a multi-hop X-Forwarded-For
    for (let i = 0; i < 300; i++) {
      await proxy(
        makeRequest("/api/agents", {
          ip: "1.2.3.4, 10.0.0.1, 10.0.0.2",
        }),
      );
    }
    // The first IP (1.2.3.4) should be the one limited
    const res = await proxy(
      makeRequest("/api/agents", {
        ip: "1.2.3.4, 10.0.0.1, 10.0.0.2",
      }),
    );
    expect(res.status).toBe(429);
  });

  it("non-API routes are not rate limited by the IP layer", async () => {
    // Exhaust the limit on API routes
    for (let i = 0; i < 300; i++) {
      await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    }
    // A page route should not be 429'd by the IP limiter (it might
    // redirect to login, but that's the cookie gate, not rate limiting)
    const res = await proxy(makeRequest("/agents", { ip: "1.2.3.4" }));
    expect(res.status).not.toBe(429);
  });
});

describe("proxy — cookie gate (AUTH_DISABLED=false)", () => {
  let proxy: (req: NextRequest) => Promise<NextResponse>;

  beforeEach(async () => {
    const orig = process.env.AUTH_DISABLED;
    process.env.AUTH_DISABLED = "false";
    proxy = await importProxy();
    process.env.AUTH_DISABLED = orig;
  });

  it("returns 401 for unauthenticated API requests", async () => {
    mockGetSessionCookie.mockReturnValue(null);
    const res = await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("redirects to login for unauthenticated page requests", async () => {
    mockGetSessionCookie.mockReturnValue(null);
    const res = await proxy(makeRequest("/agents", { ip: "1.2.3.4" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/login");
    expect(res.headers.get("Location")).toContain("redirect=%2Fagents");
  });

  it("passes through when session cookie is present", async () => {
    mockGetSessionCookie.mockReturnValue("session-token-value");
    const res = await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    expect(res.status).toBe(200);
  });

  it("passes through public routes (login, signup, verify-email, forgot-password, reset-password)", async () => {
    mockGetSessionCookie.mockReturnValue(null);
    for (const route of ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"]) {
      const res = await proxy(makeRequest(route, { ip: "1.2.3.4" }));
      expect(res.status).toBe(200);
    }
  });
});

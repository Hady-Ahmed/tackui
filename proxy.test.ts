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
  opts: { ip?: string; cookie?: string; headers?: Record<string, string> } = {},
) {
  const url = `http://localhost${pathname}`;
  const headers = new Headers(opts.headers);
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

  it("/api/billing/webhook is exempt from rate limiting + cookie gate", async () => {
    // Exhaust the limit
    for (let i = 0; i < 300; i++) {
      await proxy(makeRequest("/api/agents", { ip: "1.2.3.4" }));
    }
    // No session cookie — must still pass (Stripe calls server-to-server)
    const res = await proxy(
      makeRequest("/api/billing/webhook", { ip: "1.2.3.4" }),
    );
    expect(res.status).toBe(200);
  });

  it("extracts IP from X-Forwarded-For as the trusted rightmost hop", async () => {
    // TRUSTED_PROXY_HOPS defaults to 1: the bucket key is the LAST entry
    // (10.0.0.2 — the IP your proxy appended), not the first.
    for (let i = 0; i < 300; i++) {
      await proxy(
        makeRequest("/api/agents", {
          ip: "1.2.3.4, 10.0.0.1, 10.0.0.2",
        }),
      );
    }
    // Same trusted entry → same bucket → limited.
    const res = await proxy(
      makeRequest("/api/agents", {
        ip: "9.9.9.9, 10.0.0.1, 10.0.0.2",
      }),
    );
    expect(res.status).toBe(429);
  });

  it("leftmost X-Forwarded-For rotation cannot evade the bucket (spoof defense)", async () => {
    // A client appendable header: the attacker prepends a fresh fake IP
    // per request while the trusted proxy keeps appending the SAME real
    // IP. Leftmost-taking would give each request a new bucket; the
    // rightmost-trusted-hop key stays fixed and the flood is capped.
    mockGetSessionCookie.mockReturnValue("session=stubbed");
    try {
      for (let i = 0; i < 300; i++) {
        const res = await proxy(
          makeRequest("/api/agents", {
            cookie: "better-auth.session=stubbed",
            ip: `10.9.9.${i % 250}, 10.9.9.${(i + 1) % 250}, 203.0.113.99`,
          }),
        );
        expect(res.status).toBe(200);
      }
      const res = await proxy(
        makeRequest("/api/agents", {
          cookie: "better-auth.session=stubbed",
          ip: "anything, 203.0.113.99",
        }),
      );
      expect(res.status).toBe(429);
    } finally {
      mockGetSessionCookie.mockReturnValue(null);
    }
  });

  it("ignores CF-Connecting-IP when Cloudflare trust is off (default outside SaaS mode)", async () => {
    // Without SAAS_MODE or TRUST_CF_CONNECTING_IP, the header is treated
    // as client-suppliable: a spoofed value must NOT open a fresh bucket.
    // Exhaust the XFF-derived bucket, then send a request carrying both a
    // spoofed CF header and the same XFF — it must land in the SAME
    // (exhausted) bucket, proving the CF header was ignored.
    for (let i = 0; i < 300; i++) {
      await proxy(makeRequest("/api/agents", { ip: "203.0.113.50" }));
    }
    const res = await proxy(
      makeRequest("/api/agents", {
        ip: "203.0.113.50",
        headers: { "cf-connecting-ip": "1.1.1.1" },
      }),
    );
    expect(res.status).toBe(429);
  });

  it("honors CF-Connecting-IP when TRUST_CF_CONNECTING_IP=true (CF-fronted self-host)", async () => {
    // importProxy() re-evaluates the module consts, so BOTH env vars must
    // be pinned for the re-import (AUTH_DISABLED=false restored by the
    // beforeEach would otherwise bypass the limiter entirely).
    const origAuth = process.env.AUTH_DISABLED;
    process.env.TRUST_CF_CONNECTING_IP = "true";
    process.env.AUTH_DISABLED = "false";
    try {
      proxy = await importProxy();
      for (let i = 0; i < 300; i++) {
        await proxy(
          makeRequest("/api/agents", {
            headers: { "cf-connecting-ip": "198.51.100.77" },
          }),
        );
      }
      const res = await proxy(
        makeRequest("/api/agents", {
          headers: { "cf-connecting-ip": "198.51.100.77" },
        }),
      );
      expect(res.status).toBe(429);
      // And the XFF path is a DIFFERENT bucket — the CF trust didn't
      // collapse the two resolution orders into one key. (The CF-side
      // requests above exhaust the limiter BEFORE the cookie gate, so
      // they don't need a session — this request must pass the gate.)
      mockGetSessionCookie.mockReturnValue("session=stubbed");
      const other = await proxy(
        makeRequest("/api/agents", {
          cookie: "better-auth.session=stubbed",
          ip: "203.0.113.200",
        }),
      );
      expect(other.status).toBe(200);
    } finally {
      delete process.env.TRUST_CF_CONNECTING_IP;
      process.env.AUTH_DISABLED = origAuth;
    }
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

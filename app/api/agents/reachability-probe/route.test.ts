import { describe, it, expect, vi, afterEach } from "vitest";
import { NextResponse } from "next/server";

// Mock the rate limiter — defaults to "always allow".
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock auth context — getCurrentUser returns a user by default.
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({
    id: "u1",
    role: "user",
    name: "User",
    email: null,
    orgId: "org-1",
  }),
}));

// Mock the SSRF guard — defaults to "safe" (resolves). Tests for the
// SSRF path override to throw UnsafeUrlError.
vi.mock("@/lib/net/safe-fetch", () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  UnsafeUrlError: class UnsafeUrlError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
      this.name = "UnsafeUrlError";
    }
  },
}));

// Mock the SaaS rejection message so we don't depend on env state.
vi.mock("@/lib/config/saas", () => ({
  SSRF_REJECTION_MESSAGE: "not permitted",
}));

import { POST } from "./route";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { getCurrentUser } from "@/lib/auth/context";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";

const originalFetch = globalThis.fetch;

function mockFetchOk(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ status }),
  );
}

function mockFetchError(error: Error) {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
}

afterEach(() => {
  vi.stubGlobal("fetch", originalFetch);
  vi.restoreAllMocks();
  // Clear call history on factory mocks (assertSafeUrl, canManageAgents,
  // getCurrentUser, checkUserLimit) — restoreAllMocks only resets
  // vi.spyOn spies, not vi.mock factory mocks. Without this, call-count
  // assertions leak across tests.
  vi.clearAllMocks();
});

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/agents/reachability-probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  endpoint: "http://localhost:8000/agent",
  kind: "agui" as const,
};

describe("POST /api/agents/reachability-probe", () => {
  it("returns ok when server responds", async () => {
    mockFetchOk(200);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe(200);
    expect(data.message).toContain("reachable");
  });

  it("returns ok for non-2xx (server still reachable)", async () => {
    mockFetchOk(404);
    const res = await POST(makeRequest(validBody));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe(404);
  });

  it("returns not ok when fetch fails", async () => {
    mockFetchError(new TypeError("fetch failed"));
    const res = await POST(makeRequest(validBody));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.message).toContain("Cannot reach server");
  });

  it("returns not ok on timeout", async () => {
    mockFetchError(new Error("The operation was aborted due to timeout"));
    Object.defineProperty(Error, "name", { value: "TimeoutError" });
    const err = new Error("timed out");
    Object.defineProperty(err, "name", { value: "TimeoutError" });
    mockFetchError(err);

    const res = await POST(makeRequest(validBody));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.message).toContain("timed out");
  });

  it("returns 400 for invalid endpoint", async () => {
    const res = await POST(
      makeRequest({ ...validBody, endpoint: "not-a-url" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid kind", async () => {
    const res = await POST(
      makeRequest({ ...validBody, kind: "openai" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents/reachability-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("masks raw error messages in the response", async () => {
    mockFetchError(new TypeError("getaddrinfo ENOTFOUND internal-db.local"));
    const res = await POST(makeRequest(validBody));
    const data = await res.json();
    expect(data.ok).toBe(false);
    // The raw error message (with internal hostname) must not leak
    expect(data.message).not.toContain("internal-db.local");
    expect(data.message).not.toContain("getaddrinfo");
    expect(data.message).toContain("Cannot reach server");
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
  });

  it("returns 401 when no user", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
  });

  it("rejects unsafe (private-IP) endpoints with the SSRF message", async () => {
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new UnsafeUrlError("hostname resolves to a private address"),
    );
    // Stub fetch so we can assert it was never reached.
    const fetchSpy = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("not permitted");
    // fetch must not be reached when the SSRF guard rejects.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets assertSafeUrl runtime errors propagate (not masked as SSRF)", async () => {
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(new Error("DNS blew up"));
    await expect(POST(makeRequest(validBody))).rejects.toThrow("DNS blew up");
  });
});

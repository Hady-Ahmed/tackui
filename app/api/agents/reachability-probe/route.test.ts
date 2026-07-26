import { describe, it, expect, vi, afterEach } from "vitest";
import { NextResponse } from "next/server";

// Mock the rate limiter — defaults to "always allow".
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

import { POST } from "./route";
import { checkUserLimit } from "@/lib/ratelimit/middleware";

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
});

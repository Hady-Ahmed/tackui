import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock auth so tests can vary the caller; rate limiter always allows.
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock the capability fetch; keep the real AgentosError class so the
// route's instanceof branch is exercised.
const mockFetchKnowledgeConfig = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    fetchKnowledgeConfig: (...a: unknown[]) => mockFetchKnowledgeConfig(...a),
  };
});

import { GET } from "./route";
import { AgentosError } from "@/lib/agents/builder";

function memberUser() {
  return { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockImplementation(async () => memberUser());
});

describe("GET /api/agents/[id]/knowledge/config", () => {
  it("returns 401 when not signed in", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFetchKnowledgeConfig).not.toHaveBeenCalled();
  });

  it("enforces the agentRead rate limit", async () => {
    const { checkUserLimit } = await import("@/lib/ratelimit/middleware");
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await GET();
    expect(res.status).toBe(429);
  });

  it("proxies the capability signal through (enabled, with the embedding contract)", async () => {
    mockFetchKnowledgeConfig.mockResolvedValue({
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  it("proxies the disabled/unsupported signals too — the form owns the distinction", async () => {
    mockFetchKnowledgeConfig.mockResolvedValue({
      enabled: false,
      provider: "",
      model: "",
      unsupported: true,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Pass-through, NOT remapped: unsupported stays its own field so the
    // section's hidden copy can name the right reason.
    expect(body).toEqual({
      enabled: false,
      provider: "",
      model: "",
      unsupported: true,
    });
  });

  it("passes through AgentOS service errors with their status", async () => {
    mockFetchKnowledgeConfig.mockRejectedValue(
      new AgentosError(503, "agentos down"),
    );
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("agentos down");
  });

  it("returns 502 for unexpected errors", async () => {
    mockFetchKnowledgeConfig.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("unavailable");
  });
});

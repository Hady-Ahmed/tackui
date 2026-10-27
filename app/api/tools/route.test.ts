import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock auth so tests can vary the caller; rate limiter always allows.
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock the AgentOS tools fetch; keep the real AgentosError class so the
// route's instanceof branch is exercised.
const mockFetchBuilderTools = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    fetchBuilderTools: (...a: unknown[]) => mockFetchBuilderTools(...a),
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

describe("GET /api/tools", () => {
  it("returns 401 when not signed in", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFetchBuilderTools).not.toHaveBeenCalled();
  });

  it("enforces the agentRead rate limit", async () => {
    const { checkUserLimit } = await import("@/lib/ratelimit/middleware");
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await GET();
    expect(res.status).toBe(429);
  });

  it("maps the AgentOS catalog to the client shape (camelCase flags)", async () => {
    mockFetchBuilderTools.mockResolvedValue([
      {
        name: "web_search",
        label: "Web search (DuckDuckGo)",
        description: "Search the web",
        requires_key: null,
        fallback_env: null,
        platform_fallback: false,
      },
      {
        name: "tavily_search",
        label: "Web search (Tavily)",
        description: null,
        requires_key: "tavily_api_key",
        fallback_env: "TAVILY_API_KEY",
        platform_fallback: true,
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toEqual([
      {
        name: "web_search",
        label: "Web search (DuckDuckGo)",
        description: "Search the web",
        requiresKey: null,
        fallbackEnv: null,
        platformFallback: false,
        parameters: null,
      },
      {
        name: "tavily_search",
        label: "Web search (Tavily)",
        description: null,
        requiresKey: "tavily_api_key",
        fallbackEnv: "TAVILY_API_KEY",
        platformFallback: true,
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
  });

  it("passes through AgentOS service errors with their status", async () => {
    mockFetchBuilderTools.mockRejectedValue(
      new AgentosError(503, "agentos down"),
    );
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("agentos down");
  });

  it("returns 502 for unexpected errors", async () => {
    mockFetchBuilderTools.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("unavailable");
  });
});

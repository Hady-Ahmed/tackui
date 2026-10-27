import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock auth so tests can vary the caller; rate limiter always allows.
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock the AgentOS model fetch; keep the real AgentosError class so the
// route's instanceof branch is exercised.
const mockFetchAgentosModels = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    fetchAgentosModels: (...a: unknown[]) => mockFetchAgentosModels(...a),
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

describe("GET /api/models", () => {
  it("returns 401 when not signed in", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFetchAgentosModels).not.toHaveBeenCalled();
  });

  it("maps the AgentOS catalog to the client shape (platformTier)", async () => {
    mockFetchAgentosModels.mockResolvedValue([
      { provider: "openai", id: "gpt-4o-mini", platform_tier: true },
      { provider: "openai", id: "gpt-5", platform_tier: false },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      { provider: "openai", id: "gpt-4o-mini", platformTier: true },
      { provider: "openai", id: "gpt-5", platformTier: false },
    ]);
  });

  it("passes through AgentOS service errors with their status", async () => {
    mockFetchAgentosModels.mockRejectedValue(
      new AgentosError(503, "agentos down"),
    );
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("agentos down");
  });

  it("returns 502 for unexpected errors", async () => {
    mockFetchAgentosModels.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("unavailable");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

const mockTestPlatformModel = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    testPlatformModel: (...a: unknown[]) => mockTestPlatformModel(...a),
  };
});

import { POST } from "./route";
import { AgentosError } from "@/lib/agents/builder";
import type { NextRequest } from "next/server";

function user(id: string, role = "user") {
  return { id, email: null, name: id, role, orgId: `org-${id}` };
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost:3000/api/admin/platform/test-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as NextRequest,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockImplementation(async () => user("admin-user", "admin"));
  mockTestPlatformModel.mockResolvedValue({ ok: true, reply: "Hi there!" });
});

describe("POST /api/admin/platform/test-model", () => {
  it("proxies the entry to the AgentOS test endpoint", async () => {
    const res = await post({ entry: "openai:gpt-4o-mini" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reply: "Hi there!" });
    expect(mockTestPlatformModel).toHaveBeenCalledWith("openai:gpt-4o-mini");
  });

  it("rejects a missing entry (400)", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(mockTestPlatformModel).not.toHaveBeenCalled();
  });

  it("passes the AgentOS error through verbatim (a provider 401 means the platform key is broken/missing)", async () => {
    mockTestPlatformModel.mockRejectedValue(
      new AgentosError(502, "provider 'openai' rejected the request (401)"),
    );
    const res = await post({ entry: "openai:gpt-4o-mini" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("401");
  });

  it("returns 401 without a user and 403 for a non-platform-admin", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    expect((await post({ entry: "openai:gpt-4o-mini" })).status).toBe(401);
    mockGetCurrentUser.mockImplementation(async () => user("org-admin", "owner"));
    expect((await post({ entry: "openai:gpt-4o-mini" })).status).toBe(403);
    expect(mockTestPlatformModel).not.toHaveBeenCalled();
  });

  it("enforces the agentMutate rate limit", async () => {
    const { checkUserLimit } = await import("@/lib/ratelimit/middleware");
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await post({ entry: "openai:gpt-4o-mini" });
    expect(res.status).toBe(429);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the auth context: the gate is platform-admin-only (role ===
// "admin"), so the tests vary the user object's role.
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

const mockFetchPlatformCatalog = vi.fn();
const mockPutModels = vi.fn();
const mockPutTools = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    fetchPlatformCatalog: (...a: unknown[]) => mockFetchPlatformCatalog(...a),
    putPlatformCatalogModels: (...a: unknown[]) => mockPutModels(...a),
    putPlatformCatalogTools: (...a: unknown[]) => mockPutTools(...a),
  };
});

import { GET, PUT } from "./route";
import { AgentosError } from "@/lib/agents/builder";
import type { NextRequest } from "next/server";

const CATALOG = {
  providers: [
    {
      slug: "openai",
      available: true,
      enabled: true,
      class_name: "OpenAIChat",
      requires_key: true,
      platform_env_key: "OPENAI_API_KEY",
      env_key_set: true,
      models: [{ id: "gpt-4o-mini", attrs: {}, tier: true }],
    },
  ],
  tools: [
    {
      slug: "tavily",
      available: true,
      enabled: false,
      class_name: "TavilyTools",
      label: "Tavily",
      functions: ["web_search_using_tavily"],
      credentials: [{ dep_key: "tavily_api_key", env: "TAVILY_API_KEY", arg: "api_key", label: "Tavily api key" }],
      deliverable: true,
    },
  ],
};

function user(id: string, role = "user") {
  return { id, email: null, name: id, role, orgId: `org-${id}` };
}

function put(body: unknown) {
  return PUT(
    new Request("http://localhost:3000/api/admin/platform/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as NextRequest,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockImplementation(async () => user("admin-user", "admin"));
  mockFetchPlatformCatalog.mockResolvedValue(CATALOG);
  mockPutModels.mockResolvedValue({ ok: true, revision: 7, warnings: [] });
  mockPutTools.mockResolvedValue({ ok: true, revision: 8, warnings: [] });
});

describe("GET /api/admin/platform/catalog", () => {
  it("proxies the AgentOS catalog (discovery ∪ durable rows)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CATALOG);
    expect(mockFetchPlatformCatalog).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without a user", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFetchPlatformCatalog).not.toHaveBeenCalled();
  });

  it("403s non-platform-admins — org admins and members alike (role is the gate)", async () => {
    mockGetCurrentUser.mockImplementation(async () => user("org-admin", "owner"));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockFetchPlatformCatalog).not.toHaveBeenCalled();
  });

  it("enforces the agentRead rate limit", async () => {
    const { checkUserLimit } = await import("@/lib/ratelimit/middleware");
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await GET();
    expect(res.status).toBe(429);
  });
});

describe("PUT /api/admin/platform/catalog", () => {
  it("forwards the providers half to the AgentOS models PUT", async () => {
    const res = await put({
      providers: [{ slug: "openai", enabled: true, models: ["gpt-4o-mini:tier"] }],
    });
    expect(res.status).toBe(200);
    expect(mockPutModels).toHaveBeenCalledWith([
      { slug: "openai", enabled: true, models: ["gpt-4o-mini:tier"] },
    ]);
    expect(mockPutTools).not.toHaveBeenCalled();
  });

  it("forwards the tools half to the AgentOS tools PUT", async () => {
    const res = await put({ tools: [{ slug: "tavily", enabled: true }] });
    expect(res.status).toBe(200);
    expect(mockPutTools).toHaveBeenCalledWith([{ slug: "tavily", enabled: true }]);
    expect(mockPutModels).not.toHaveBeenCalled();
  });

  it("applies both halves in one request", async () => {
    const res = await put({
      providers: [{ slug: "openai", enabled: false, models: [] }],
      tools: [{ slug: "tavily", enabled: true }],
    });
    expect(res.status).toBe(200);
    expect(mockPutModels).toHaveBeenCalledTimes(1);
    expect(mockPutTools).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty update (400)", async () => {
    const res = await put({});
    expect(res.status).toBe(400);
    expect(mockPutModels).not.toHaveBeenCalled();
    expect(mockPutTools).not.toHaveBeenCalled();
  });

  it("rejects a malformed body (400)", async () => {
    const res = await put({ providers: [{ slug: "openai" }] }); // missing enabled/models
    expect(res.status).toBe(400);
  });

  it("passes the AgentOS 400 through verbatim (the platform owns entry validation)", async () => {
    mockPutModels.mockRejectedValue(
      new AgentosError(400, "'gpt-4o-mini': unknown attribute 'max_tokes'"),
    );
    const res = await put({
      providers: [{ slug: "openai", enabled: true, models: ["gpt-4o-mini:max_tokes=5"] }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("max_tokes");
  });

  it("returns 401 without a user and 403 for a non-platform-admin", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    expect((await put({ tools: [{ slug: "tavily", enabled: true }] })).status).toBe(401);
    mockGetCurrentUser.mockImplementation(async () => user("org-admin", "owner"));
    expect((await put({ tools: [{ slug: "tavily", enabled: true }] })).status).toBe(403);
    expect(mockPutModels).not.toHaveBeenCalled();
    expect(mockPutTools).not.toHaveBeenCalled();
  });

  it("enforces the agentMutate rate limit", async () => {
    const { checkUserLimit } = await import("@/lib/ratelimit/middleware");
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await put({ tools: [{ slug: "tavily", enabled: true }] });
    expect(res.status).toBe(429);
  });
});

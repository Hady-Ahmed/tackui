import { describe, it, expect, beforeEach, vi } from "vitest";

// AGENTOS env must be set before lib/config/agentos is imported (module
// constants are captured at boot). vi.hoisted runs before static imports.
vi.hoisted(() => {
  process.env.AGENTOS_BASE_URL = "http://agentos.test";
  process.env.AGENTOS_JWT_SECRET = "b".repeat(64);
});

// Disabled-state toggle for the 503 test (the route's builderEndpoint
// guard is what turns a half-configured deployment into a hard 503).
const agentosState = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/config/agentos", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/config/agentos")>();
  return {
    ...actual,
    builderEndpoint: (remoteAgentId: string) =>
      agentosState.enabled ? actual.builderEndpoint(remoteAgentId) : null,
  };
});

// Mock the rate limiter + plan cap — "always allow". Both are tested in
// their own suites.
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/plans/enforcement", () => ({
  checkAgentCountLimit: vi.fn().mockResolvedValue(null),
}));

// Mock only the AgentOS HTTP calls; keep the real schemas, config/requirement
// builders, resolver, and error classes so the route's trust posture
// (re-derive everything server-side) is what's actually under test.
const mockFetchModels = vi.fn();
const mockFetchTools = vi.fn();
const mockCreateComponent = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    fetchAgentosModels: (...a: unknown[]) => mockFetchModels(...a),
    fetchBuilderTools: (...a: unknown[]) => mockFetchTools(...a),
    createAgentosComponent: (...a: unknown[]) => mockCreateComponent(...a),
  };
});

// Partial auth mock: getCurrentUser is controllable (401 test), while
// getSyntheticAdmin stays real (solo-mode test user).
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/context")>();
  return {
    ...actual,
    getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
  };
});

import { POST } from "./route";
import { AgentosError } from "@/lib/agents/builder";
import {
  listAgents,
  deleteAgent,
  getAgent,
} from "@/lib/agents/agent-store";
import { getSyntheticAdmin } from "@/lib/auth/context";
import { runMigrations } from "@/lib/db/migrate";
import { checkAgentCountLimit } from "@/lib/plans/enforcement";
import { NextResponse } from "next/server";

const MODELS = [
  { provider: "openai", id: "gpt-4o-mini", platform_tier: true, requires_key: true },
  { provider: "openai", id: "gpt-5", platform_tier: false, requires_key: true },
];
const TOOLS = [
  {
    name: "web_search",
    label: "Web search (DuckDuckGo)",
    description: "Search the web",
    requires_key: null,
    fallback_env: null,
    platform_fallback: false,
    toolkit: "duckduckgo",
    credentials: [],
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
  {
    name: "tavily_search",
    label: "Web search (Tavily)",
    description: "Search the web with Tavily",
    requires_key: "tavily_api_key",
    fallback_env: "TAVILY_API_KEY",
    platform_fallback: true,
    toolkit: "tavily",
    credentials: [{ dep_key: "tavily_api_key", label: "Tavily api key" }],
  },
];

const validBody = {
  name: "Helper",
  description: "A helper agent",
  instructions: "Be helpful.",
  model: { provider: "openai", id: "gpt-4o-mini" },
  tools: [{ name: "web_search" }],
  connectors: [],
};

let testOrg: string;
let authorId: string;

async function cleanup() {
  for (const a of await listAgents(testOrg, { bypassOrgScope: true })) {
    await deleteAgent(a.id, testOrg, { bypassOrgScope: true });
  }
}

beforeEach(async () => {
  await runMigrations();
  const synthetic = await getSyntheticAdmin();
  testOrg = synthetic.orgId;
  authorId = synthetic.id;
  mockGetCurrentUser.mockImplementation(async () => synthetic);
  await cleanup();
  agentosState.enabled = true;
  mockFetchModels.mockResolvedValue(MODELS);
  mockFetchTools.mockResolvedValue(TOOLS);
  mockCreateComponent.mockResolvedValue({
    component_id: "comp-1",
    component_type: "agent",
    current_version: 1,
    deleted_at: null,
  });
  vi.mocked(checkAgentCountLimit).mockResolvedValue(null);
});

function post(body: unknown) {
  return new Request("http://localhost/api/agents/builder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agents/builder", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    const res = await POST(post(validBody));
    expect(res.status).toBe(401);
    expect(mockFetchModels).not.toHaveBeenCalled();
    expect(mockCreateComponent).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents/builder", {
        method: "POST",
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("returns 400 with details on schema failure", async () => {
    const res = await POST(post({ ...validBody, name: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details).toBeTruthy();
  });

  it("returns 400 for a model outside the platform catalog", async () => {
    const res = await POST(
      post({ ...validBody, model: { provider: "openai", id: "gpt-nope" } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("gpt-nope");
  });

  it("returns 400 for a tool outside the builder palette", async () => {
    const res = await POST(
      post({ ...validBody, tools: [{ name: "shell_exec" }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("shell_exec");
  });

  it("returns 400 for an unknown connector", async () => {
    const res = await POST(post({ ...validBody, connectors: ["not-a-connector"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not-a-connector");
  });

  it("returns 402 when the org agent cap is reached", async () => {
    vi.mocked(checkAgentCountLimit).mockResolvedValue(
      NextResponse.json({ error: "Agent cap reached" }, { status: 402 }),
    );
    const res = await POST(post(validBody));
    expect(res.status).toBe(402);
    expect(mockCreateComponent).not.toHaveBeenCalled();
  });

  it("maps AgentOS catalog failures to their status", async () => {
    mockFetchModels.mockRejectedValue(new AgentosError(503, "AgentOS offline"));
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("AgentOS offline");
    expect(mockCreateComponent).not.toHaveBeenCalled();
  });

  it("maps unexpected AgentOS failures to 502", async () => {
    mockFetchTools.mockRejectedValue(new Error("network down"));
    const res = await POST(post(validBody));
    expect(res.status).toBe(502);
    expect(mockCreateComponent).not.toHaveBeenCalled();
  });

  it("creates the local row + AgentOS component and returns 201", async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();

    // Public shape: secrets stripped, provenance preserved, platform
    // infrastructure (endpoint) hidden for builder agents.
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("Helper");
    expect(body.origin).toBe("builder");
    expect(body.authorUserId).toBe(authorId);
    expect(body.authMode).toBe("jwt");
    expect(body.hasJwtSecret).toBe(false);
    expect(body.endpoint).toBeUndefined();
    expect(body.remoteAgentId).toBeUndefined();
    expect(body.requirements).toEqual({
      // requiresKey round-trips from the catalog's requires_key — this
      // assertion is load-bearing: a zod schema that strips the field
      // (the undeclared-key default) would satisfy this toEqual and hide
      // the strip from every downstream reader.
      model: { provider: "openai", id: "gpt-4o-mini", platformTier: true, requiresKey: true },
      tools: [
        {
          name: "web_search",
          label: "Web search (DuckDuckGo)",
          requiresKey: null,
          // The toolkit slug is the provider identity — present even for
          // keyless tools (multi-credential toolkits need it later).
          provider: "duckduckgo",
          platformFallback: false,
          credentials: [],
        },
      ],
      connectors: [],
    });

    // The AgentOS component carries the server-derived config (spike
    // contract shape) with the local id as component_id.
    expect(mockCreateComponent).toHaveBeenCalledWith(
      expect.objectContaining({
        componentId: expect.any(String),
        name: "Helper",
        description: "A helper agent",
        config: expect.objectContaining({
          id: expect.any(String),
          model: { id: "gpt-4o-mini" },
          instructions: ["Be helpful."],
          tools: [
            {
              name: "web_search",
              parameters: TOOLS[0].parameters,
            },
          ],
        }),
      }),
    );

    // The row is persisted and resolvable in the org.
    const stored = await getAgent(body.id, testOrg);
    expect(stored).not.toBeNull();
    expect(stored!.origin).toBe("builder");
    expect(stored!.authorUserId).toBe(authorId);
    expect(stored!.remoteAgentId).toBeTruthy();
  });

  it("compensates the local delete when the AgentOS create fails", async () => {
    mockCreateComponent.mockRejectedValue(new AgentosError(503, "AgentOS offline"));
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
    const remaining = await listAgents(testOrg, { bypassOrgScope: true });
    expect(remaining).toHaveLength(0);
  });

  it("returns 503 when the builder endpoint is not configured", async () => {
    agentosState.enabled = false;
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("not enabled");
    const remaining = await listAgents(testOrg, { bypassOrgScope: true });
    expect(remaining).toHaveLength(0);
  });
});

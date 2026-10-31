import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the stores the run gate reads so the gate logic is tested in
// isolation (the stores have their own suites).
const mockGetAgent = vi.fn();
vi.mock("@/lib/agents/agent-store", () => ({
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
}));

const mockGetCredentialSecrets = vi.fn();
vi.mock("@/lib/credentials/credential-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/credentials/credential-store")>();
  return {
    ...actual,
    getCredentialSecrets: (...a: unknown[]) =>
      mockGetCredentialSecrets(...a),
  };
});

const mockGetConnectorsByNames = vi.fn();
vi.mock("@/lib/connectors/connector-store", () => ({
  getConnectorsByNames: (...a: unknown[]) => mockGetConnectorsByNames(...a),
}));

const mockConsumeQuota = vi.fn();
vi.mock("@/lib/ratelimit/platform-quota", () => ({
  consumePlatformKeyQuota: (...a: unknown[]) => mockConsumeQuota(...a),
}));

const mockGetEnforcementLimits = vi.fn();
vi.mock("@/lib/plans/enforcement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plans/enforcement")>();
  return {
    ...actual,
    getEnforcementLimits: (...a: unknown[]) =>
      mockGetEnforcementLimits(...a),
  };
});

import type { AgentEntry } from "./agents.config";
import type { Connector } from "@/lib/connectors/connector-store";

// Imported at the top so the mock wiring applies; individual tests
// re-import under the right env via loadSaaS()/plain dynamic import.
void import("./run-gate");

function connectorFixture(name: string, token = ""): Connector {
  return {
    id: `conn-${name}`,
    orgId: "org-1",
    name,
    url: `https://mcp.example.com/${name}`,
    token,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function builderAgent(
  requirements: AgentEntry["requirements"],
): AgentEntry {
  return {
    id: "agent-1",
    name: "Builder agent",
    description: "",
    endpoint: "",
    orgId: "org-1",
    authMode: "jwt",
    origin: "builder",
    authorUserId: "user-1",
    remoteAgentId: "remote-1",
    requirements,
  };
}

const miniRequirements: NonNullable<AgentEntry["requirements"]> = {
  model: { provider: "openai", id: "gpt-4o-mini", platformTier: true },
  tools: [],
  connectors: [],
};

async function loadGate() {
  delete process.env.SAAS_MODE;
  vi.resetModules();
  return await import("./run-gate");
}

async function loadSaaSGate() {
  process.env.SAAS_MODE = "true";
  vi.resetModules();
  return await import("./run-gate");
}

describe("lib/agents/run-gate", () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
    mockGetCredentialSecrets.mockReset();
    mockGetConnectorsByNames.mockReset();
    mockConsumeQuota.mockReset();
    mockGetEnforcementLimits.mockReset();
    mockConsumeQuota.mockReturnValue({
      allowed: true,
      resetAt: Date.now() + 1000,
      used: 1,
    });
    mockGetEnforcementLimits.mockResolvedValue({
      plan: "free",
      limits: {
        maxAgents: 3,
        concurrentRuns: 1,
        runsPerMinute: 10,
        platformDailyQuota: 50,
        maxMembers: 1,
        canCreateOrg: false,
        label: "Free",
      },
    });
    // The runner's credentials: provider → named field map (migration 0014;
    // single-key providers carry exactly one "api_key" field).
    mockGetCredentialSecrets.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.SAAS_MODE;
    vi.resetModules();
  });

  it("returns the empty resolution for a non-builder agent", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", origin: "manual" });
    const { checkBuilderRunGate } = await loadGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.contextItems).toEqual([]);
    expect(result.platformKeyRun).toBe(false);
    expect(mockGetCredentialSecrets).not.toHaveBeenCalled();
  });

  it("returns the empty resolution when the agent does not exist", async () => {
    mockGetAgent.mockResolvedValue(null);
    const { checkBuilderRunGate } = await loadGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.contextItems).toEqual([]);
  });

  it("TIER DORMANCY: a platform-tier model without a runner key 402s (the platform key serves nothing until Phase 3)", async () => {
    mockGetAgent.mockResolvedValue(builderAgent(miniRequirements));
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.error).toContain("gpt-4o-mini");
    // The dormant flag never flips — the quota phase no-ops.
    expect(result.platformKeyRun).toBe(false);
    expect(mockConsumeQuota).not.toHaveBeenCalled();
  });

  it("TIER DORMANCY: a platform-tier model WITH a runner key runs BYOK", async () => {
    mockGetAgent.mockResolvedValue(builderAgent(miniRequirements));
    mockGetCredentialSecrets.mockResolvedValue({ openai: { api_key: "sk-runner" } });
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.platformKeyRun).toBe(false);
    expect(result.contextItems).toEqual([
      { description: "openai_api_key", value: "sk-runner" },
    ]);
  });

  it("402s a model when the runner has no key for its provider", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        model: { provider: "openai", id: "gpt-5", platformTier: false },
        tools: [],
        connectors: [],
      }),
    );
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.code).toBe("AGENT_REQUIREMENTS_MISSING");
    expect(body.error).toContain("gpt-5");
    expect(result.contextItems).toEqual([]);
    expect(mockConsumeQuota).not.toHaveBeenCalled();
  });

  it("injects the runner's model key from its field map", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        model: { provider: "openai", id: "gpt-5", platformTier: false },
        tools: [],
        connectors: [],
      }),
    );
    mockGetCredentialSecrets.mockResolvedValue({ openai: { api_key: "sk-runner" } });
    const { checkBuilderRunGate } = await loadGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.contextItems).toEqual([
      { description: "openai_api_key", value: "sk-runner" },
    ]);
  });

  it("injects a BYOK tool key from the legacy single-dep snapshot (pre-multi-credential shape)", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        model: { provider: "openai", id: "gpt-5", platformTier: false },
        tools: [
          {
            name: "tavily_search",
            label: "Web search (Tavily)",
            requiresKey: "tavily_api_key",
            provider: "tavily",
            platformFallback: false,
          },
        ],
        connectors: [],
      }),
    );
    mockGetCredentialSecrets.mockResolvedValue({
      openai: { api_key: "sk-runner" },
      // Migration 0014 backfills single-key providers to {api_key: ...}.
      tavily: { api_key: "tvly-runner" },
    });
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.platformKeyRun).toBe(false);
    expect(mockConsumeQuota).not.toHaveBeenCalled();
    expect(result.contextItems).toEqual([
      { description: "openai_api_key", value: "sk-runner" },
      { description: "tavily_api_key", value: "tvly-runner" },
    ]);
  });

  it("delivers EVERY dep of a multi-credential toolkit's contract when all fields are saved", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        model: { provider: "openai", id: "gpt-5", platformTier: false },
        tools: [
          {
            name: "search_x",
            label: "Search X posts",
            requiresKey: "x_consumer_key",
            provider: "x",
            platformFallback: false,
            credentials: [
              { depKey: "x_consumer_key", label: "X consumer key" },
              { depKey: "x_consumer_secret", label: "X consumer secret" },
              { depKey: "x_access_token", label: "X access token" },
              { depKey: "x_access_token_secret", label: "X access token secret" },
            ],
          },
        ],
        connectors: [],
      }),
    );
    mockGetCredentialSecrets.mockResolvedValue({
      openai: { api_key: "sk-runner" },
      x: {
        consumer_key: "ck",
        consumer_secret: "cs",
        access_token: "at",
        access_token_secret: "ats",
      },
    });
    const { checkBuilderRunGate } = await loadGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.contextItems).toEqual([
      { description: "openai_api_key", value: "sk-runner" },
      { description: "x_consumer_key", value: "ck" },
      { description: "x_consumer_secret", value: "cs" },
      { description: "x_access_token", value: "at" },
      { description: "x_access_token_secret", value: "ats" },
    ]);
    // The gate's reserved set is exactly what it delivered (plus the
    // mcp_connectors namespace, reserved regardless of connectors here) —
    // the registry strips client context against this set, so it must
    // include every multi-field contract dep (not just `_api_key`).
    expect([...result.reservedDepKeys].sort()).toEqual(
      [
        "mcp_connectors",
        "openai_api_key",
        "x_consumer_key",
        "x_consumer_secret",
        "x_access_token",
        "x_access_token_secret",
      ].sort(),
    );
  });

  it("402s a multi-credential toolkit when ANY field of the contract is missing (all-or-nothing)", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        model: { provider: "openai", id: "gpt-5", platformTier: false },
        tools: [
          {
            name: "search_x",
            label: "Search X posts",
            requiresKey: "x_consumer_key",
            provider: "x",
            platformFallback: false,
            credentials: [
              { depKey: "x_consumer_key", label: "X consumer key" },
              { depKey: "x_access_token", label: "X access token" },
            ],
          },
        ],
        connectors: [],
      }),
    );
    mockGetCredentialSecrets.mockResolvedValue({
      openai: { api_key: "sk-runner" },
      x: { consumer_key: "ck" }, // access_token missing
    });
    const { checkBuilderRunGate } = await loadGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.error).toContain("Search X posts");
    // Multi-field contract → the plural copy.
    expect(body.error).toContain("X credentials");
    // A partial contract must not partially deliver.
    expect(result.contextItems).toEqual([]);
  });

  it("TIER DORMANCY: a platformFallback tool without a runner key 402s (the fallback is dormant until Phase 3)", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        ...miniRequirements,
        tools: [
          {
            name: "tavily_search",
            label: "Web search (Tavily)",
            requiresKey: "tavily_api_key",
            provider: "tavily",
            platformFallback: true,
          },
        ],
      }),
    );
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.error).toContain("Tavily");
    expect(result.platformKeyRun).toBe(false);
  });

  it("402s a keyed tool with no platform fallback when the runner lacks the key", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        ...miniRequirements,
        // A stale snapshot: the tool is no longer in the builder palette
        // (or never was) — fail closed rather than silently degrade.
        tools: [{ name: "unknown_tool", requiresKey: "tavily_api_key", platformFallback: false }],
      }),
    );
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.error).toContain("unknown_tool");
    expect(mockConsumeQuota).not.toHaveBeenCalled();
  });

  it("402s a required connector the org has not configured", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({ ...miniRequirements, connectors: ["github"] }),
    );
    mockGetConnectorsByNames.mockResolvedValue(new Map());
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.error).toContain("github");
    expect(mockConsumeQuota).not.toHaveBeenCalled();
  });

  it("injects configured connectors as the mcp_connectors JSON dep", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({ ...miniRequirements, connectors: ["github"] }),
    );
    mockGetConnectorsByNames.mockResolvedValue(
      new Map([["github", connectorFixture("github", "tok-123")]]),
    );
    mockGetCredentialSecrets.mockResolvedValue({ openai: { api_key: "sk-runner" } });
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    const items = result.contextItems;
    expect(items).toHaveLength(2);
    const item = items.find((i) => i.description === "mcp_connectors")!;
    expect(JSON.parse(item.value)).toEqual({
      github: {
        url: "https://mcp.example.com/github",
        token: "tok-123",
      },
    });
    expect(result.reservedDepKeys).toContain("mcp_connectors");
    expect(mockGetConnectorsByNames).toHaveBeenCalledWith("org-1", ["github"]);
  });

  it("consumeBuilderRunQuota consumes the platform-key quota (SaaS) — the wiring stays for Phase 3", async () => {
    const { consumeBuilderRunQuota } = await loadSaaSGate();
    const user = { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" };
    const res = await consumeBuilderRunQuota(user, true);
    expect(res).toBeNull();
    expect(mockConsumeQuota).toHaveBeenCalledWith("user-1", 50);
    expect(mockGetEnforcementLimits).toHaveBeenCalledWith("org-1");
  });

  it("402s when the platform-key quota is exhausted", async () => {
    mockConsumeQuota.mockReturnValue({
      allowed: false,
      resetAt: Date.now() + 3_600_000,
      used: 50,
    });
    const { consumeBuilderRunQuota } = await loadSaaSGate();
    const result = await consumeBuilderRunQuota(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      true,
    );
    expect(result?.status).toBe(402);
    const body = await result!.json();
    expect(body.code).toBe("PLATFORM_QUOTA_EXCEEDED");
    expect(body.resetsAt).toBeGreaterThan(Date.now());
    expect(body.error).toContain("daily limit");
    // Free-plan upsell clause, never a run number or "unlimited" promise.
    expect(body.error).toContain("Upgrade to Pro");
  });

  it("consumeBuilderRunQuota is a no-op for BYOK runs and on self-host", async () => {
    const user = { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" };
    const saas = await loadSaaSGate();
    // BYOK run — exempt.
    expect(await saas.consumeBuilderRunQuota(user, false)).toBeNull();
    // Self-host — the operator pays the platform bill themselves.
    const selfHost = await loadGate();
    expect(await selfHost.consumeBuilderRunQuota(user, true)).toBeNull();
    expect(mockConsumeQuota).not.toHaveBeenCalled();
  });

  it("still blocks a missing connector on self-host (no fallback exists)", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({ ...miniRequirements, connectors: ["github"] }),
    );
    mockGetConnectorsByNames.mockResolvedValue(new Map());
    mockGetCredentialSecrets.mockResolvedValue({ openai: { api_key: "sk-selfhost" } });
    const { checkBuilderRunGate } = await loadGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.error).toContain("github");
  });

  it("aggregates every blocker into one 402", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({
        model: { provider: "openai", id: "gpt-5", platformTier: false },
        tools: [{ name: "unknown_tool", requiresKey: "tavily_api_key", platformFallback: false }],
        connectors: ["github", "linear"],
      }),
    );
    mockGetConnectorsByNames.mockResolvedValue(new Map());
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.error).toContain("gpt-5");
    expect(body.error).toContain("unknown_tool");
    expect(body.error).toContain("github");
    expect(body.error).toContain("linear");
    // One combined message, one code.
    expect(body.code).toBe("AGENT_REQUIREMENTS_MISSING");
  });
});

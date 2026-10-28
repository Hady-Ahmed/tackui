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

  it("flags a platform-tier run for quota but consumes nothing in the gate phase (SaaS)", async () => {
    mockGetAgent.mockResolvedValue(builderAgent(miniRequirements));
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.contextItems).toEqual([]);
    expect(result.platformKeyRun).toBe(true);
    // Quota phase is separate: the gate (which runs before the concurrent
    // slot) must never consume — a 429 at the cap would otherwise burn a
    // daily platform-key run.
    expect(mockConsumeQuota).not.toHaveBeenCalled();
    expect(mockGetEnforcementLimits).not.toHaveBeenCalled();
  });

  it("consumeBuilderRunQuota consumes the platform-key quota (SaaS)", async () => {
    const { consumeBuilderRunQuota } = await loadSaaSGate();
    const user = { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" };
    const res = await consumeBuilderRunQuota(user, true);
    expect(res).toBeNull();
    expect(mockConsumeQuota).toHaveBeenCalledWith("user-1", 50);
    expect(mockGetEnforcementLimits).toHaveBeenCalledWith("org-1");
  });

  it("exempts a BYOK platform-tier run from quota and injects the key", async () => {
    mockGetAgent.mockResolvedValue(builderAgent(miniRequirements));
    mockGetCredentialSecrets.mockResolvedValue({ openai: "sk-runner" });
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
    ]);
  });

  it("402s a non-platform-tier model when the runner has no provider key", async () => {
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
    expect(result.response).not.toBeNull();
    expect(result.response?.status).toBe(402);
    const body = await result.response!.json();
    expect(body.code).toBe("AGENT_REQUIREMENTS_MISSING");
    expect(body.error).toContain("gpt-5");
    expect(result.contextItems).toEqual([]);
    expect(mockConsumeQuota).not.toHaveBeenCalled();
  });

  it("injects a BYOK tool key and skips the platform fallback", async () => {
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
      openai: "sk-runner",
      tavily: "tvly-runner",
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

  it("falls back to the platform key (quota) when a tool key is missing", async () => {
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
    expect(result.response).toBeNull();
    expect(result.contextItems).toEqual([]);
    expect(result.platformKeyRun).toBe(true);
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
    const { checkBuilderRunGate } = await loadSaaSGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    expect(result.contextItems).toHaveLength(1);
    const item = result.contextItems[0];
    expect(item.description).toBe("mcp_connectors");
    expect(JSON.parse(item.value)).toEqual({
      github: {
        url: "https://mcp.example.com/github",
        token: "tok-123",
      },
    });
    expect(mockGetConnectorsByNames).toHaveBeenCalledWith("org-1", ["github"]);
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

  it("skips quota entirely on self-host but still resolves BYOK deps", async () => {
    mockGetAgent.mockResolvedValue(builderAgent(miniRequirements));
    mockGetCredentialSecrets.mockResolvedValue({ openai: "sk-selfhost" });
    const { checkBuilderRunGate } = await loadGate();
    const result = await checkBuilderRunGate(
      { id: "user-1", role: "member", name: "u", email: null, orgId: "org-1" },
      "agent-1",
    );
    expect(result.response).toBeNull();
    // The runner's own key satisfies the model dep — a BYOK run, so the
    // platform-key flag stays off and self-host consumes nothing.
    expect(result.platformKeyRun).toBe(false);
    expect(mockConsumeQuota).not.toHaveBeenCalled();
    expect(result.contextItems).toEqual([
      { description: "openai_api_key", value: "sk-selfhost" },
    ]);
  });

  it("still blocks a missing connector on self-host (no fallback exists)", async () => {
    mockGetAgent.mockResolvedValue(
      builderAgent({ ...miniRequirements, connectors: ["github"] }),
    );
    mockGetConnectorsByNames.mockResolvedValue(new Map());
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

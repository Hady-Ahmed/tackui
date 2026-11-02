import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

// AGENTOS env must be set before lib/config/agentos is imported.
vi.hoisted(() => {
  process.env.AGENTOS_BASE_URL = "http://agentos.test";
  process.env.AGENTOS_JWT_SECRET = "b".repeat(64);
});

// Partial auth mock: getCurrentUser controllable (401 test), getSyntheticAdmin real.
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) };
});

// Rate limiter always allows.
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock every AgentOS round trip in the builder service; the pure helpers
// (schemas, buildComponentConfig, buildRequirements, resolveBuilderModel)
// and the error classes stay real via importOriginal.
const mockGetComponent = vi.fn();
const mockGetCurrentConfig = vi.fn();
const mockUpdateMeta = vi.fn();
const mockUpdateConfig = vi.fn();
const mockDeleteComponent = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchToolFns = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    getAgentosComponent: (...a: unknown[]) => mockGetComponent(...a),
    getAgentosCurrentConfig: (...a: unknown[]) => mockGetCurrentConfig(...a),
    updateAgentosComponentMeta: (...a: unknown[]) => mockUpdateMeta(...a),
    updateAgentosConfig: (...a: unknown[]) => mockUpdateConfig(...a),
    deleteAgentosComponent: (...a: unknown[]) => mockDeleteComponent(...a),
    fetchAgentosModels: (...a: unknown[]) => mockFetchModels(...a),
    fetchBuilderTools: (...a: unknown[]) => mockFetchToolFns(...a),
  };
});

// The belt-and-braces connector-registry upserts are platform round trips;
// stubbed here (the name→id mapping is asserted directly below).
const mockEnsureConnectors = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/connectors/platform-sync", () => ({
  ensurePlatformConnectors: (...a: unknown[]) => mockEnsureConnectors(...a),
}));

import { PATCH, DELETE } from "./route";
import { AgentosError } from "@/lib/agents/builder";
import {
  createAgent,
  getAgent,
  listAgents,
  deleteAgent,
} from "@/lib/agents/agent-store";
import { upsertConnector } from "@/lib/connectors/connector-store";
import type { AgentEntry } from "@/lib/agents/agents.config";
import { getSyntheticAdmin } from "@/lib/auth/context";
import { runMigrations } from "@/lib/db/migrate";

const MODELS = [
  { provider: "openai", id: "gpt-4o-mini", platform_tier: true, requires_key: true, dep_key: "openai_api_key", name: "OpenAIChat" },
];

let testOrg: string;
let authorId: string;
let agent: AgentEntry;

function componentFixture(currentVersion = 3) {
  return {
    id: "comp-1",
    component_id: "comp-1",
    component_type: "agent",
    name: "Fixture",
    current_version: currentVersion,
    deleted_at: null,
  };
}

async function createFixture(
  overrides: Partial<Parameters<typeof createAgent>[0]> = {},
) {
  return createAgent(
    {
      name: "Fixture",
      description: "A fixture agent",
      endpoint: "http://agentos.test/agui/comp-1",
      authMode: "jwt",
      jwtSecret: "s".repeat(48),
      jwtScopes: ["app:user"],
      origin: "builder",
      authorUserId: authorId,
      remoteAgentId: "comp-1",
      requirements: {
        model: { provider: "openai", id: "gpt-4o-mini", platformTier: true, depKey: "openai_api_key", name: "OpenAIChat" },
        tools: [],
        connectors: [],
      },
      ...overrides,
    },
    testOrg,
  );
}

async function patchAgent(agentId: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/agents/builder/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: agentId }) },
  );
}

async function deleteAgentById(agentId: string) {
  return DELETE(new Request(`http://localhost/api/agents/builder/${agentId}`, {
    method: "DELETE",
  }), { params: Promise.resolve({ id: agentId }) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations();
  const synthetic = await getSyntheticAdmin();
  testOrg = synthetic.orgId;
  authorId = synthetic.id;
  mockGetCurrentUser.mockImplementation(async () => synthetic);
  mockGetComponent.mockResolvedValue(componentFixture());
  mockGetCurrentConfig.mockResolvedValue({ instructions: ["base prompt"] });
  mockUpdateMeta.mockResolvedValue(undefined);
  mockUpdateConfig.mockResolvedValue(undefined);
  mockDeleteComponent.mockResolvedValue(undefined);
  mockFetchModels.mockResolvedValue(MODELS);
  mockFetchToolFns.mockResolvedValue([]);
  for (const a of await listAgents(testOrg, { bypassOrgScope: true })) {
    await deleteAgent(a.id, testOrg, { bypassOrgScope: true });
  }
  agent = await createFixture();
});

afterEach(async () => {
  for (const a of await listAgents(testOrg, { bypassOrgScope: true })) {
    await deleteAgent(a.id, testOrg, { bypassOrgScope: true });
  }
});

describe("PATCH /api/agents/builder/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await patchAgent(agent.id, { name: "Renamed" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await patchAgent("nope", { name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-builder agent", async () => {
    const manual = await createFixture({
      name: "Manual",
      origin: "manual",
      remoteAgentId: undefined,
      endpoint: "http://backend.example.com",
      jwtSecret: undefined,
      authMode: "none",
    });
    const res = await patchAgent(manual.id, { name: "Renamed" });
    expect(res.status).toBe(404);
    expect(mockGetComponent).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-author", async () => {
    const notMine = await createFixture({ authorUserId: "someone-else" });
    const res = await patchAgent(notMine.id, { name: "Renamed" });
    expect(res.status).toBe(403);
  });

  it("returns 400 for an empty patch (refine)", async () => {
    const res = await patchAgent(agent.id, {});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the AgentOS component is deleted", async () => {
    mockGetComponent.mockResolvedValue({ ...componentFixture(), deleted_at: 123 });
    const res = await patchAgent(agent.id, { name: "Renamed" });
    expect(res.status).toBe(404);
    expect(mockUpdateMeta).not.toHaveBeenCalled();
  });

  it("updates metadata and publishes to the AgentOS with the current version", async () => {
    const res = await patchAgent(agent.id, { name: "Renamed", description: "New desc" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Renamed");
    expect(body.description).toBe("New desc");
    expect(mockUpdateMeta).toHaveBeenCalledWith(
      "comp-1",
      { name: "Renamed", description: "New desc" },
      3,
    );
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.name).toBe("Renamed");
  });

  it("publishes new instructions as a config version", async () => {
    const res = await patchAgent(agent.id, { instructions: "New prompt" });
    expect(res.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const [compId, config, version] = mockUpdateConfig.mock.calls[0] as [
      string,
      Record<string, unknown>,
      number,
    ];
    expect(compId).toBe("comp-1");
    expect(config.instructions).toEqual(["New prompt"]);
    expect(version).toBe(3);
    expect(mockUpdateMeta).not.toHaveBeenCalled();
  });

  it("409s when instructions are not patched and the current config has none", async () => {
    mockGetCurrentConfig.mockResolvedValue({ instructions: [] });
    const res = await patchAgent(agent.id, { tools: [] });
    expect(res.status).toBe(409);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("re-derives requirements from the catalog on a model change", async () => {
    mockFetchModels.mockResolvedValue([
      { provider: "openai", id: "gpt-4o-mini", platform_tier: true, requires_key: true, dep_key: "openai_api_key", name: "OpenAIChat" },
    ]);
    const res = await patchAgent(agent.id, {
      model: { provider: "openai", id: "gpt-4o-mini" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requirements.model.id).toBe("gpt-4o-mini");
    expect(body.requirements.model.platformTier).toBe(true);
  });

  it("returns 400 for an unknown model", async () => {
    const res = await patchAgent(agent.id, {
      model: { provider: "openai", id: "gpt-nope" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown connector", async () => {
    const res = await patchAgent(agent.id, { connectors: ["ghost"] });
    expect(res.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("publishes config connectors as IDS (registry keys), keeps NAMES in the snapshot", async () => {
    // Seed a real org connector; the patch references it by NAME (the
    // member-facing form), but the published config must carry its ID —
    // the platform connector registry's key namespace (names collide
    // across orgs; ids don't).
    const row = await upsertConnector({
      orgId: testOrg,
      name: "github",
      url: "https://mcp.example.com/gh",
    });
    const res = await patchAgent(agent.id, { connectors: ["github"] });
    expect(res.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const config = mockUpdateConfig.mock.calls[0][1] as Record<string, unknown>;
    expect(config.connectors).toEqual([row.id]);
    // The local requirements snapshot keeps the org-facing name.
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.requirements?.connectors).toEqual(["github"]);
    // Belt-and-braces: the effective connector set is re-registered
    // (idempotent) at publish time.
    expect(mockEnsureConnectors).toHaveBeenCalledWith([
      { id: row.id, url: row.url, name: "github" },
    ]);
  });

  it("reverts the local row when the AgentOS publish fails", async () => {
    mockUpdateMeta.mockRejectedValue(new AgentosError(503, "agentos down"));
    const res = await patchAgent(agent.id, { name: "Renamed" });
    expect(res.status).toBe(503);
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.name).toBe("Fixture");
  });

  it("reverts the local row AND 409s when the AgentOS publish hits a concurrent-edit guard", async () => {
    // A 409 means another edit landed first — the AgentOS write was
    // refused, so the local row must be restored to the pre-patch values
    // (the local projection must not lead the AgentOS) and the author is
    // told to reload rather than silently losing their edit.
    mockUpdateMeta.mockRejectedValue(new AgentosError(409, "version conflict"));
    const res = await patchAgent(agent.id, { name: "Renamed" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("just updated by someone else");
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.name).toBe("Fixture");
  });

  it("does not revert fields the patch never touched", async () => {
    // A concurrent edit could land between our read and our revert — the
    // revert must restore only what THIS request wrote.
    mockUpdateMeta.mockRejectedValue(new AgentosError(503, "agentos down"));
    const res = await patchAgent(agent.id, { name: "Renamed" });
    expect(res.status).toBe(503);
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.name).toBe("Fixture"); // reverted
    expect(stored?.description).toBe("A fixture agent"); // untouched by the revert
  });

  describe("snapshot-less builder rows (hand-edited / future-bug guard)", () => {
    let bare: AgentEntry;

    beforeEach(async () => {
      bare = await createFixture({ requirements: undefined });
    });

    it("409s a PARTIAL config patch (unpatched tools/connectors can't be re-derived — defaulting to [] would wipe them)", async () => {
      const res = await patchAgent(bare.id, { model: { provider: "openai", id: "gpt-4o-mini" } });
      expect(res.status).toBe(409);
      expect(mockUpdateMeta).not.toHaveBeenCalled();
      expect(mockUpdateConfig).not.toHaveBeenCalled();
      // Nothing written locally either.
      const stored = await getAgent(bare.id, testOrg);
      expect(stored?.name).toBe("Fixture");
    });

    it("accepts a FULL config patch (model + tools + connectors — everything re-derived from the patch)", async () => {
      const res = await patchAgent(bare.id, {
        model: { provider: "openai", id: "gpt-4o-mini" },
        tools: [],
        connectors: [],
      });
      expect(res.status).toBe(200);
      expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
      const stored = await getAgent(bare.id, testOrg);
      expect(stored?.requirements?.model.id).toBe("gpt-4o-mini");
    });

    it("clears the added snapshot on a failed full config patch (the revert must restore the row to ITS prior state — no snapshot)", async () => {
      mockUpdateConfig.mockRejectedValue(new AgentosError(503, "agentos down"));
      const res = await patchAgent(bare.id, {
        model: { provider: "openai", id: "gpt-4o-mini" },
        tools: [],
        connectors: [],
      });
      expect(res.status).toBe(503);
      const stored = await getAgent(bare.id, testOrg);
      // The local write added a snapshot; the compensating revert removes
      // it again — otherwise the local row would lead the AgentOS with a
      // config the platform never confirmed.
      expect(stored?.requirements).toBeUndefined();
      expect(stored?.name).toBe("Fixture");
    });
  });


  it("maps an AgentOS guard fetch failure to its status", async () => {
    mockGetComponent.mockRejectedValue(new AgentosError(503, "agentos offline"));
    const res = await patchAgent(agent.id, { name: "Renamed" });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/agents/builder/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await deleteAgentById(agent.id);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await deleteAgentById("nope");
    expect(res.status).toBe(404);
    expect(mockDeleteComponent).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-builder agent", async () => {
    const manual = await createFixture({
      name: "Manual",
      origin: "manual",
      remoteAgentId: undefined,
      endpoint: "http://backend.example.com",
      jwtSecret: undefined,
      authMode: "none",
    });
    const res = await deleteAgentById(manual.id);
    expect(res.status).toBe(404);
    expect(mockDeleteComponent).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-author", async () => {
    const notMine = await createFixture({ authorUserId: "someone-else" });
    const res = await deleteAgentById(notMine.id);
    expect(res.status).toBe(403);
  });

  it("soft-deletes the component and removes the local row", async () => {
    const res = await deleteAgentById(agent.id);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mockDeleteComponent).toHaveBeenCalledWith("comp-1");
    expect(await getAgent(agent.id, testOrg)).toBeNull();
  });

  it("still removes the local row when the AgentOS delete fails", async () => {
    mockDeleteComponent.mockRejectedValue(new AgentosError(503, "agentos down"));
    const res = await deleteAgentById(agent.id);
    expect(res.status).toBe(200);
    expect(await getAgent(agent.id, testOrg)).toBeNull();
  });
});

describe("PATCH — component-meta re-revert after a failed config publish", () => {
  it("re-PATCHes component meta back when config fails after a successful meta write", async () => {
    // Meta applied remotely, config publish failed: the local row reverts,
    // but the component would keep the NEW name — and a later edit would
    // clobber it from the stale local name. The compensating meta re-revert
    // must restore the pre-patch name with the post-meta-write CAS version.
    mockUpdateConfig.mockRejectedValue(new AgentosError(503, "agentos down"));
    const res = await patchAgent(agent.id, { name: "Renamed", instructions: "new prompt" });
    expect(res.status).toBe(503);
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.name).toBe("Fixture"); // local row reverted
    expect(mockUpdateMeta).toHaveBeenCalledTimes(2);
    expect(mockUpdateMeta).toHaveBeenLastCalledWith("comp-1", { name: "Fixture" }, 3);
  });

  it("does not re-revert meta when the meta write itself failed", async () => {
    mockUpdateMeta.mockRejectedValue(new AgentosError(503, "agentos down"));
    await patchAgent(agent.id, { name: "Renamed" });
    expect(mockUpdateMeta).toHaveBeenCalledTimes(1);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

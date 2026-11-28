import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

// AGENTOS env must be set before lib/config/agentos is imported.
vi.hoisted(() => {
  process.env.AGENTOS_BASE_URL = "http://agentos.test";
  process.env.AGENTOS_JWT_SECRET = "b".repeat(64);
});

const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) };
});

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

const mockFetchKnowledgeList = vi.fn();
const mockDeleteKnowledgeContent = vi.fn();
const mockGetComponent = vi.fn();
const mockGetCurrentConfig = vi.fn();
const mockUpdateConfig = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchToolFns = vi.fn();
vi.mock("@/lib/agents/builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/builder")>();
  return {
    ...actual,
    fetchKnowledgeList: (...a: unknown[]) => mockFetchKnowledgeList(...a),
    getAgentosComponent: (...a: unknown[]) => mockGetComponent(...a),
    getAgentosCurrentConfig: (...a: unknown[]) => mockGetCurrentConfig(...a),
    updateAgentosConfig: (...a: unknown[]) => mockUpdateConfig(...a),
    deleteKnowledgeContent: (...a: unknown[]) => mockDeleteKnowledgeContent(...a),
    fetchAgentosModels: (...a: unknown[]) => mockFetchModels(...a),
    fetchBuilderTools: (...a: unknown[]) => mockFetchToolFns(...a),
  };
});

import { DELETE } from "./route";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { AgentosError } from "@/lib/agents/builder";
import {
  createAgent,
  getAgent,
  listAgents,
  deleteAgent,
} from "@/lib/agents/agent-store";
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

const KNOWLEDGE_ROWS = [
  { id: "c1", name: "a.pdf", status: "completed", size: 10, createdAt: 1, updatedAt: 2 },
  { id: "c2", name: "b.txt", status: "completed", size: 20, createdAt: 1, updatedAt: 2 },
];

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
        knowledge: { provider: "openai", model: "text-embedding-3-small" },
      },
      ...overrides,
    },
    testOrg,
  );
}

function deleteContent(agentId: string, contentId = "c2") {
  return DELETE(
    new Request(`http://localhost/api/agents/${agentId}/knowledge/${contentId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: agentId, contentId }) },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations();
  const synthetic = await getSyntheticAdmin();
  testOrg = synthetic.orgId;
  authorId = synthetic.id;
  mockGetCurrentUser.mockImplementation(async () => synthetic);
  mockDeleteKnowledgeContent.mockResolvedValue(undefined);
  // The fixture's config starts knowledge-attached (matches the fixture
  // snapshot); the corpus starts with two docs.
  mockFetchKnowledgeList.mockResolvedValue(KNOWLEDGE_ROWS);
  mockGetComponent.mockResolvedValue(componentFixture());
  mockGetCurrentConfig.mockResolvedValue({
    id: "comp-1",
    name: "Fixture",
    model: { id: "gpt-4o-mini", name: "OpenAIChat" },
    instructions: ["base prompt"],
    tools: [],
    knowledge: { name: "kb-comp-1" },
  });
  mockUpdateConfig.mockResolvedValue(undefined);
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

describe("DELETE /api/agents/[id]/knowledge/[contentId]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(401);
  });

  it("rides the knowledgeMutate bucket", async () => {
    await deleteContent(agent.id);
    expect(checkUserLimit).toHaveBeenCalledWith(authorId, "knowledgeMutate");
  });

  it("returns 429 when the rate limit refuses", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(429);
    expect(mockDeleteKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown agent / non-builder agent", async () => {
    expect((await deleteContent("nope")).status).toBe(404);
    const manual = await createFixture({
      name: "Manual",
      origin: "manual",
      remoteAgentId: undefined,
      endpoint: "http://backend.example.com",
      jwtSecret: undefined,
      authMode: "none",
    });
    expect((await deleteContent(manual.id)).status).toBe(404);
    expect(mockDeleteKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-author (and for an admin who is not the author)", async () => {
    const notMine = await createFixture({ authorUserId: "someone-else" });
    expect((await deleteContent(notMine.id)).status).toBe(403);
    mockGetCurrentUser.mockImplementation(async () => ({
      id: "admin-1",
      role: "admin",
      orgId: testOrg,
      name: "Admin",
      email: null,
    }));
    expect((await deleteContent(notMine.id)).status).toBe(403);
    expect(mockDeleteKnowledgeContent).not.toHaveBeenCalled();
  });

  it("deletes the content and answers ok (idempotent service posture)", async () => {
    const res = await deleteContent(agent.id, "c9");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockDeleteKnowledgeContent).toHaveBeenCalledWith({
      componentId: "comp-1",
      contentId: "c9",
    });
    // Docs remain → the config ref stays.
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("maps a service failure to the same status", async () => {
    mockDeleteKnowledgeContent.mockRejectedValue(new AgentosError(502, "unavailable"));
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(502);
    expect(mockFetchKnowledgeList).not.toHaveBeenCalled();
  });

  it("deleting the LAST doc detaches the ref and re-derives the snapshot", async () => {
    // After the delete the corpus is empty → the config publishes WITHOUT
    // the ref and the snapshot loses its knowledge field.
    mockFetchKnowledgeList.mockResolvedValue([]);
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const [compId, config, version] = mockUpdateConfig.mock.calls[0] as [string, Record<string, unknown>, number];
    expect(compId).toBe("comp-1");
    expect(config.knowledge).toBeUndefined();
    expect(config.model).toEqual({ id: "gpt-4o-mini", name: "OpenAIChat" });
    expect(version).toBe(3);
    const stored = await getAgent(agent.id, testOrg);
    expect("knowledge" in (stored?.requirements ?? {})).toBe(false);
    expect(stored?.requirements?.model.id).toBe("gpt-4o-mini");
  });

  it("keeps the ref when a raced concurrent upload's row is already visible", async () => {
    // The corpus list is fetched AFTER the delete, so a doc whose row the
    // list can see keeps the ref. That pins the VISIBLE-row case only —
    // the ref ⇔ docs invariant is best-effort, not airtight: a just-202'd
    // upload inserts its contents row inside agno's background
    // process_content, so until it lands the doc is invisible to this
    // list and an upload+delete interleave can publish a ref-less config
    // while the doc exists (the run degrades to no retrieval — the
    // snapshot's knowledge leaves in the same publish, so the #236 gate
    // doesn't 402 either). It self-heals on the next curation action
    // (the next upload re-attaches); airtight would need row-insertion
    // synchronous with the 202, which is agno's shape, not ours.
    mockFetchKnowledgeList.mockResolvedValue([KNOWLEDGE_ROWS[0]]);
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(200);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("fails the response when the post-delete list fetch fails (the retry re-runs the detach)", async () => {
    mockFetchKnowledgeList.mockRejectedValue(new AgentosError(502, "unavailable"));
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(502);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("surfaces the detach publish's 409 as reload-and-retry", async () => {
    mockFetchKnowledgeList.mockResolvedValue([]);
    mockUpdateConfig.mockRejectedValue(new AgentosError(409, "version conflict"));
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("just updated by someone else");
    // The compensating revert restored the pre-detach snapshot.
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.requirements?.knowledge).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  it("skips the detach entirely when the config no longer references the corpus", async () => {
    mockGetCurrentConfig.mockResolvedValue({
      id: "comp-1",
      name: "Fixture",
      model: { id: "gpt-4o-mini", name: "OpenAIChat" },
      instructions: ["base prompt"],
      tools: [],
    });
    mockFetchKnowledgeList.mockResolvedValue([]);
    const res = await deleteContent(agent.id);
    expect(res.status).toBe(200);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

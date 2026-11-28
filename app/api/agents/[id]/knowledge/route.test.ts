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

// Rate limiter always allows (the bucket-name test flips this).
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// The SSRF guard is mocked at the boundary; the rejection test makes it
// throw the mocked module's own UnsafeUrlError (the route's instanceof).
const mockAssertSafeUrl = vi.fn();
vi.mock("@/lib/net/safe-fetch", () => ({
  assertSafeUrl: (...a: unknown[]) => mockAssertSafeUrl(...a),
  UnsafeUrlError: class UnsafeUrlError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
      this.name = "UnsafeUrlError";
    }
  },
}));

// Mock every AgentOS round trip (clients + the attach/detach lifecycle's
// machinery); agentosErrorResponse and the pure helpers stay real via
// importOriginal — the 502/503 shaping is under test here.
const mockFetchKnowledgeList = vi.fn();
const mockFetchKnowledgeConfig = vi.fn();
const mockUploadKnowledgeContent = vi.fn();
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
    fetchKnowledgeConfig: (...a: unknown[]) => mockFetchKnowledgeConfig(...a),
    uploadKnowledgeContent: (...a: unknown[]) => mockUploadKnowledgeContent(...a),
    deleteKnowledgeContent: (...a: unknown[]) => mockDeleteKnowledgeContent(...a),
    getAgentosComponent: (...a: unknown[]) => mockGetComponent(...a),
    getAgentosCurrentConfig: (...a: unknown[]) => mockGetCurrentConfig(...a),
    updateAgentosConfig: (...a: unknown[]) => mockUpdateConfig(...a),
    fetchAgentosModels: (...a: unknown[]) => mockFetchModels(...a),
    fetchBuilderTools: (...a: unknown[]) => mockFetchToolFns(...a),
  };
});

import { GET, POST } from "./route";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { UnsafeUrlError } from "@/lib/net/safe-fetch";
import { AgentosError } from "@/lib/agents/builder";
import {
  createAgent,
  getAgent,
  listAgents,
  deleteAgent,
} from "@/lib/agents/agent-store";
import { setCredential, getCredentialSecrets, deleteCredential } from "@/lib/credentials/credential-store";
import type { AgentEntry } from "@/lib/agents/agents.config";
import { getSyntheticAdmin } from "@/lib/auth/context";
import { runMigrations } from "@/lib/db/migrate";

const MODELS = [
  { provider: "openai", id: "gpt-4o-mini", platform_tier: true, requires_key: true, dep_key: "openai_api_key", name: "OpenAIChat" },
];
const KNOWLEDGE_ENABLED = { enabled: true, provider: "openai", model: "text-embedding-3-small" };

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

function getKnowledge(agentId: string) {
  return GET(new Request(`http://localhost/api/agents/${agentId}/knowledge`), {
    params: Promise.resolve({ id: agentId }),
  });
}

function postKnowledge(agentId: string, form: FormData) {
  return POST(new Request(`http://localhost/api/agents/${agentId}/knowledge`, {
    method: "POST",
    body: form,
  }), { params: Promise.resolve({ id: agentId }) });
}

function textForm(body: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return form;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations();
  const synthetic = await getSyntheticAdmin();
  testOrg = synthetic.orgId;
  authorId = synthetic.id;
  mockGetCurrentUser.mockImplementation(async () => synthetic);
  mockAssertSafeUrl.mockResolvedValue(undefined);
  mockFetchKnowledgeList.mockResolvedValue([]);
  mockFetchKnowledgeConfig.mockResolvedValue(KNOWLEDGE_ENABLED);
  mockUploadKnowledgeContent.mockResolvedValue({ id: "content-1", name: "Pasted text", status: "processing" });
  mockDeleteKnowledgeContent.mockResolvedValue(undefined);
  mockGetComponent.mockResolvedValue(componentFixture());
  mockGetCurrentConfig.mockResolvedValue({
    id: "comp-1",
    name: "Fixture",
    model: { id: "gpt-4o-mini", name: "OpenAIChat" },
    instructions: ["base prompt"],
    tools: [],
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

describe("GET /api/agents/[id]/knowledge", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await getKnowledge(agent.id);
    expect(res.status).toBe(401);
  });

  it("rides the agentRead bucket", async () => {
    await getKnowledge(agent.id);
    expect(checkUserLimit).toHaveBeenCalledWith(authorId, "agentRead");
  });

  it("returns 429 when the rate limit refuses", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await getKnowledge(agent.id);
    expect(res.status).toBe(429);
    expect(mockFetchKnowledgeList).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await getKnowledge("nope");
    expect(res.status).toBe(404);
    expect(mockFetchKnowledgeList).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-builder agent (no existence oracle for foreign rows)", async () => {
    const manual = await createFixture({
      name: "Manual",
      origin: "manual",
      remoteAgentId: undefined,
      endpoint: "http://backend.example.com",
      jwtSecret: undefined,
      authMode: "none",
    });
    const res = await getKnowledge(manual.id);
    expect(res.status).toBe(404);
    expect(mockFetchKnowledgeList).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-author", async () => {
    const notMine = await createFixture({ authorUserId: "someone-else" });
    const res = await getKnowledge(notMine.id);
    expect(res.status).toBe(403);
    expect(mockFetchKnowledgeList).not.toHaveBeenCalled();
  });

  it("returns 403 for a platform admin who is not the author (no admin override)", async () => {
    const notMine = await createFixture({ authorUserId: "someone-else" });
    mockGetCurrentUser.mockImplementation(async () => ({
      id: "admin-1",
      role: "admin",
      orgId: testOrg,
      name: "Admin",
      email: null,
    }));
    const res = await getKnowledge(notMine.id);
    expect(res.status).toBe(403);
  });

  it("returns the corpus list", async () => {
    const rows = [{ id: "c1", name: "handbook.pdf", status: "completed", size: 10, createdAt: 1, updatedAt: 2 }];
    mockFetchKnowledgeList.mockResolvedValue(rows);
    const res = await getKnowledge(agent.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
    expect(mockFetchKnowledgeList).toHaveBeenCalledWith("comp-1");
  });
});

describe("POST /api/agents/[id]/knowledge — validation", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await postKnowledge(agent.id, textForm({ text: "hello" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a platform admin who is not the author (no admin override)", async () => {
    const notMine = await createFixture({ authorUserId: "someone-else" });
    mockGetCurrentUser.mockImplementation(async () => ({
      id: "admin-1",
      role: "admin",
      orgId: testOrg,
      name: "Admin",
      email: null,
    }));
    const res = await postKnowledge(notMine.id, textForm({ text: "x" }));
    expect(res.status).toBe(403);
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("rides the knowledgeMutate bucket", async () => {
    await postKnowledge(agent.id, textForm({ text: "hello" }));
    expect(checkUserLimit).toHaveBeenCalledWith(authorId, "knowledgeMutate");
  });

  it("returns 404 for an unknown agent and 404 for a non-builder agent", async () => {
    expect((await postKnowledge("nope", textForm({ text: "x" }))).status).toBe(404);
    const manual = await createFixture({
      name: "Manual",
      origin: "manual",
      remoteAgentId: undefined,
      endpoint: "http://backend.example.com",
      jwtSecret: undefined,
      authMode: "none",
    });
    expect((await postKnowledge(manual.id, textForm({ text: "x" }))).status).toBe(404);
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-author", async () => {
    const notMine = await createFixture({ authorUserId: "someone-else" });
    const res = await postKnowledge(notMine.id, textForm({ text: "x" }));
    expect(res.status).toBe(403);
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 400 for a body with no source", async () => {
    const res = await postKnowledge(agent.id, textForm({ name: "just a name" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Provide a file, text, or url");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 400 when more than one source is provided", async () => {
    const form = textForm({ text: "hello", url: "https://example.com/doc" });
    const res = await postKnowledge(agent.id, form);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("exactly ONE");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 400 with the accepted-formats copy for an unsupported extension", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "payload.exe"));
    const res = await postKnowledge(agent.id, form);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("accepted formats");
    expect(body.error).toContain(".pdf");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 400 for a file with no extension", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "README"));
    const res = await postKnowledge(agent.id, form);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("accepted formats");
  });

  it("rejects an oversized content-length header before formData() buffers it", async () => {
    // The header alone triggers the rejection — a small body with a lying
    // oversized content-length is 400'd BEFORE formData() parses it (the
    // cheap-header-check semantics; the post-parse File.size/text checks
    // and the upload never run).
    const res = await POST(new Request(`http://localhost/api/agents/${agent.id}/knowledge`, {
      method: "POST",
      body: textForm({ text: "hello" }),
      headers: { "content-length": String(11 * 1024 * 1024) },
    }), { params: Promise.resolve({ id: agent.id }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("10.5 MB request cap");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 400 when the file exceeds the 10 MB cap", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf"));
    const res = await postKnowledge(agent.id, form);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("10 MB upload cap");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 400 when the text exceeds the 10 MB cap", async () => {
    const res = await postKnowledge(agent.id, textForm({ text: "x".repeat(10 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("10 MB request cap");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-absolute or non-http(s) URL", async () => {
    for (const bad of ["not a url", "ftp://example.com/doc"]) {
      const res = await postKnowledge(agent.id, textForm({ url: bad }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("absolute http(s) URL");
    }
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("rejects a URL that fails the SSRF guard (private IP)", async () => {
    mockAssertSafeUrl.mockRejectedValue(
      new UnsafeUrlError("hostname resolves to a private address"),
    );
    const res = await postKnowledge(agent.id, textForm({ url: "http://169.254.169.254/latest/meta-data" }));
    expect(res.status).toBe(400);
    // The guard saw the trimmed URL before anything was forwarded.
    expect(mockAssertSafeUrl).toHaveBeenCalledWith("http://169.254.169.254/latest/meta-data");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
    expect(mockFetchKnowledgeList).not.toHaveBeenCalled();
  });

  it("validates the chunk params", async () => {
    expect((await postKnowledge(agent.id, textForm({ text: "x", chunkSize: "0" }))).status).toBe(400);
    expect((await postKnowledge(agent.id, textForm({ text: "x", chunkOverlap: "-1" }))).status).toBe(400);
    expect((await postKnowledge(agent.id, textForm({ text: "x", chunkSize: "10", chunkOverlap: "10" }))).status).toBe(400);
    expect((await postKnowledge(agent.id, textForm({ text: "x", chunkSize: "abc" }))).status).toBe(400);
    // The positive case must clear every gate — the embedding key included
    // (the 400s above are shape failures, the 202 below proves it).
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    const ok = await postKnowledge(agent.id, textForm({ text: "x", chunkSize: "512", chunkOverlap: "64" }));
    expect(ok.status).toBe(202);
  });

  it("returns 400 with the connect-a-key copy when the author has no OpenAI credential", async () => {
    // Credentials persist across tests in this file — clear the author's
    // openai row so the missing-key path is actually exercised.
    await deleteCredential(authorId, "openai");
    const res = await postKnowledge(agent.id, textForm({ text: "hello" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("OpenAI key");
    expect(body.error).toContain("API keys");
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });

  it("treats an author credential WITHOUT an api_key field as missing (fail-closed)", async () => {
    // A saved openai row whose fields don't cover the api_key contract
    // can't embed — the upload must refuse, never forward a broken key.
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { other_field: "x" } });
    expect(await getCredentialSecrets(authorId)).toEqual({ openai: { other_field: "x" } });
    const res = await postKnowledge(agent.id, textForm({ text: "hello" }));
    expect(res.status).toBe(400);
    expect(mockUploadKnowledgeContent).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/[id]/knowledge — forwarding + attach", () => {
  it("forwards the upload with the author's resolved embedding key and answers 202", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    const res = await postKnowledge(agent.id, textForm({ text: "hello world" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ id: "content-1", name: "Pasted text", status: "processing" });
    const call = mockUploadKnowledgeContent.mock.calls[0][0] as {
      componentId: string;
      text?: string;
      embeddingKey: string;
    };
    expect(call.componentId).toBe("comp-1");
    expect(call.text).toBe("hello world");
    expect(call.embeddingKey).toBe("sk-author-1");
    // The embedding key never leaves the server.
    expect(JSON.stringify(body)).not.toContain("sk-author-1");
  });

  it("maps a service 502/503 to the same status through agentosErrorResponse", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    mockUploadKnowledgeContent.mockRejectedValue(new AgentosError(502, "The agent builder is unavailable right now — please try again shortly."));
    expect((await postKnowledge(agent.id, textForm({ text: "x" }))).status).toBe(502);
    mockUploadKnowledgeContent.mockRejectedValue(new AgentosError(503, "The agent builder is unavailable right now — please try again shortly."));
    expect((await postKnowledge(agent.id, textForm({ text: "x" }))).status).toBe(503);
    // No attach ran behind the failed upload.
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("first upload attaches the knowledge ref to the config and re-derives the snapshot", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    const res = await postKnowledge(agent.id, textForm({ text: "hello world" }));
    expect(res.status).toBe(202);
    // The published config carries the ref, named from the component id.
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const [compId, config, version] = mockUpdateConfig.mock.calls[0] as [string, Record<string, unknown>, number];
    expect(compId).toBe("comp-1");
    expect(config.knowledge).toEqual({ name: "kb-comp-1" });
    expect(version).toBe(3);
    // The local snapshot gained the embedding contract.
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.requirements?.knowledge).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(stored?.requirements?.model.id).toBe("gpt-4o-mini");
  });

  it("falls back to the single-key diff on the snapshot when re-derivation declines", async () => {
    // The catalogs don't contain the fixture's model → the full derivation
    // returns null → the existing snapshot ± knowledge must still land.
    mockFetchModels.mockResolvedValue([]);
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    const res = await postKnowledge(agent.id, textForm({ text: "hello world" }));
    expect(res.status).toBe(202);
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.requirements?.knowledge).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(stored?.requirements?.model.id).toBe("gpt-4o-mini");
  });

  it("skips the attach when the config already references the corpus (second doc)", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    mockGetCurrentConfig.mockResolvedValue({
      id: "comp-1",
      name: "Fixture",
      model: { id: "gpt-4o-mini", name: "OpenAIChat" },
      instructions: ["base prompt"],
      tools: [],
      knowledge: { name: "kb-comp-1" },
    });
    const res = await postKnowledge(agent.id, textForm({ text: "second doc" }));
    expect(res.status).toBe(202);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("reverts the local snapshot and surfaces 409 when the attach publish loses the version race", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    mockUpdateConfig.mockRejectedValue(new AgentosError(409, "version conflict"));
    const res = await postKnowledge(agent.id, textForm({ text: "hello world" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("just updated by someone else");
    // The compensating revert restored the pre-attach snapshot.
    const stored = await getAgent(agent.id, testOrg);
    expect("knowledge" in (stored?.requirements ?? {})).toBe(false);
  });

  it("reverts the local snapshot when the attach publish fails for other reasons", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    mockUpdateConfig.mockRejectedValue(new AgentosError(503, "agentos down"));
    const res = await postKnowledge(agent.id, textForm({ text: "hello world" }));
    expect(res.status).toBe(503);
    const stored = await getAgent(agent.id, testOrg);
    expect("knowledge" in (stored?.requirements ?? {})).toBe(false);
  });

  it("fails the request (doc retained) when the capability signal contradicts the accepted upload", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    mockFetchKnowledgeConfig.mockResolvedValue({ enabled: false, provider: "", model: "" });
    const res = await postKnowledge(agent.id, textForm({ text: "hello world" }));
    expect(res.status).toBe(502);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("preserves the untouched snapshot fields through the attach (description not clobbered)", async () => {
    await setCredential({ userId: authorId, provider: "openai", kind: "llm", fields: { api_key: "sk-author-1" } });
    await postKnowledge(agent.id, textForm({ text: "hello world" }));
    const stored = await getAgent(agent.id, testOrg);
    expect(stored?.description).toBe("A fixture agent");
    expect(stored?.name).toBe("Fixture");
  });
});

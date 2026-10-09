import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the SSRF guard so route tests focus on route logic.
// The guard itself is tested in lib/net/safe-fetch.test.ts.
vi.mock("@/lib/net/safe-fetch", () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  UnsafeUrlError: class UnsafeUrlError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
      this.name = "UnsafeUrlError";
    }
  },
}));

// Mock the rate limiter — defaults to "always allow".
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

import { GET, PATCH, DELETE } from "./route";
import { listAgents, createAgent, deleteAgent } from "@/lib/agents/agent-store";
import type { CreateAgentInput } from "@/lib/agents/agent-store";
import { getSyntheticAdmin } from "@/lib/auth/context";
import { runMigrations } from "@/lib/db/migrate";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { NextResponse } from "next/server";

let testOrg: string;
// The id of the agent created in beforeEach — used as the URL path param
// throughout. Server-generated, so we must capture it at runtime.
let agentId: string;

async function cleanup() {
  for (const a of await listAgents(testOrg, { bypassOrgScope: true })) await deleteAgent(a.id, testOrg, { bypassOrgScope: true });
}

const validInput: CreateAgentInput = {
  name: "Test Agent",
  description: "A test agent",
  endpoint: "http://localhost:8000/agent",
  authMode: "none",
};

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  await runMigrations();
  testOrg = (await getSyntheticAdmin()).orgId;
  await cleanup();
  const created = await createAgent(validInput, testOrg);
  agentId = created.id;
  vi.mocked(assertSafeUrl).mockClear();
  vi.mocked(assertSafeUrl).mockResolvedValue(undefined);
  vi.mocked(checkUserLimit).mockClear();
  vi.mocked(checkUserLimit).mockReturnValue(null);
});

describe("GET /api/agents/[id]", () => {
  it("returns 200 for existing agent", async () => {
    const res = await GET(
      new Request(`http://localhost/api/agents/${agentId}`),
      makeParams(agentId),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(agentId);
    expect(data.name).toBe("Test Agent");
  });

  it("returns 404 for missing agent", async () => {
    const res = await GET(
      new Request("http://localhost/api/agents/nonexistent"),
      makeParams("nonexistent"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await GET(
      new Request(`http://localhost/api/agents/${agentId}`),
      makeParams(agentId),
    );
    expect(res.status).toBe(429);
  });
});

describe("PATCH /api/agents/[id]", () => {
  it("updates name and returns 200", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Renamed");
    expect(data.id).toBe(agentId);
  });

  it("updates endpoint", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://localhost:9000/new" }),
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.endpoint).toBe("http://localhost:9000/new");
  });

  it("ignores `id` in the PATCH body (id comes from the URL only)", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "attacker-supplied", name: "Hacked" }),
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(agentId);
    expect(data.id).not.toBe("attacker-supplied");
    expect(data.name).toBe("Hacked");
  });

  it("returns 404 for missing agent", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/agents/nonexistent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      makeParams("nonexistent"),
    );
    expect(res.status).toBe(404);
  });

  it("accepts a patch that sends kind (unknown fields stripped)", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "agui", name: "Renamed" }),
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Renamed");
    expect("kind" in data).toBe(false);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when SSRF guard rejects a new endpoint", async () => {
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new UnsafeUrlError("hostname resolves to a private address"),
    );
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://169.254.169.254/" }),
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("private or internal address");
    // Endpoint was not updated
    const getRes = await GET(
      new Request(`http://localhost/api/agents/${agentId}`),
      makeParams(agentId),
    );
    const agent = await getRes.json();
    expect(agent.endpoint).toBe("http://localhost:8000/agent");
  });

  it("does not call the SSRF guard when endpoint is not in the patch", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Just Renamed" }),
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(200);
    expect(assertSafeUrl).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(429);
  });
});

describe("DELETE /api/agents/[id]", () => {
  it("deletes an agent and returns 204", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "DELETE",
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(204);
  });

  it("returns 404 for missing agent", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/agents/nonexistent", {
        method: "DELETE",
      }),
      makeParams("nonexistent"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await DELETE(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: "DELETE",
      }),
      makeParams(agentId),
    );
    expect(res.status).toBe(429);
  });
});

describe("managed agents (catalog installs) — fully locked", () => {
  const templateInput = {
    name: "Flight Finder",
    slug: "flight-finder",
    tagline: "Find cheap flights",
    description: "Searches live fares",
    endpoint: "http://localhost:8000/agent",
    authMode: "none" as const,
    sortOrder: 0,
    isActive: true,
  };
  let managedId: string;

  beforeEach(async () => {
    // Clean templates too — the outer cleanup only removes agents, and
    // the slug is unique across tests.
    const { listTemplates, deleteTemplate } = await import(
      "@/lib/catalog/template-store"
    );
    for (const t of await listTemplates({ activeOnly: false })) {
      await deleteTemplate(t.id);
    }
    const { createTemplate, installTemplate } = await import(
      "@/lib/catalog/template-store"
    );
    const template = await createTemplate(templateInput);
    const result = await installTemplate(template, testOrg);
    managedId = result.agent.id;
  });

  it("GET omits the endpoint for managed agents (curator URL never leaves the server)", async () => {
    const res = await GET(
      new Request(`http://localhost/api/agents/${managedId}`),
      makeParams(managedId),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sourceTemplateId).toBeTruthy();
    expect("endpoint" in data).toBe(false);
  });

  it("PATCH is rejected with AGENT_MANAGED (config is curator-owned)", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/agents/${managedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed", endpoint: "http://evil.example/agent" }),
      }),
      makeParams(managedId),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("AGENT_MANAGED");
    // Nothing changed.
    const { getAgent } = await import("@/lib/agents/agent-store");
    const stored = await getAgent(managedId, testOrg);
    expect(stored?.name).toBe("Flight Finder");
    expect(stored?.endpoint).toBe("http://localhost:8000/agent");
  });

  it("DELETE (Remove from workspace) works on managed agents", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/agents/${managedId}`, {
        method: "DELETE",
      }),
      makeParams(managedId),
    );
    expect(res.status).toBe(204);
    const { getAgent } = await import("@/lib/agents/agent-store");
    expect(await getAgent(managedId, testOrg)).toBeNull();
  });
});

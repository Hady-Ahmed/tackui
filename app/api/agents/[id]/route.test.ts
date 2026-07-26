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

let testOrg: string;

async function cleanup() {
  for (const a of await listAgents(testOrg, { bypassOrgScope: true })) await deleteAgent(a.id, testOrg, { bypassOrgScope: true });
}

const validInput: CreateAgentInput = {
  id: "test-agent",
  name: "Test Agent",
  description: "A test agent",
  kind: "agui",
  endpoint: "http://localhost:8000/agent",
};

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  await runMigrations();
  testOrg = (await getSyntheticAdmin()).orgId;
  await cleanup();
  await createAgent(validInput, testOrg);
  vi.mocked(assertSafeUrl).mockClear();
  vi.mocked(assertSafeUrl).mockResolvedValue(undefined);
});

describe("GET /api/agents/[id]", () => {
  it("returns 200 for existing agent", async () => {
    const res = await GET(
      new Request("http://localhost/api/agents/test-agent"),
      makeParams("test-agent"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("test-agent");
  });

  it("returns 404 for missing agent", async () => {
    const res = await GET(
      new Request("http://localhost/api/agents/nonexistent"),
      makeParams("nonexistent"),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/agents/[id]", () => {
  it("updates name and returns 200", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/agents/test-agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
      makeParams("test-agent"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Renamed");
  });

  it("updates endpoint", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/agents/test-agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://localhost:9000/new" }),
      }),
      makeParams("test-agent"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.endpoint).toBe("http://localhost:9000/new");
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

  it("returns 400 for invalid patch (bad kind)", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/agents/test-agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "openai" }),
      }),
      makeParams("test-agent"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/agents/test-agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      makeParams("test-agent"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when SSRF guard rejects a new endpoint", async () => {
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new UnsafeUrlError("hostname resolves to a private address"),
    );
    const res = await PATCH(
      new Request("http://localhost/api/agents/test-agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://169.254.169.254/" }),
      }),
      makeParams("test-agent"),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("private or internal address");
    // Endpoint was not updated
    const getRes = await GET(
      new Request("http://localhost/api/agents/test-agent"),
      makeParams("test-agent"),
    );
    const agent = await getRes.json();
    expect(agent.endpoint).toBe("http://localhost:8000/agent");
  });

  it("does not call the SSRF guard when endpoint is not in the patch", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/agents/test-agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Just Renamed" }),
      }),
      makeParams("test-agent"),
    );
    expect(res.status).toBe(200);
    expect(assertSafeUrl).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/agents/[id]", () => {
  it("deletes an agent and returns 204", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/agents/test-agent", {
        method: "DELETE",
      }),
      makeParams("test-agent"),
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
});

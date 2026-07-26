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

import { GET, POST } from "./route";
import { listAgents, deleteAgent } from "@/lib/agents/agent-store";
import { getSyntheticAdmin } from "@/lib/auth/context";
import { runMigrations } from "@/lib/db/migrate";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";

let testOrg: string;

async function cleanup() {
  for (const a of await listAgents(testOrg, { bypassOrgScope: true })) await deleteAgent(a.id, testOrg, { bypassOrgScope: true });
}

beforeEach(async () => {
  await runMigrations();
  testOrg = (await getSyntheticAdmin()).orgId;
  await cleanup();
  vi.mocked(assertSafeUrl).mockResolvedValue(undefined);
});

const validBody = {
  id: "test-agent",
  name: "Test Agent",
  description: "A test agent",
  kind: "agui",
  endpoint: "http://localhost:8000/agent",
};

describe("GET /api/agents", () => {
  it("returns 200 with an array", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("returns created agents", async () => {
    await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    const res = await GET();
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("test-agent");
  });
});

describe("POST /api/agents", () => {
  it("creates an agent and returns 201", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("test-agent");
    expect(data.name).toBe("Test Agent");
  });

  it("returns 400 for invalid body (bad endpoint)", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, endpoint: "not-a-url" }),
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Validation");
  });

  it("returns 400 for invalid body (bad kind)", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, kind: "openai" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate ID", async () => {
    await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("already exists");
  });

  it("returns 400 when SSRF guard rejects the endpoint", async () => {
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new UnsafeUrlError("hostname resolves to a private address"),
    );
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validBody,
          endpoint: "http://169.254.169.254/",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("private or internal address");
    // Agent was not created
    const list = await GET();
    const agents = await list.json();
    expect(agents).toHaveLength(0);
  });
});

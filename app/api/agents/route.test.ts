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

// Mock the rate limiter — defaults to "always allow". The rate-limit
// module itself is tested in lib/ratelimit/*.test.ts.
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock the plan-enforcement check — defaults to "allow". The enforcement
// logic itself is tested in lib/plans/enforcement.test.ts.
vi.mock("@/lib/plans/enforcement", () => ({
  checkAgentCountLimit: vi.fn().mockResolvedValue(null),
}));

import { GET, POST } from "./route";
import { listAgents, deleteAgent, createAgent } from "@/lib/agents/agent-store";
import * as agentStore from "@/lib/agents/agent-store";
import type { CreateAgentInput } from "@/lib/agents/agent-store";
import { getSyntheticAdmin } from "@/lib/auth/context";
import { runMigrations } from "@/lib/db/migrate";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { checkAgentCountLimit } from "@/lib/plans/enforcement";
import { NextResponse } from "next/server";

let testOrg: string;

async function cleanup() {
  for (const a of await listAgents(testOrg, { bypassOrgScope: true })) await deleteAgent(a.id, testOrg, { bypassOrgScope: true });
}

beforeEach(async () => {
  await runMigrations();
  testOrg = (await getSyntheticAdmin()).orgId;
  await cleanup();
  vi.mocked(assertSafeUrl).mockResolvedValue(undefined);
  vi.mocked(checkAgentCountLimit).mockResolvedValue(null);
});

const validBody = {
  name: "Test Agent",
  description: "A test agent",
  kind: "agui",
  endpoint: "http://localhost:8000/agent",
};

const validInput: CreateAgentInput = {
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
    expect(data[0].name).toBe("Test Agent");
    expect(data[0].id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await GET();
    expect(res.status).toBe(429);
  });
});

describe("POST /api/agents", () => {
  it("creates an agent and returns 201 with a server-generated id", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toMatch(/^[0-9a-f]{12}$/);
    expect(data.name).toBe("Test Agent");
    // `id` is not accepted from the client — it's server-generated.
    expect(validBody).not.toHaveProperty("id");
  });

  it("ignores `id` if the client sends it (defense-in-depth)", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, id: "attacker-supplied" }),
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    // Server generated a fresh id; the client-supplied one was ignored.
    expect(data.id).toMatch(/^[0-9a-f]{12}$/);
    expect(data.id).not.toBe("attacker-supplied");
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

  it("creates two agents with the same name in different orgs without collision", async () => {
    // Regression test for the auth-on → auth-off phantom-collision bug.
    // Pre-create an agent directly in another org (simulating the agent
    // left behind from a prior auth-on session). POSTing from the test
    // user's org must still succeed — the composite PK allows same-id
    // across orgs, and ids are random anyway.
    await createAgent(validInput, "other-org-id");

    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toMatch(/^[0-9a-f]{12}$/);
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

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(429);
  });

  it("returns 402 when the plan agent-count limit is reached", async () => {
    vi.mocked(checkAgentCountLimit).mockResolvedValueOnce(
      NextResponse.json(
        { error: "Plan limit reached", code: "PLAN_AGENT_LIMIT" },
        { status: 402 },
      ),
    );
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.code).toBe("PLAN_AGENT_LIMIT");
    // Agent was not created
    const list = await GET();
    const agents = await list.json();
    expect(agents).toHaveLength(0);
  });

  it("masks internal errors on create (no DB topology leak)", async () => {
    // Simulate a non-23505 failure from createAgent (e.g. PG connection
    // drop). The raw message must NOT surface to the client. spyOn on
    // the namespace so the route's live binding sees the override;
    // restoreAllMocks in afterEach cleans up.
    const spy = vi
      .spyOn(agentStore, "createAgent")
      .mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
        }),
      );
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to create agent. Check server logs.");
    // The raw internal message must not leak
    expect(JSON.stringify(data)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(data)).not.toContain("5432");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

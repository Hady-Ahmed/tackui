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
  endpoint: "http://localhost:8000/agent",
};

const validInput: CreateAgentInput = {
  name: "Test Agent",
  description: "A test agent",
  endpoint: "http://localhost:8000/agent",
  authMode: "none",
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

  it("returns 400 for a missing/empty description", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, description: "" }),
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Validation");
    expect(data.details.fieldErrors).toHaveProperty("description");
  });

  it("accepts legacy bodies that still send kind (unknown fields stripped)", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, kind: "agui" }),
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect("kind" in data).toBe(false);
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

describe("GET /api/agents — catalog curator-state annotation", () => {
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

  beforeEach(async () => {
    // The outer cleanup removes agents; templates must go too (unique
    // slugs across tests).
    const { listTemplates, deleteTemplate } = await import(
      "@/lib/catalog/template-store"
    );
    for (const t of await listTemplates({ activeOnly: false })) {
      await deleteTemplate(t.id);
    }
  });

  it("live managed agents carry no flags; deactivated → templateUnpublished; deleted → tombstone", async () => {
    const { createTemplate, installTemplate, updateTemplate, deleteTemplate } =
      await import("@/lib/catalog/template-store");

    const tpl = await createTemplate(templateInput);
    const { agent } = await installTemplate(tpl, testOrg);

    // Live template → no flags, endpoint stripped (managed).
    let res = await GET();
    let list = (await res.json()) as Array<Record<string, unknown>>;
    let managed = list.find((a) => a.id === agent.id);
    expect(managed).toBeTruthy();
    expect(managed!.templateUnpublished).toBeUndefined();
    expect(managed!.templateRemovedAt).toBeUndefined();
    expect("endpoint" in managed!).toBe(false);

    // Deactivated template (reversible kill switch) → Paused flag.
    await updateTemplate(tpl.id, { isActive: false });
    res = await GET();
    list = (await res.json()) as Array<Record<string, unknown>>;
    managed = list.find((a) => a.id === agent.id);
    expect(managed!.templateUnpublished).toBe(true);
    expect(managed!.templateRemovedAt).toBeUndefined();

    // Template deleted → tombstone wins, Paused flag never set.
    await deleteTemplate(tpl.id);
    res = await GET();
    list = (await res.json()) as Array<Record<string, unknown>>;
    managed = list.find((a) => a.id === agent.id);
    expect(managed!.templateRemovedAt).toBeTruthy();
    expect(managed!.templateUnpublished).toBeUndefined();
  });

  it("manually-added agents are never annotated", async () => {
    await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );
    const res = await GET();
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].templateUnpublished).toBeUndefined();
    expect(list[0].templateRemovedAt).toBeUndefined();
    expect(list[0].endpoint).toBe("http://localhost:8000/agent");
  });
});

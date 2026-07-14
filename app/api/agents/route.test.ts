import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "./route";
import { listAgents, deleteAgent } from "@/lib/agents/agent-store";

function cleanup() {
  for (const a of listAgents()) deleteAgent(a.id);
}

beforeEach(() => cleanup());

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
});

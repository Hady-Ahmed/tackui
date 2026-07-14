import { describe, it, expect, beforeEach } from "vitest";
import { GET, PATCH, DELETE } from "./route";
import { listAgents, createAgent, deleteAgent } from "@/lib/agents/agent-store";
import type { CreateAgentInput } from "@/lib/agents/agent-store";

function cleanup() {
  for (const a of listAgents()) deleteAgent(a.id);
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

beforeEach(() => {
  cleanup();
  createAgent(validInput);
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

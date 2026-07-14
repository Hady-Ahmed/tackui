import { describe, it, expect, beforeEach } from "vitest";
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  agentEntrySchema,
} from "./agent-store";
import type { CreateAgentInput } from "./agent-store";

const validInput: CreateAgentInput = {
  id: "test-agent",
  name: "Test Agent",
  description: "A test agent",
  kind: "agui",
  endpoint: "http://localhost:8000/agent",
};

function cleanup() {
  for (const a of listAgents()) deleteAgent(a.id);
}

beforeEach(() => cleanup());

describe("agentEntrySchema", () => {
  it("accepts a valid entry", () => {
    const result = agentEntrySchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("rejects uppercase IDs", () => {
    const result = agentEntrySchema.safeParse({
      ...validInput,
      id: "TestAgent",
    });
    expect(result.success).toBe(false);
  });

  it("rejects IDs with spaces", () => {
    const result = agentEntrySchema.safeParse({
      ...validInput,
      id: "test agent",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-URL endpoints", () => {
    const result = agentEntrySchema.safeParse({
      ...validInput,
      endpoint: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid kind", () => {
    const result = agentEntrySchema.safeParse({
      ...validInput,
      kind: "openai",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional graphId and langsmithApiKey", () => {
    const result = agentEntrySchema.safeParse({
      ...validInput,
      graphId: "agent",
      langsmithApiKey: "ls-xxx",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = agentEntrySchema.safeParse({
      ...validInput,
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("createAgent", () => {
  it("creates an agent and returns it", () => {
    const created = createAgent(validInput);
    expect(created.id).toBe("test-agent");
    expect(created.name).toBe("Test Agent");
    expect(created.kind).toBe("agui");
    expect(created.endpoint).toBe("http://localhost:8000/agent");
  });

  it("stores optional fields", () => {
    const created = createAgent({
      ...validInput,
      graphId: "my-graph",
      langsmithApiKey: "ls-key",
    });
    expect(created.graphId).toBe("my-graph");
    expect(created.langsmithApiKey).toBe("ls-key");
  });

  it("throws on duplicate ID", () => {
    createAgent(validInput);
    expect(() => createAgent(validInput)).toThrow();
  });
});

describe("listAgents", () => {
  it("returns empty array when no agents", () => {
    expect(listAgents()).toEqual([]);
  });

  it("returns all agents ordered by created_at", () => {
    createAgent(validInput);
    createAgent({
      ...validInput,
      id: "second-agent",
      name: "Second",
    });
    const list = listAgents();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("test-agent");
    expect(list[1].id).toBe("second-agent");
  });
});

describe("getAgent", () => {
  it("returns agent by ID", () => {
    createAgent(validInput);
    const agent = getAgent("test-agent");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Test Agent");
  });

  it("returns null for missing ID", () => {
    expect(getAgent("nonexistent")).toBeNull();
  });
});

describe("updateAgent", () => {
  it("updates fields and returns the updated agent", () => {
    createAgent(validInput);
    const updated = updateAgent("test-agent", { name: "Renamed" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.endpoint).toBe("http://localhost:8000/agent");
  });

  it("updates endpoint", () => {
    createAgent(validInput);
    const updated = updateAgent("test-agent", {
      endpoint: "http://localhost:9000/new",
    });
    expect(updated!.endpoint).toBe("http://localhost:9000/new");
  });

  it("returns null for missing agent", () => {
    expect(updateAgent("nonexistent", { name: "X" })).toBeNull();
  });

  it("validates merged result", () => {
    createAgent(validInput);
    expect(() =>
      updateAgent("test-agent", { endpoint: "not-a-url" }),
    ).toThrow();
  });
});

describe("deleteAgent", () => {
  it("deletes an agent and returns true", () => {
    createAgent(validInput);
    expect(deleteAgent("test-agent")).toBe(true);
    expect(getAgent("test-agent")).toBeNull();
  });

  it("returns false for missing agent", () => {
    expect(deleteAgent("nonexistent")).toBe(false);
  });
});

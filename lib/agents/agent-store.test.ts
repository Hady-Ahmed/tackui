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
import { runMigrations } from "@/lib/db/migrate";

const validInput: CreateAgentInput = {
  id: "test-agent",
  name: "Test Agent",
  description: "A test agent",
  kind: "agui",
  endpoint: "http://localhost:8000/agent",
};

async function cleanup() {
  for (const a of await listAgents()) await deleteAgent(a.id);
}

beforeEach(async () => {
  // Ensure the agents table exists (no-op if already created by an earlier
  // test file in this module registry). pg-mem recreates the DB per file
  // because vitest's isolate:true gives each file its own module registry.
  await runMigrations();
  await cleanup();
});

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
  it("creates an agent and returns it", async () => {
    const created = await createAgent(validInput);
    expect(created.id).toBe("test-agent");
    expect(created.name).toBe("Test Agent");
    expect(created.kind).toBe("agui");
    expect(created.endpoint).toBe("http://localhost:8000/agent");
  });

  it("stores optional fields", async () => {
    const created = await createAgent({
      ...validInput,
      graphId: "my-graph",
      langsmithApiKey: "ls-key",
    });
    expect(created.graphId).toBe("my-graph");
    expect(created.langsmithApiKey).toBe("ls-key");
  });

  it("throws on duplicate ID (PG unique-violation 23505)", async () => {
    await createAgent(validInput);
    let errCode: string | undefined;
    try {
      await createAgent(validInput);
    } catch (e) {
      errCode = (e as { code?: string }).code;
    }
    expect(errCode).toBe("23505");
  });
});

describe("listAgents", () => {
  it("returns empty array when no agents", async () => {
    expect(await listAgents()).toEqual([]);
  });

  it("returns all agents ordered by created_at", async () => {
    await createAgent(validInput);
    await createAgent({
      ...validInput,
      id: "second-agent",
      name: "Second",
    });
    const list = await listAgents();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("test-agent");
    expect(list[1].id).toBe("second-agent");
  });
});

describe("getAgent", () => {
  it("returns agent by ID", async () => {
    await createAgent(validInput);
    const agent = await getAgent("test-agent");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Test Agent");
  });

  it("returns null for missing ID", async () => {
    expect(await getAgent("nonexistent")).toBeNull();
  });
});

describe("updateAgent", () => {
  it("updates fields and returns the updated agent", async () => {
    await createAgent(validInput);
    const updated = await updateAgent("test-agent", { name: "Renamed" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.endpoint).toBe("http://localhost:8000/agent");
  });

  it("updates endpoint", async () => {
    await createAgent(validInput);
    const updated = await updateAgent("test-agent", {
      endpoint: "http://localhost:9000/new",
    });
    expect(updated!.endpoint).toBe("http://localhost:9000/new");
  });

  it("returns null for missing agent", async () => {
    expect(await updateAgent("nonexistent", { name: "X" })).toBeNull();
  });

  it("validates merged result", async () => {
    await createAgent(validInput);
    await expect(
      updateAgent("test-agent", { endpoint: "not-a-url" }),
    ).rejects.toThrow();
  });

  it("does not throw on missing id — returns null cleanly", async () => {
    // Confirms RETURNING * with no matching row resolves to null, not throw.
    const result = await updateAgent("totally-missing", { name: "X" });
    expect(result).toBeNull();
  });
});

describe("deleteAgent", () => {
  it("deletes an agent and returns true", async () => {
    await createAgent(validInput);
    expect(await deleteAgent("test-agent")).toBe(true);
    expect(await getAgent("test-agent")).toBeNull();
  });

  it("returns false for missing agent", async () => {
    expect(await deleteAgent("nonexistent")).toBe(false);
  });
});

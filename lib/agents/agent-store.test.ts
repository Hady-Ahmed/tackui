import { describe, it, expect, beforeEach } from "vitest";
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  createAgentBodySchema,
  updateAgentBodySchema,
  generateAgentId,
} from "./agent-store";
import type { CreateAgentInput } from "./agent-store";
import { runMigrations } from "@/lib/db/migrate";

const TEST_ORG = "test-org-id";
const OTHER_ORG = "other-org-id";

const validInput: CreateAgentInput = {
  name: "Test Agent",
  description: "A test agent",
  kind: "agui",
  endpoint: "http://localhost:8000/agent",
};

async function cleanup() {
  for (const a of await listAgents(TEST_ORG, { bypassOrgScope: true })) await deleteAgent(a.id, TEST_ORG, { bypassOrgScope: true });
}

beforeEach(async () => {
  // Ensure the agents table exists (no-op if already created by an earlier
  // test file in this module registry). pg-mem recreates the DB per file
  // because vitest's isolate:true gives each file its own module registry.
  await runMigrations();
  await cleanup();
});

describe("createAgentBodySchema", () => {
  it("accepts a valid body (no id)", () => {
    const result = createAgentBodySchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("strips `id` if a client sends it (defense-in-depth)", () => {
    const result = createAgentBodySchema.safeParse({ ...validInput, id: "attacker" });
    expect(result.success).toBe(true);
    expect(result.success && "id" in result.data).toBe(false);
  });

  it("rejects non-URL endpoints", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      endpoint: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid kind", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      kind: "openai",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional graphId and langsmithApiKey", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      graphId: "agent",
      langsmithApiKey: "ls-xxx",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateAgentBodySchema", () => {
  it("accepts a partial body", () => {
    expect(updateAgentBodySchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateAgentBodySchema.safeParse({ endpoint: "http://x/y" }).success).toBe(true);
    expect(updateAgentBodySchema.safeParse({}).success).toBe(true);
  });

  it("strips `id` if a client sends it", () => {
    const result = updateAgentBodySchema.safeParse({ id: "attacker", name: "X" });
    expect(result.success).toBe(true);
    expect(result.success && "id" in result.data).toBe(false);
  });
});

describe("generateAgentId", () => {
  it("returns a 12-char lowercase hex string", () => {
    const id = generateAgentId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(id).toHaveLength(12);
  });

  it("returns distinct ids on repeated calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateAgentId()));
    expect(ids.size).toBe(50);
  });
});

describe("createAgent", () => {
  it("creates an agent with a server-generated id and returns it", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    expect(created.id).toMatch(/^[0-9a-f]{12}$/);
    expect(created.name).toBe("Test Agent");
    expect(created.kind).toBe("agui");
    expect(created.endpoint).toBe("http://localhost:8000/agent");
    expect(created.orgId).toBe(TEST_ORG);
  });

  it("stores optional fields", async () => {
    const created = await createAgent({
      ...validInput,
      graphId: "my-graph",
      langsmithApiKey: "ls-key",
    }, TEST_ORG);
    expect(created.graphId).toBe("my-graph");
    expect(created.langsmithApiKey).toBe("ls-key");
  });

  it("generates distinct ids for two creates in the same org", async () => {
    const a = await createAgent(validInput, TEST_ORG);
    const b = await createAgent({ ...validInput, name: "Second" }, TEST_ORG);
    expect(a.id).not.toBe(b.id);
  });

  it("allows the same name (and same generated id space) across different orgs", async () => {
    // With random ids + composite PK, two orgs each creating an agent
    // never collide — the bug fix for the auth-on → auth-off scenario.
    const a = await createAgent(validInput, TEST_ORG);
    const b = await createAgent(validInput, OTHER_ORG);
    expect(a.id).not.toBe(b.id);
    expect(a.orgId).toBe(TEST_ORG);
    expect(b.orgId).toBe(OTHER_ORG);
  });
});

describe("listAgents", () => {
  it("returns empty array when no agents", async () => {
    expect(await listAgents(TEST_ORG)).toEqual([]);
  });

  it("returns all agents ordered by created_at", async () => {
    await createAgent(validInput, TEST_ORG);
    await createAgent({ ...validInput, name: "Second" }, TEST_ORG);
    const list = await listAgents(TEST_ORG);
    expect(list).toHaveLength(2);
  });

  it("scopes by org_id — other orgs' agents are hidden", async () => {
    await createAgent(validInput, TEST_ORG);
    await createAgent({ ...validInput, name: "Other Org Agent" }, OTHER_ORG);
    const list = await listAgents(TEST_ORG);
    expect(list).toHaveLength(1);
    expect(list[0].orgId).toBe(TEST_ORG);
  });

  it("bypassOrgScope returns all orgs' agents", async () => {
    await createAgent(validInput, TEST_ORG);
    await createAgent({ ...validInput, name: "Other Org Agent" }, OTHER_ORG);
    const list = await listAgents(TEST_ORG, { bypassOrgScope: true });
    expect(list).toHaveLength(2);
  });
});

describe("getAgent", () => {
  it("returns agent by ID", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    const agent = await getAgent(created.id, TEST_ORG);
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Test Agent");
  });

  it("returns null for missing ID", async () => {
    expect(await getAgent("nonexistent", TEST_ORG)).toBeNull();
  });

  it("returns null when agent belongs to another org", async () => {
    const created = await createAgent(validInput, OTHER_ORG);
    expect(await getAgent(created.id, TEST_ORG)).toBeNull();
  });

  it("can fetch the same-name agent from each org independently (composite PK)", async () => {
    const a = await createAgent(validInput, TEST_ORG);
    const b = await createAgent(validInput, OTHER_ORG);
    expect(await getAgent(a.id, TEST_ORG)).not.toBeNull();
    expect(await getAgent(b.id, OTHER_ORG)).not.toBeNull();
  });
});

describe("updateAgent", () => {
  it("updates fields and returns the updated agent", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    const updated = await updateAgent(created.id, { name: "Renamed" }, TEST_ORG);
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.endpoint).toBe("http://localhost:8000/agent");
  });

  it("updates endpoint", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    const updated = await updateAgent(created.id, {
      endpoint: "http://localhost:9000/new",
    }, TEST_ORG);
    expect(updated!.endpoint).toBe("http://localhost:9000/new");
  });

  it("returns null for missing agent", async () => {
    expect(await updateAgent("nonexistent", { name: "X" }, TEST_ORG)).toBeNull();
  });

  it("returns null when agent belongs to another org", async () => {
    const created = await createAgent(validInput, OTHER_ORG);
    expect(await updateAgent(created.id, { name: "X" }, TEST_ORG)).toBeNull();
  });

  it("validates merged result", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    await expect(
      updateAgent(created.id, { endpoint: "not-a-url" }, TEST_ORG),
    ).rejects.toThrow();
  });

  it("does not throw on missing id — returns null cleanly", async () => {
    const result = await updateAgent("totally-missing", { name: "X" }, TEST_ORG);
    expect(result).toBeNull();
  });
});

describe("deleteAgent", () => {
  it("deletes an agent and returns true", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    expect(await deleteAgent(created.id, TEST_ORG)).toBe(true);
    expect(await getAgent(created.id, TEST_ORG)).toBeNull();
  });

  it("returns false for missing agent", async () => {
    expect(await deleteAgent("nonexistent", TEST_ORG)).toBe(false);
  });

  it("returns false when agent belongs to another org", async () => {
    const created = await createAgent(validInput, OTHER_ORG);
    expect(await deleteAgent(created.id, TEST_ORG)).toBe(false);
  });
});

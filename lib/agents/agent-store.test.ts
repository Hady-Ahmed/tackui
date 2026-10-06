import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  createAgentBodySchema,
  updateAgentBodySchema,
  generateAgentId,
  toPublicAgent,
} from "./agent-store";
import type { CreateAgentInput } from "./agent-store";
import { runMigrations } from "@/lib/db/migrate";
import { query } from "@/lib/db/pg";

const TEST_ORG = "test-org-id";
const OTHER_ORG = "other-org-id";

// Deterministic 32-byte hex key — all store round-trips in this file run
// with encryption enabled (reads decrypt transparently, so existing
// assertions are unaffected).
const ENCRYPTION_TEST_KEY = "ab".repeat(32);

beforeAll(() => {
  vi.stubEnv("DB_ENCRYPTION_KEY", ENCRYPTION_TEST_KEY);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const validInput: CreateAgentInput = {
  name: "Test Agent",
  description: "A test agent",
  endpoint: "http://localhost:8000/agent",
  authMode: "none",
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

  it("strips unknown fields like the removed `kind` (legacy senders keep working)", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      kind: "agui",
    });
    expect(result.success).toBe(true);
    expect(result.success && "kind" in result.data).toBe(false);
  });

  it("defaults authMode to 'none' when omitted", () => {
    const result = createAgentBodySchema.safeParse(validInput);
    expect(result.success).toBe(true);
    expect(result.success && result.data.authMode).toBe("none");
  });

  it("accepts authMode 'jwt' with a ≥32-char jwtSecret", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "a".repeat(32),
    });
    expect(result.success).toBe(true);
  });

  it("rejects jwtSecret shorter than 32 chars", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid authMode", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      authMode: "oauth",
    });
    expect(result.success).toBe(false);
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
    expect(created.endpoint).toBe("http://localhost:8000/agent");
    expect(created.orgId).toBe(TEST_ORG);
  });

  it("stores authMode and jwtSecret", async () => {
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    }, TEST_ORG);
    expect(created.authMode).toBe("jwt");
    expect(created.jwtSecret).toBe("s".repeat(32));
  });

  it("defaults authMode to 'none' when not specified", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    expect(created.authMode).toBe("none");
    expect(created.jwtSecret).toBeUndefined();
  });

  it("toPublicAgent strips jwtSecret, exposes boolean", async () => {
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    }, TEST_ORG);
    const pub = toPublicAgent(created);
    expect(pub.authMode).toBe("jwt");
    expect(pub.hasJwtSecret).toBe(true);
    expect("jwtSecret" in pub).toBe(false);
  });

  it("stores and retrieves jwtScopes as a comma-separated string", async () => {
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      jwtScopes: ["agents:run", "app:superadmin"],
    }, TEST_ORG);
    expect(created.jwtScopes).toEqual(["agents:run", "app:superadmin"]);

    const fetched = await getAgent(created.id, TEST_ORG);
    expect(fetched!.jwtScopes).toEqual(["agents:run", "app:superadmin"]);
  });

  it("toPublicAgent exposes jwtScopes as an array", async () => {
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      jwtScopes: ["agents:run"],
    }, TEST_ORG);
    const pub = toPublicAgent(created);
    expect(pub.jwtScopes).toEqual(["agents:run"]);
  });

  it("defaults jwtScopes to undefined when not specified", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    expect(created.jwtScopes).toBeUndefined();
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

  it("preserves jwtSecret when patch omits it (blank-preserve)", async () => {
    const secret = "s".repeat(32);
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: secret,
    }, TEST_ORG);
    // Patch name only — jwtSecret not in patch → existing value kept
    const updated = await updateAgent(created.id, { name: "Renamed" }, TEST_ORG);
    expect(updated!.authMode).toBe("jwt");
    expect(updated!.jwtSecret).toBe(secret);
  });

  it("overwrites jwtSecret when patch provides a new value", async () => {
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    }, TEST_ORG);
    const newSecret = "t".repeat(40);
    const updated = await updateAgent(created.id, { jwtSecret: newSecret }, TEST_ORG);
    expect(updated!.jwtSecret).toBe(newSecret);
  });

  it("updates authMode from none to jwt", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    expect(created.authMode).toBe("none");
    const updated = await updateAgent(created.id, {
      authMode: "jwt",
      jwtSecret: "x".repeat(32),
    }, TEST_ORG);
    expect(updated!.authMode).toBe("jwt");
    expect(updated!.jwtSecret).toBe("x".repeat(32));
  });

  it("updates jwtScopes", async () => {
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      jwtScopes: ["agents:run"],
    }, TEST_ORG);
    const updated = await updateAgent(created.id, {
      jwtScopes: ["agents:run", "app:superadmin"],
    }, TEST_ORG);
    expect(updated!.jwtScopes).toEqual(["agents:run", "app:superadmin"]);
  });

  it("clears jwtScopes when patch sends an empty array", async () => {
    const created = await createAgent({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      jwtScopes: ["agents:run", "app:superadmin"],
    }, TEST_ORG);
    expect(created.jwtScopes).toEqual(["agents:run", "app:superadmin"]);
    // Empty array = "remove all scopes" (not blank-preserve like jwtSecret)
    const updated = await updateAgent(created.id, { jwtScopes: [] }, TEST_ORG);
    expect(updated!.jwtScopes).toBeUndefined();
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

describe("jwt secret encryption at rest", () => {
  it("stores jwt_secret as ciphertext and reads back plaintext", async () => {
    const secret = "s".repeat(32);
    const created = await createAgent(
      { ...validInput, authMode: "jwt", jwtSecret: secret },
      TEST_ORG,
    );
    const raw = await query<{ jwt_secret: string }>(
      `SELECT jwt_secret FROM agents WHERE id = $1 AND org_id = $2`,
      [created.id, TEST_ORG],
    );
    expect(raw.rows[0].jwt_secret).toMatch(/^enc:v1:/);
    expect(raw.rows[0].jwt_secret).not.toContain(secret);
    expect((await getAgent(created.id, TEST_ORG))!.jwtSecret).toBe(secret);
  });

  it("re-encrypts a new secret on update (old ciphertext replaced)", async () => {
    const created = await createAgent(
      { ...validInput, authMode: "jwt", jwtSecret: "s".repeat(32) },
      TEST_ORG,
    );
    const newSecret = "t".repeat(40);
    await updateAgent(created.id, { jwtSecret: newSecret }, TEST_ORG);
    const raw = await query<{ jwt_secret: string }>(
      `SELECT jwt_secret FROM agents WHERE id = $1 AND org_id = $2`,
      [created.id, TEST_ORG],
    );
    expect(raw.rows[0].jwt_secret).toMatch(/^enc:v1:/);
    expect(raw.rows[0].jwt_secret).not.toContain(newSecret);
    expect((await getAgent(created.id, TEST_ORG))!.jwtSecret).toBe(newSecret);
  });

  it("legacy plaintext rows are still readable (passthrough)", async () => {
    await query(
      `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode, jwt_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["legacyagent01", "Legacy", "raw plaintext row", "http://localhost:8001/agent", TEST_ORG, "jwt", "p".repeat(32)],
    );
    const fetched = await getAgent("legacyagent01", TEST_ORG);
    expect(fetched!.jwtSecret).toBe("p".repeat(32));
    expect(toPublicAgent(fetched!).hasJwtSecret).toBe(true);
  });

  it("returns decrypted plaintext (never ciphertext) through the store API", async () => {
    const secret = "leak-check-" + "x".repeat(21);
    const created = await createAgent(
      { ...validInput, authMode: "jwt", jwtSecret: secret },
      TEST_ORG,
    );
    const fetched = (await getAgent(created.id, TEST_ORG))!;
    expect(fetched.jwtSecret).toBe(secret);
    expect(toPublicAgent(fetched)).not.toHaveProperty("jwtSecret");
  });
});

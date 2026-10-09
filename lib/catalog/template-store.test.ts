import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  listTemplates,
  getTemplate,
  getTemplateBySlug,
  getTemplatesByIds,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  createTemplateBodySchema,
  updateTemplateBodySchema,
  toPublicTemplate,
  countTemplateInstalls,
  findInstalledAgentId,
  installTemplate,
  getRunUsage,
} from "./template-store";
import { toPublicAgent } from "@/lib/agents/agent-store";
import type { CreateTemplateInput } from "./template-store";
import { runMigrations } from "@/lib/db/migrate";
import { query } from "@/lib/db/pg";
import { listAgents, deleteAgent } from "@/lib/agents/agent-store";

const TEST_ORG = "test-org-id";
const OTHER_ORG = "other-org-id";

// Deterministic 32-byte hex key — store round-trips run with encryption
// enabled (same convention as agent-store.test.ts).
const ENCRYPTION_TEST_KEY = "ab".repeat(32);

beforeAll(() => {
  vi.stubEnv("DB_ENCRYPTION_KEY", ENCRYPTION_TEST_KEY);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const validInput: CreateTemplateInput = {
  name: "Flight Finder",
  slug: "flight-finder",
  tagline: "Find cheap flights",
  description: "Searches live fares across airlines",
  endpoint: "http://localhost:8000/agent",
  authMode: "none",
  sortOrder: 0,
  isActive: true,
};

async function cleanup() {
  // Delete all installed agents (any org) + all templates. No
  // bypassOrgScope needed — agents deletes by id work cross-org via the
  // same helper the agents tests use.
  for (const a of await listAgents(TEST_ORG, { bypassOrgScope: true })) {
    await deleteAgent(a.id, TEST_ORG, { bypassOrgScope: true });
  }
  await query(`DELETE FROM agent_templates`);
  await query(`DELETE FROM agent_runs`);
  await query(`DELETE FROM thread_metadata`);
}

beforeEach(async () => {
  await runMigrations();
  await cleanup();
});

describe("createTemplateBodySchema", () => {
  it("accepts a valid body (no id)", () => {
    const result = createTemplateBodySchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("strips `id` if a client sends it (defense-in-depth)", () => {
    const result = createTemplateBodySchema.safeParse({ ...validInput, id: "attacker" });
    expect(result.success).toBe(true);
    expect(result.success && "id" in result.data).toBe(false);
  });

  it("rejects slugs with invalid characters", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      slug: "Flight Finder!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-URL endpoints", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      endpoint: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects requiredPlan values outside pro/team", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      requiredPlan: "free",
    });
    expect(result.success).toBe(false);
  });

  it("rejects freeDailyQuota < 1 or non-integer", () => {
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 0 }).success,
    ).toBe(false);
    expect(
      createTemplateBodySchema.safeParse({ ...validInput, freeDailyQuota: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects freeDailyQuota set together with requiredPlan (contradictory)", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      requiredPlan: "pro",
      freeDailyQuota: 10,
    });
    expect(result.success).toBe(false);
  });

  it("accepts requiredPlan without a quota", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      requiredPlan: "pro",
    });
    expect(result.success).toBe(true);
  });

  it("rejects jwtSecret shorter than 32 chars", () => {
    const result = createTemplateBodySchema.safeParse({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "short",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateTemplateBodySchema", () => {
  it("accepts a partial body", () => {
    expect(updateTemplateBodySchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateTemplateBodySchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateTemplateBodySchema.safeParse({}).success).toBe(true);
  });

  it("accepts explicit null on clearable fields", () => {
    const result = updateTemplateBodySchema.safeParse({
      category: null,
      icon: null,
      requiredPlan: null,
      freeDailyQuota: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("createTemplate / getTemplate / listTemplates", () => {
  it("creates a template with a server-generated id and reads it back", async () => {
    const created = await createTemplate(validInput);
    expect(created.id).toMatch(/^[0-9a-f]{12}$/);
    expect(created.slug).toBe("flight-finder");
    expect(created.tagline).toBe("Find cheap flights");
    expect(created.isActive).toBe(true);
    expect(created.requiredPlan).toBeUndefined();
    expect(created.freeDailyQuota).toBeUndefined();

    const fetched = await getTemplate(created.id);
    expect(fetched?.name).toBe("Flight Finder");
    expect(fetched?.updatedAt).toBe(created.updatedAt);
  });

  it("getTemplateBySlug resolves by slug", async () => {
    const created = await createTemplate(validInput);
    const fetched = await getTemplateBySlug("flight-finder");
    expect(fetched?.id).toBe(created.id);
    expect(await getTemplateBySlug("missing")).toBeNull();
  });

  it("listTemplates({ activeOnly }) filters deactivated templates", async () => {
    const active = await createTemplate(validInput);
    await createTemplate({ ...validInput, slug: "inactive-one", isActive: false });
    const all = await listTemplates({ activeOnly: false });
    expect(all).toHaveLength(2);
    const activeOnly = await listTemplates({ activeOnly: true });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].id).toBe(active.id);
  });

  it("listTemplates orders by sort_order then created_at", async () => {
    const a = await createTemplate({ ...validInput, slug: "a", sortOrder: 5 });
    const b = await createTemplate({ ...validInput, slug: "b", sortOrder: 1 });
    const c = await createTemplate({ ...validInput, slug: "c", sortOrder: 5 });
    const list = await listTemplates({ activeOnly: false });
    expect(list.map((t) => t.id)).toEqual([b.id, a.id, c.id]);
  });

  it("toPublicTemplate strips jwtSecret, exposes boolean + gates", async () => {
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      requiredPlan: "pro",
    });
    const pub = toPublicTemplate(created);
    expect(pub.hasJwtSecret).toBe(true);
    expect("jwtSecret" in pub).toBe(false);
    expect(pub.requiredPlan).toBe("pro");
  });
});

describe("jwt secret encryption at rest (templates)", () => {
  it("stores jwt_secret as ciphertext and reads back plaintext", async () => {
    const secret = "s".repeat(32);
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: secret,
    });
    const raw = await query<{ jwt_secret: string }>(
      `SELECT jwt_secret FROM agent_templates WHERE id = $1`,
      [created.id],
    );
    expect(raw.rows[0].jwt_secret).toMatch(/^enc:v1:/);
    expect(raw.rows[0].jwt_secret).not.toContain(secret);
    expect((await getTemplate(created.id))!.jwtSecret).toBe(secret);
  });
});

describe("updateTemplate", () => {
  it("updates fields and returns the updated template", async () => {
    const created = await createTemplate(validInput);
    const updated = await updateTemplate(created.id, { name: "Renamed", tagline: "New tagline" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.tagline).toBe("New tagline");
    expect(updated?.endpoint).toBe(validInput.endpoint);
  });

  it("returns null for missing template", async () => {
    expect(await updateTemplate("nonexistent", { name: "X" })).toBeNull();
  });

  it("preserves jwtSecret when patch omits it (blank-preserve)", async () => {
    const secret = "s".repeat(32);
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: secret,
    });
    const updated = await updateTemplate(created.id, { name: "Renamed" });
    expect(updated?.jwtSecret).toBe(secret);
  });

  it("overwrites jwtSecret when patch provides a new value", async () => {
    const created = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
    });
    const updated = await updateTemplate(created.id, { jwtSecret: "t".repeat(40) });
    expect(updated?.jwtSecret).toBe("t".repeat(40));
  });

  it("clears clearable fields on explicit null, preserves on absent", async () => {
    const created = await createTemplate({
      ...validInput,
      category: "travel",
      icon: "✈️",
      requiredPlan: undefined,
      freeDailyQuota: 10,
    });
    // Absent keys preserve.
    const kept = await updateTemplate(created.id, { name: "Still gated quota" });
    expect(kept?.category).toBe("travel");
    expect(kept?.icon).toBe("✈️");
    expect(kept?.freeDailyQuota).toBe(10);
    // Explicit null clears.
    const cleared = await updateTemplate(created.id, {
      category: null,
      icon: null,
      freeDailyQuota: null,
    });
    expect(cleared?.category).toBeUndefined();
    expect(cleared?.icon).toBeUndefined();
    expect(cleared?.freeDailyQuota).toBeUndefined();
  });

  it("validates the merged row (rejection throws)", async () => {
    const created = await createTemplate(validInput);
    await expect(
      updateTemplate(created.id, { endpoint: "not-a-url" }),
    ).rejects.toThrow();
  });

  it("rejects a merged row where quota + plan gate conflict", async () => {
    const created = await createTemplate({ ...validInput, freeDailyQuota: 10 });
    await expect(
      updateTemplate(created.id, { requiredPlan: "pro" }),
    ).rejects.toThrow();
  });
});

describe("deleteTemplate + countTemplateInstalls", () => {
  it("deletes a template and returns true; false when missing", async () => {
    const created = await createTemplate(validInput);
    expect(await deleteTemplate(created.id)).toBe(true);
    expect(await getTemplate(created.id)).toBeNull();
    expect(await deleteTemplate("nonexistent")).toBe(false);
  });

  it("countTemplateInstalls counts installed copies across orgs", async () => {
    const created = await createTemplate(validInput);
    expect(await countTemplateInstalls(created.id)).toBe(0);
    await installTemplate(created, TEST_ORG);
    await installTemplate(created, OTHER_ORG);
    expect(await countTemplateInstalls(created.id)).toBe(2);
  });

  it("deleting a template tombstones installed copies (listed, not runnable)", async () => {
    const created = await createTemplate(validInput);
    const { agent } = await installTemplate(created, TEST_ORG);
    await deleteTemplate(created.id);
    // The row survives as a tombstone — still listed so past
    // conversations remain browsable.
    const agents = await listAgents(TEST_ORG);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(agent.id);
    expect(agents[0].sourceTemplateId).toBe(created.id);
    expect(agents[0].templateRemovedAt).toBeTruthy();
    // And the public shape keeps the flag too.
    const pub = toPublicAgent(agents[0]);
    expect(pub.templateRemovedAt).toBeTruthy();
    expect("endpoint" in pub).toBe(false);
  });

  it("getTemplatesByIds resolves a batch and omits missing ids", async () => {
    const a = await createTemplate({ ...validInput, slug: "a" });
    const b = await createTemplate({ ...validInput, slug: "b" });
    const found = await getTemplatesByIds([a.id, b.id, "missing-id"]);
    expect(found).toHaveLength(2);
    expect(found.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(await getTemplatesByIds([])).toEqual([]);
  });
});

describe("installTemplate (idempotent upsert)", () => {
  it("creates an agent stamped with source_template_id + copied config", async () => {
    const template = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      jwtScopes: ["agents:run"],
    });
    const result = await installTemplate(template, TEST_ORG);
    expect(result.installed).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.agent.id).toMatch(/^[0-9a-f]{12}$/);
    expect(result.agent.name).toBe(template.name);
    expect(result.agent.endpoint).toBe(template.endpoint);
    expect(result.agent.authMode).toBe("jwt");
    expect(result.agent.jwtSecret).toBe("s".repeat(32));
    expect(result.agent.jwtScopes).toEqual(["agents:run"]);
    expect(result.agent.sourceTemplateId).toBe(template.id);
    expect(result.agent.installedTemplateUpdatedAt).toBe(template.updatedAt);

    // Scoped to the installing org only.
    expect(await listAgents(OTHER_ORG)).toHaveLength(0);
  });

  it("re-install re-syncs config onto the SAME agent row (id preserved)", async () => {
    const template = await createTemplate(validInput);
    const first = await installTemplate(template, TEST_ORG);
    const originalId = first.agent.id;

    // Curator fixes the endpoint + rotates the secret.
    const updatedTemplate = await updateTemplate(template.id, {
      endpoint: "http://localhost:9000/agent",
      jwtSecret: "rotated".padEnd(32, "x"),
    });

    const second = await installTemplate(updatedTemplate!, TEST_ORG);
    expect(second.installed).toBe(false);
    expect(second.updated).toBe(true);
    expect(second.agent.id).toBe(originalId);
    expect(second.agent.endpoint).toBe("http://localhost:9000/agent");
    expect(second.agent.jwtSecret).toBe("rotated".padEnd(32, "x"));
    expect(await listAgents(TEST_ORG)).toHaveLength(1);
  });

  it("re-install with no template change reports updated: false", async () => {
    const template = await createTemplate(validInput);
    await installTemplate(template, TEST_ORG);
    const again = await installTemplate(template, TEST_ORG);
    expect(again.installed).toBe(false);
    expect(again.updated).toBe(false);
  });

  it("installs into different orgs produce distinct agent rows", async () => {
    const template = await createTemplate(validInput);
    const a = await installTemplate(template, TEST_ORG);
    const b = await installTemplate(template, OTHER_ORG);
    expect(a.agent.id).not.toBe(b.agent.id);
    expect(await findInstalledAgentId(template.id, TEST_ORG)).toBe(a.agent.id);
    expect(await findInstalledAgentId(template.id, OTHER_ORG)).toBe(b.agent.id);
    expect(await findInstalledAgentId("missing-template", TEST_ORG)).toBeNull();
  });
});

describe("getRunUsage (rolling 24h window)", () => {
  async function seedRun(opts: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    orgId?: string;
    ageHours: number;
  }) {
    await query(
      `INSERT INTO thread_metadata (thread_id, agent_id, user_id, org_id)
       VALUES ($1, $2, $3, $4)`,
      [opts.threadId, opts.agentId, opts.userId, opts.orgId ?? TEST_ORG],
    );
    await query(
      `INSERT INTO agent_runs (thread_id, run_id, created_at)
       VALUES ($1, $2, now() - ($3 || ' hours')::interval)`,
      [opts.threadId, opts.runId, String(opts.ageHours)],
    );
  }

  it("counts runs joined via thread_metadata for the user + agent", async () => {
    await seedRun({ threadId: "t1", runId: "r1", userId: "u1", agentId: "a1", ageHours: 1 });
    await seedRun({ threadId: "t2", runId: "r2", userId: "u1", agentId: "a1", ageHours: 2 });
    const usage = await getRunUsage("u1", "a1");
    expect(usage.count).toBe(2);
    expect(usage.oldestAt).not.toBeNull();
  });

  it("excludes other users, other agents, and runs outside the window", async () => {
    await seedRun({ threadId: "t1", runId: "r1", userId: "u1", agentId: "a1", ageHours: 1 });
    // Different user.
    await seedRun({ threadId: "t2", runId: "r2", userId: "u2", agentId: "a1", ageHours: 1 });
    // Different agent.
    await seedRun({ threadId: "t3", runId: "r3", userId: "u1", agentId: "a2", ageHours: 1 });
    // Too old (25h > 24h window).
    await seedRun({ threadId: "t4", runId: "r4", userId: "u1", agentId: "a1", ageHours: 25 });
    const usage = await getRunUsage("u1", "a1");
    expect(usage.count).toBe(1);
  });

  it("returns zero + null oldest when there are no runs", async () => {
    const usage = await getRunUsage("nobody", "nothing");
    expect(usage.count).toBe(0);
    expect(usage.oldestAt).toBeNull();
  });

  it("honors a custom window size", async () => {
    await seedRun({ threadId: "t1", runId: "r1", userId: "u1", agentId: "a1", ageHours: 2 });
    expect((await getRunUsage("u1", "a1", 60 * 60 * 1000)).count).toBe(0);
    expect((await getRunUsage("u1", "a1", 3 * 60 * 60 * 1000)).count).toBe(1);
  });
});

import { describe, it, expect, beforeEach, afterAll, afterEach, beforeAll, vi } from "vitest";
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  countAgents,
  createAgentBodySchema,
  updateAgentBodySchema,
  generateAgentId,
  toPublicAgent,
} from "./agent-store";
import type { CreateAgentInput } from "./agent-store";
import { runMigrations } from "@/lib/db/migrate";
import { query, withTransaction } from "@/lib/db/pg";
import { useRealPostgres } from "@/lib/db/test-postgres";
import type { AgentEntry } from "./agents.config";

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

  it("rejects empty or whitespace-only description", () => {
    expect(
      createAgentBodySchema.safeParse({ ...validInput, description: "" }).success,
    ).toBe(false);
    expect(
      createAgentBodySchema.safeParse({ ...validInput, description: "   " }).success,
    ).toBe(false);
  });

  it("trims description", () => {
    const result = createAgentBodySchema.safeParse({
      ...validInput,
      description: "  padded  ",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.description).toBe("padded");
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

  it("round-trips the requirements snapshot through the store — including model.requiresKey (zod must not strip undeclared keys)", async () => {
    // This is the test that pins the c44983f class of bug: a zod schema
    // that fails to declare model.requiresKey strips it on BOTH the write
    // (agentRowSchema.parse) and the read (parseRequirements), and every
    // downstream consumer — the run gate's keyless check — sees a legacy
    // snapshot. Assert the full shape survives a write + read.
    const requirements = {
      model: {
        provider: "ollama",
        id: "llama3:8b",
        platformTier: false,
        requiresKey: false,
        depKey: null,
        name: "Ollama",
      },
      tools: [
        {
          name: "web_search",
          requiresKey: null,
          provider: "duckduckgo",
          platformFallback: false,
          credentials: [],
        },
      ],
      connectors: [],
    };
    const created = await createAgent(
      { ...validInput, origin: "builder", requirements },
      TEST_ORG,
    );
    const loaded = await getAgent(created.id, TEST_ORG);
    expect(loaded?.requirements).toEqual(requirements);
  });

  it("keeps requiresKey absent on read when omitted (no default injected)", async () => {
    // `in` + undefined: a default(true/false) in the schema would make
    // requiresKey PRESENT on the parsed output; the gate's undefined-means-
    // keyed contract requires it to be absent. depKey and name, by
    // contrast, are REQUIRED now — a snapshot without them fails to parse
    // (stale-snapshot fail-closed), it is never silently reshaped.
    const requirements = {
      model: {
        provider: "openai",
        id: "gpt-4o-mini",
        platformTier: true,
        depKey: "openai_api_key",
        name: "OpenAIChat",
      },
      tools: [],
      connectors: [],
    };
    const created = await createAgent(
      { ...validInput, origin: "builder", requirements },
      TEST_ORG,
    );
    const loaded = await getAgent(created.id, TEST_ORG);
    expect(loaded?.requirements).toEqual(requirements);
    expect("requiresKey" in (loaded?.requirements?.model ?? {})).toBe(false);
  });

  it("fails closed on a pre-door snapshot: the blob fails the schema and reads back as undefined", async () => {
    // THE load-bearing rejection, pinned at the store level: a snapshot
    // written before depKey/name were required (exactly what an upgrade
    // leaves behind) must FAIL to parse — never be silently reshaped into
    // something runnable. The run gate blocks builder agents whose
    // requirements read back undefined, so this test guards the first link
    // of the fail-closed chain; if someone later makes depKey/name
    // optional (or adds a default), this is the test that fails.
    const created = await createAgent({ ...validInput, origin: "builder" }, TEST_ORG);
    await query(
      `UPDATE agents SET requirements = $1 WHERE id = $2`,
      [
        JSON.stringify({
          model: { provider: "openai", id: "gpt-4o-mini", platformTier: true },
          tools: [],
          connectors: [],
        }),
        created.id,
      ],
    );
    const loaded = await getAgent(created.id, TEST_ORG);
    expect(loaded?.requirements).toBeUndefined();
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

  it("rejects an empty description on the merged row", async () => {
    const created = await createAgent(validInput, TEST_ORG);
    await expect(
      updateAgent(created.id, { description: "" }, TEST_ORG),
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

describe("countAgents (live agents — tombstones excluded)", () => {
  it("counts manually-added + catalog-installed agents", async () => {
    expect(await countAgents(TEST_ORG)).toBe(0);
    await createAgent(validInput, TEST_ORG);
    expect(await countAgents(TEST_ORG)).toBe(1);
  });

  it("excludes tombstones (deleted templates kept for history)", async () => {
    await createAgent(validInput, TEST_ORG);
    // A tombstone row: catalog install whose template was deleted.
    await query(
      `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode, source_template_id, template_deleted_at)
       VALUES ('tombstone01', 'Ghost', 'removed', 'http://localhost:8002/agent', $1, 'none', 'tpl-gone', now())`,
      [TEST_ORG],
    );
    expect(await countAgents(TEST_ORG)).toBe(1);
    // but listAgents still surfaces it (sidebar history browsing)
    expect(await listAgents(TEST_ORG)).toHaveLength(2);
  });

  it("scopes by org", async () => {
    await createAgent(validInput, OTHER_ORG);
    expect(await countAgents(TEST_ORG)).toBe(0);
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

describe("jwt secret preservation on update (undecryptable ciphertext)", () => {
  // Each test spies on console.error (decrypt failures are expected and
  // loud). Restore in afterEach so a failing assertion can't leak the
  // mock into the rest of the file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves UNDECRYPTABLE stored ciphertext byte-for-byte when the patch omits jwtSecret", async () => {
    // SECURITY rule: test the bypass attempt. The old behavior wrote NULL
    // whenever the merged row had no USABLE secret — and rowToEntry
    // degrades an undecryptable ciphertext to secret-less — so an
    // unrelated edit (a rename) silently DESTROYED the stored ciphertext
    // (key rotation / backup mismatch), unrecoverable even after the key
    // is restored. The fixture below never decrypts under the test key,
    // so under the old behavior this assertion fails: the column would
    // read NULL instead of the preserved bytes.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await createAgent(
      { ...validInput, authMode: "jwt", jwtSecret: "s".repeat(32) },
      TEST_ORG,
    );
    const GARBAGE = "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==";
    await query(
      `UPDATE agents SET jwt_secret = $1 WHERE id = $2 AND org_id = $3`,
      [GARBAGE, created.id, TEST_ORG],
    );

    const updated = await updateAgent(created.id, { name: "Renamed" }, TEST_ORG);
    expect(updated?.name).toBe("Renamed");

    // Byte-for-byte preserved — NOT nulled, NOT re-encrypted.
    const raw = await query<{ jwt_secret: string | null }>(
      `SELECT jwt_secret FROM agents WHERE id = $1 AND org_id = $2`,
      [created.id, TEST_ORG],
    );
    expect(raw.rows[0].jwt_secret).toBe(GARBAGE);
    // And the read-path contract is unchanged: the row still DEGRADES to
    // secret-less rather than surfacing garbage as a secret.
    expect((await getAgent(created.id, TEST_ORG))?.jwtSecret).toBeUndefined();
  });

  it("preserves undecryptable ciphertext under bypassOrgScope too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await createAgent(
      { ...validInput, authMode: "jwt", jwtSecret: "s".repeat(32) },
      TEST_ORG,
    );
    const GARBAGE = "enc:v1:BBBBBBBBBBBBBBBB:BBBB:BBBBBBBBBBBBBBBBBBBBBB==";
    await query(
      `UPDATE agents SET jwt_secret = $1 WHERE id = $2 AND org_id = $3`,
      [GARBAGE, created.id, TEST_ORG],
    );

    const updated = await updateAgent(
      created.id,
      { description: "Admin-side edit" },
      OTHER_ORG,
      { bypassOrgScope: true },
    );
    expect(updated?.description).toBe("Admin-side edit");

    const raw = await query<{ jwt_secret: string | null }>(
      `SELECT jwt_secret FROM agents WHERE id = $1`,
      [created.id],
    );
    expect(raw.rows[0].jwt_secret).toBe(GARBAGE);
  });

  it("a patch supplying a new secret REPLACES undecryptable ciphertext (recovery path)", async () => {
    // Preservation must not be a trap: entering a fresh secret is the
    // documented recovery from an undecryptable row, and it must win.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await createAgent(
      { ...validInput, authMode: "jwt", jwtSecret: "s".repeat(32) },
      TEST_ORG,
    );
    await query(
      `UPDATE agents SET jwt_secret = 'enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==' WHERE id = $1 AND org_id = $2`,
      [created.id, TEST_ORG],
    );
    const newSecret = "t".repeat(32);
    const updated = await updateAgent(created.id, { jwtSecret: newSecret }, TEST_ORG);
    expect(updated?.jwtSecret).toBe(newSecret);
    expect((await getAgent(created.id, TEST_ORG))?.jwtSecret).toBe(newSecret);
  });
});

describe("updateAgent concurrency (real Postgres)", () => {
  // pg-mem has no row locking, so only real Postgres can prove that
  // updateAgent's SELECT ... FOR UPDATE is a real serialization point
  // (same shape as the updateTemplate tests these are ported from).
  it("serializes concurrent renames of the same agent — both survive (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      // The container persists across this file's real-PG tests (and
      // beforeEach's cleanup runs against pg-mem, not here) — clear the
      // table this test touches.
      await query(`DELETE FROM agents`);
      const created = await createAgent(
        { ...validInput, authMode: "jwt", jwtSecret: "s".repeat(32) },
        TEST_ORG,
      );

      // Hold the agent row's lock from OUTSIDE both renames so each one's
      // read-merge-write QUEUES behind it. Under the fix each call blocks
      // at its SELECT ... FOR UPDATE and reads only after the previous
      // writer committed — both resolve (no 55P03 lock-timeout failure)
      // and the final row is one complete serialized write, with the
      // stored secret intact. NOTE: for two same-field renames this is a
      // concurrency smoke test, not a lost-update detector — two unlocked
      // renames of the SAME name field happen to converge, and the secret
      // both writers carry decrypts identically. The test that actually
      // fails without the FOR UPDATE (stale write-back clobbers a
      // DIFFERENT field's fresh value) is the rename + secret re-save
      // case below.
      let pending!: Promise<(AgentEntry | null)[]>;
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT id FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [created.id, TEST_ORG],
        );
        pending = Promise.all([
          updateAgent(created.id, { name: "Rename One" }, TEST_ORG),
          updateAgent(created.id, { name: "Rename Two" }, TEST_ORG),
        ]);
        // Give both updates time to reach their lock wait, then release
        // the holder (COMMIT) — from here the updates proceed one at a
        // time, the second merging over the first's committed row.
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      const [one, two] = await pending;
      expect(one).not.toBeNull();
      expect(two).not.toBeNull();
      const after = await getAgent(created.id, TEST_ORG);
      expect(after?.name === "Rename One" || after?.name === "Rename Two").toBe(true);
      // THE assertion: the renames' write-backs didn't clobber the stored
      // secret with stale pre-read bytes.
      expect(after?.jwtSecret).toBe("s".repeat(32));
    } finally {
      restore();
    }
  });

  it("serializes a concurrent rename + secret re-save — both survive (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      await query(`DELETE FROM agents`);
      const created = await createAgent(
        { ...validInput, authMode: "jwt", jwtSecret: "s".repeat(32) },
        TEST_ORG,
      );

      // Hold the agent row's lock from OUTSIDE both updates so each one's
      // read-merge-write QUEUES behind it. Under the fix each call blocks
      // at its SELECT ... FOR UPDATE and reads only after the previous
      // writer committed. (Unserialized, both calls read the ORIGINAL row
      // before either write — the rename's write-back then carries the
      // stale pre-save secret bytes and the just-saved secret is silently
      // destroyed.)
      let pending!: Promise<(AgentEntry | null)[]>;
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT id FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [created.id, TEST_ORG],
        );
        pending = Promise.all([
          updateAgent(created.id, { name: "Renamed" }, TEST_ORG),
          updateAgent(created.id, { jwtSecret: "t".repeat(32) }, TEST_ORG),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      const [renamed, secreted] = await pending;
      expect(renamed).not.toBeNull();
      expect(secreted).not.toBeNull();
      // THE assertion: both concurrent edits landed — the rename AND the
      // new secret decrypt (the rename didn't carry back the old secret).
      const after = await getAgent(created.id, TEST_ORG);
      expect(after?.name).toBe("Renamed");
      expect(after?.jwtSecret).toBe("t".repeat(32));
    } finally {
      restore();
    }
  });

  it("the agents row lock is a real serialization point: a competing FOR UPDATE waits, then times out (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      await query(`DELETE FROM agents`);
      const created = await createAgent(validInput, TEST_ORG);
      // tx1 takes updateAgent's lock and holds it; tx2 — the same shape of
      // statement the update runs — must block on that row. Proves FOR
      // UPDATE genuinely conflicts across connections (pg-mem has no
      // locking, so only real Postgres can answer this).
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT id FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [created.id, TEST_ORG],
        );
        await expect(
          withTransaction(async (competing) => {
            // Transaction-local so nothing outlives this tx.
            await competing.query(`SET LOCAL lock_timeout = '250ms'`);
            await competing.query(
              `SELECT id FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE`,
              [created.id, TEST_ORG],
            );
          }),
        ).rejects.toMatchObject({ code: "55P03" }); // lock_not_available
      });
    } finally {
      restore();
    }
  });
});

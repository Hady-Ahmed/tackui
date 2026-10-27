import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  upsertConnector,
  listConnectors,
  getConnectorsByNames,
  deleteConnector,
  toPublicConnector,
} from "./connector-store";
import { runMigrations } from "@/lib/db/migrate";
import { query } from "@/lib/db/pg";

const ORG = "conn-org-1";
const OTHER_ORG = "conn-org-2";

// Deterministic 32-byte hex key — store round-trips run with encryption
// enabled (reads decrypt transparently).
const ENCRYPTION_TEST_KEY = "cd".repeat(32);

beforeAll(() => {
  vi.stubEnv("DB_ENCRYPTION_KEY", ENCRYPTION_TEST_KEY);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

async function cleanup() {
  await query(`DELETE FROM connectors WHERE org_id = ANY($1)`, [
    [ORG, OTHER_ORG],
  ]);
}

beforeEach(async () => {
  await runMigrations();
  await cleanup();
});

describe("upsertConnector", () => {
  it("creates a connector and returns a sanitized record (no token)", async () => {
    const c = await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/github",
    });
    expect(c.id).toMatch(/[0-9a-f-]{36}/);
    expect(c.orgId).toBe(ORG);
    expect(c.name).toBe("github-mcp");
    expect(c.url).toBe("https://mcp.example.com/github");
    expect(c.token).toBe("");
    const pub = toPublicConnector(c);
    expect(pub.hasToken).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("token\":");
  });

  it("stores the token encrypted at rest and decrypts on read", async () => {
    await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/github",
      token: "ghp_secret_token",
    });
    const stored = await query<{ token: string }>(
      `SELECT token FROM connectors WHERE org_id = $1 AND name = 'github-mcp'`,
      [ORG],
    );
    expect(stored.rows[0].token).toMatch(/^enc:v1:/);
    expect(stored.rows[0].token).not.toContain("ghp_secret_token");
    const [c] = await listConnectors(ORG);
    expect(c.token).toBe("ghp_secret_token");
    expect(toPublicConnector(c).hasToken).toBe(true);
  });

  it("allows a connector without a token (open endpoint)", async () => {
    const c = await upsertConnector({
      orgId: ORG,
      name: "public-mcp",
      url: "https://mcp.example.com/open",
      token: "",
    });
    expect(c.token).toBe("");
  });

  it("replaces the token on update", async () => {
    await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/github",
      token: "old-token",
    });
    const c = await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/v2",
      token: "new-token",
    });
    expect(c.url).toBe("https://mcp.example.com/v2");
    expect(c.token).toBe("new-token");
    const all = await listConnectors(ORG);
    expect(all).toHaveLength(1);
  });

  it("preserves the stored token when the update omits it", async () => {
    await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/github",
      token: "keep-me",
    });
    // Edit the URL without re-typing the secret.
    const c = await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/moved",
    });
    expect(c.token).toBe("keep-me");
  });

  it("clears the token with an explicit empty string", async () => {
    await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/github",
      token: "bye",
    });
    const c = await upsertConnector({
      orgId: ORG,
      name: "github-mcp",
      url: "https://mcp.example.com/github",
      token: "",
    });
    expect(c.token).toBe("");
  });

  it("rejects a non-http(s) URL (zod)", async () => {
    await expect(
      upsertConnector({ orgId: ORG, name: "x", url: "ftp://mcp.example.com" }),
    ).rejects.toThrow();
  });

  it("rejects a whitespace name (zod)", async () => {
    await expect(
      upsertConnector({ orgId: ORG, name: "   ", url: "https://mcp.example.com" }),
    ).rejects.toThrow();
  });

  it("rejects an invalid URL outright (zod)", async () => {
    await expect(
      upsertConnector({ orgId: ORG, name: "x", url: "not-a-url" }),
    ).rejects.toThrow();
  });

  it("rejects an unsafe connector name (zod)", async () => {
    await expect(
      upsertConnector({
        orgId: ORG,
        name: "has spaces",
        url: "https://mcp.example.com",
      }),
    ).rejects.toThrow();
  });
});

describe("listConnectors / getConnectorsByNames", () => {
  it("lists only the owning org's connectors, sorted by name", async () => {
    await upsertConnector({ orgId: ORG, name: "b-conn", url: "https://b.example.com" });
    await upsertConnector({ orgId: ORG, name: "a-conn", url: "https://a.example.com" });
    await upsertConnector({
      orgId: OTHER_ORG,
      name: "foreign",
      url: "https://foreign.example.com",
    });
    const all = await listConnectors(ORG);
    expect(all.map((c) => c.name)).toEqual(["a-conn", "b-conn"]);
  });

  it("getConnectorsByNames resolves only the requested names in-org", async () => {
    await upsertConnector({ orgId: ORG, name: "github-mcp", url: "https://g.example.com", token: "t1" });
    await upsertConnector({ orgId: OTHER_ORG, name: "github-mcp", url: "https://foreign.example.com" });
    const map = await getConnectorsByNames(ORG, ["github-mcp"]);
    expect(map.size).toBe(1);
    expect(map.get("github-mcp")?.url).toBe("https://g.example.com");
    expect(map.get("github-mcp")?.token).toBe("t1");
  });

  it("getConnectorsByNames returns an empty map for an empty list", async () => {
    expect((await getConnectorsByNames(ORG, [])).size).toBe(0);
  });

  it("getConnectorsByNames skips names that don't exist", async () => {
    const map = await getConnectorsByNames(ORG, ["nope"]);
    expect(map.size).toBe(0);
  });
});

describe("deleteConnector", () => {
  it("deletes the org's connector and returns true", async () => {
    await upsertConnector({ orgId: ORG, name: "github-mcp", url: "https://g.example.com" });
    expect(await deleteConnector(ORG, "github-mcp")).toBe(true);
    expect(await listConnectors(ORG)).toHaveLength(0);
  });

  it("returns false for a foreign or missing connector", async () => {
    await upsertConnector({ orgId: ORG, name: "github-mcp", url: "https://g.example.com" });
    // Same name, different org — must not be deleted.
    expect(await deleteConnector(OTHER_ORG, "github-mcp")).toBe(false);
    expect(await listConnectors(ORG)).toHaveLength(1);
    expect(await deleteConnector(ORG, "missing")).toBe(false);
  });
});

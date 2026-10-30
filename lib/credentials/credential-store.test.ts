import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  setCredential,
  listCredentials,
  getCredentialFields,
  getCredentialSecrets,
  deleteCredential,
} from "./credential-store";
import { runMigrations } from "@/lib/db/migrate";
import { query } from "@/lib/db/pg";

const USER = "cred-user-1";
const OTHER_USER = "cred-user-2";

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
  await query(`DELETE FROM credentials WHERE user_id = ANY($1)`, [
    [USER, OTHER_USER],
  ]);
}

beforeEach(async () => {
  await runMigrations();
  await cleanup();
});

describe("setCredential", () => {
  it("stores the field map and returns an existence record (no secret)", async () => {
    const stored = await setCredential({
      userId: USER,
      provider: "tavily",
      kind: "tool",
      fields: { api_key: "tvly-abc123" },
    });
    expect(stored.provider).toBe("tavily");
    expect(stored.kind).toBe("tool");
    expect(stored.userId).toBe(USER);
    // Field NAMES only — the values are write-only.
    expect(stored.fields).toEqual(["api_key"]);
    expect(JSON.stringify(stored)).not.toContain("tvly-abc123");
  });

  it("stores multi-credential toolkits as a named field map", async () => {
    const stored = await setCredential({
      userId: USER,
      provider: "x",
      kind: "tool",
      fields: {
        consumer_key: "ck",
        consumer_secret: "cs",
        access_token: "at",
        access_token_secret: "ats",
      },
    });
    expect(stored.fields.sort()).toEqual([
      "access_token",
      "access_token_secret",
      "consumer_key",
      "consumer_secret",
    ]);
    expect(JSON.stringify(stored)).not.toContain("ck");
  });

  it("accepts any catalog-declared provider (the catalog is derived, not enumerated here)", async () => {
    // Providers are not hardcoded in the store — whatever the derived
    // catalog sends (e.g. a newly added platform provider) gets stored.
    const stored = await setCredential({
      userId: USER,
      provider: "new-platform-provider",
      kind: "tool",
      fields: { api_key: "np-x" },
    });
    expect(stored.provider).toBe("new-platform-provider");
    expect(await getCredentialFields(USER, "new-platform-provider")).toEqual({
      api_key: "np-x",
    });
  });

  it("rotates on re-set (upsert, no duplicate row)", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", fields: { api_key: "first" } });
    await setCredential({ userId: USER, provider: "openai", kind: "llm", fields: { api_key: "second" } });
    const rows = await query<{ fields: Record<string, string> }>(
      `SELECT fields FROM credentials WHERE user_id = $1 AND provider = 'openai'`,
      [USER],
    );
    expect(rows.rows).toHaveLength(1);
    // Reads decrypt transparently — the stored value is the rotated one.
    expect(await getCredentialFields(USER, "openai")).toEqual({ api_key: "second" });
  });

  it("keeps users isolated (same provider, different users)", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", fields: { api_key: "u1-key" } });
    await setCredential({
      userId: OTHER_USER,
      provider: "openai",
      kind: "llm",
      fields: { api_key: "u2-key" },
    });
    expect(await getCredentialFields(USER, "openai")).toEqual({ api_key: "u1-key" });
    expect(await getCredentialFields(OTHER_USER, "openai")).toEqual({ api_key: "u2-key" });
  });

  it("rejects an empty/whitespace field value", async () => {
    await expect(
      setCredential({ userId: USER, provider: "tavily", kind: "tool", fields: { api_key: "   " } }),
    ).rejects.toThrow('Credential field "api_key" must not be empty');
  });

  it("rejects an empty field map", async () => {
    await expect(
      setCredential({ userId: USER, provider: "tavily", kind: "tool", fields: {} }),
    ).rejects.toThrow("Credential must carry at least one field");
  });

  it("rejects a malformed field name (zod — the wire dep key derives from it)", async () => {
    await expect(
      setCredential({
        userId: USER,
        provider: "tavily",
        kind: "tool",
        fields: { "not a field!": "x" },
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-slug provider (zod)", async () => {
    await expect(
      setCredential({ userId: USER, provider: "not a provider!", kind: "tool", fields: { api_key: "x" } }),
    ).rejects.toThrow();
  });

  it("rejects an empty provider (zod)", async () => {
    await expect(
      setCredential({ userId: USER, provider: "", kind: "tool", fields: { api_key: "x" } }),
    ).rejects.toThrow();
  });

  it("rejects an over-length provider (zod)", async () => {
    await expect(
      setCredential({
        userId: USER,
        provider: "x".repeat(65),
        kind: "tool",
        fields: { api_key: "x" },
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown kind (zod)", async () => {
    await expect(
      setCredential({
        userId: USER,
        provider: "tavily",
        kind: "db" as "tool",
        fields: { api_key: "x" },
      }),
    ).rejects.toThrow();
  });
});

describe("listCredentials", () => {
  it("returns an empty list when nothing is stored", async () => {
    expect(await listCredentials(USER)).toEqual([]);
  });

  it("lists stored providers with field names only (no values)", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", fields: { api_key: "sk-1" } });
    await setCredential({
      userId: USER,
      provider: "x",
      kind: "tool",
      fields: { consumer_key: "ck", access_token: "at" },
    });
    const creds = await listCredentials(USER);
    expect(creds).toHaveLength(2);
    expect(creds.map((c) => c.provider).sort()).toEqual(["openai", "x"]);
    const xRow = creds.find((c) => c.provider === "x");
    expect(xRow?.fields.sort()).toEqual(["access_token", "consumer_key"]);
    expect(JSON.stringify(creds)).not.toContain("sk-1");
    expect(JSON.stringify(creds)).not.toContain("ck");
  });

  it("only lists the calling user's credentials", async () => {
    await setCredential({
      userId: OTHER_USER,
      provider: "openai",
      kind: "llm",
      fields: { api_key: "x" },
    });
    expect(await listCredentials(USER)).toEqual([]);
  });

  it("keeps serving rows for providers that left the catalog (deletion must never lock a key in)", async () => {
    // A provider removed from the platform catalog: the saved row is
    // still stored, still listed, still decryptable — the store is
    // catalog-agnostic by design.
    await setCredential({ userId: USER, provider: "removed-provider", kind: "tool", fields: { api_key: "gone" } });
    expect(await listCredentials(USER)).toHaveLength(1);
    expect(await getCredentialFields(USER, "removed-provider")).toEqual({ api_key: "gone" });
  });
});

describe("getCredentialFields / getCredentialSecrets", () => {
  it("returns null when no key exists", async () => {
    expect(await getCredentialFields(USER, "tavily")).toBeNull();
  });

  it("returns the decrypted field map when present", async () => {
    await setCredential({
      userId: USER,
      provider: "tavily",
      kind: "tool",
      fields: { api_key: "tvly-live" },
    });
    expect(await getCredentialFields(USER, "tavily")).toEqual({ api_key: "tvly-live" });
  });

  it("getCredentialSecrets batches all credentials as provider → field map", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", fields: { api_key: "sk-a" } });
    await setCredential({
      userId: USER,
      provider: "x",
      kind: "tool",
      fields: { consumer_key: "ck", access_token: "at" },
    });
    const secrets = await getCredentialSecrets(USER);
    expect(secrets).toEqual({
      openai: { api_key: "sk-a" },
      x: { consumer_key: "ck", access_token: "at" },
    });
  });

  it("getCredentialSecrets skips undecryptable rows instead of throwing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setCredential({ userId: USER, provider: "openai", kind: "llm", fields: { api_key: "good" } });
    // Simulate a field ciphertext-encrypted with a different key: it carries
    // the `enc:v1:` prefix (so it's NOT legacy plaintext passthrough) but
    // the auth tag won't verify → decryptSecret throws → the field is
    // skipped, not surfaced as a garbage key.
    await query(
      `UPDATE credentials SET fields = '{"api_key": "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA=="}' WHERE user_id = $1`,
      [USER],
    );
    const secrets = await getCredentialSecrets(USER);
    expect(secrets).toEqual({});
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("deleteCredential", () => {
  it("deletes an existing key and returns true", async () => {
    await setCredential({ userId: USER, provider: "tavily", kind: "tool", fields: { api_key: "x" } });
    expect(await deleteCredential(USER, "tavily")).toBe(true);
    expect(await getCredentialFields(USER, "tavily")).toBeNull();
  });

  it("deletes a provider that is no longer in the catalog (accepts any saved provider)", async () => {
    await setCredential({
      userId: USER,
      provider: "removed-provider",
      kind: "tool",
      fields: { api_key: "x" },
    });
    expect(await deleteCredential(USER, "removed-provider")).toBe(true);
  });

  it("returns false when nothing was stored", async () => {
    expect(await deleteCredential(USER, "openai")).toBe(false);
  });

  it("does not delete other users' keys", async () => {
    await setCredential({
      userId: OTHER_USER,
      provider: "tavily",
      kind: "tool",
      fields: { api_key: "x" },
    });
    expect(await deleteCredential(USER, "tavily")).toBe(false);
    expect(await getCredentialFields(OTHER_USER, "tavily")).toEqual({ api_key: "x" });
  });
});

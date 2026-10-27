import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  setCredential,
  listCredentials,
  getCredentialSecret,
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
  it("stores a key and returns an existence record (no secret)", async () => {
    const stored = await setCredential({
      userId: USER,
      provider: "tavily",
      kind: "tool",
      secret: "tvly-abc123",
    });
    expect(stored.provider).toBe("tavily");
    expect(stored.kind).toBe("tool");
    expect(stored.userId).toBe(USER);
    expect(JSON.stringify(stored)).not.toContain("tvly-abc123");
  });

  it("accepts any catalog-declared provider (the catalog is derived, not enumerated here)", async () => {
    // Providers are not hardcoded in the store — whatever the derived
    // catalog sends (e.g. a newly added platform provider) gets stored.
    const stored = await setCredential({
      userId: USER,
      provider: "new-platform-provider",
      kind: "tool",
      secret: "np-x",
    });
    expect(stored.provider).toBe("new-platform-provider");
    expect(await getCredentialSecret(USER, "new-platform-provider")).toBe("np-x");
  });

  it("rotates the key on re-set (upsert, no duplicate row)", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", secret: "first" });
    await setCredential({ userId: USER, provider: "openai", kind: "llm", secret: "second" });
    const rows = await query<{ secret: string }>(
      `SELECT secret FROM credentials WHERE user_id = $1 AND provider = 'openai'`,
      [USER],
    );
    expect(rows.rows).toHaveLength(1);
    // Reads decrypt transparently — the stored value is the rotated one.
    expect(await getCredentialSecret(USER, "openai")).toBe("second");
  });

  it("keeps users isolated (same provider, different users)", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", secret: "u1-key" });
    await setCredential({
      userId: OTHER_USER,
      provider: "openai",
      kind: "llm",
      secret: "u2-key",
    });
    expect(await getCredentialSecret(USER, "openai")).toBe("u1-key");
    expect(await getCredentialSecret(OTHER_USER, "openai")).toBe("u2-key");
  });

  it("rejects an empty/whitespace secret", async () => {
    await expect(
      setCredential({ userId: USER, provider: "tavily", kind: "tool", secret: "   " }),
    ).rejects.toThrow("Credential secret must not be empty");
  });

  it("rejects a non-slug provider (zod)", async () => {
    await expect(
      setCredential({ userId: USER, provider: "not a provider!", kind: "tool", secret: "x" }),
    ).rejects.toThrow();
  });

  it("rejects an empty provider (zod)", async () => {
    await expect(
      setCredential({ userId: USER, provider: "", kind: "tool", secret: "x" }),
    ).rejects.toThrow();
  });

  it("rejects an over-length provider (zod)", async () => {
    await expect(
      setCredential({
        userId: USER,
        provider: "x".repeat(65),
        kind: "tool",
        secret: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown kind (zod)", async () => {
    await expect(
      setCredential({
        userId: USER,
        provider: "tavily",
        kind: "db" as "tool",
        secret: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("listCredentials", () => {
  it("returns an empty list when nothing is stored", async () => {
    expect(await listCredentials(USER)).toEqual([]);
  });

  it("lists stored providers without leaking secrets", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", secret: "sk-1" });
    await setCredential({ userId: USER, provider: "tavily", kind: "tool", secret: "tvly-2" });
    const creds = await listCredentials(USER);
    expect(creds).toHaveLength(2);
    expect(creds.map((c) => c.provider).sort()).toEqual(["openai", "tavily"]);
    expect(JSON.stringify(creds)).not.toContain("sk-1");
    expect(JSON.stringify(creds)).not.toContain("tvly-2");
  });

  it("only lists the calling user's credentials", async () => {
    await setCredential({
      userId: OTHER_USER,
      provider: "openai",
      kind: "llm",
      secret: "x",
    });
    expect(await listCredentials(USER)).toEqual([]);
  });

  it("keeps serving rows for providers that left the catalog (deletion must never lock a key in)", async () => {
    // A provider removed from the platform catalog: the saved row is
    // still stored, still listed, still decryptable — the store is
    // catalog-agnostic by design.
    await setCredential({ userId: USER, provider: "removed-provider", kind: "tool", secret: "gone" });
    expect(await listCredentials(USER)).toHaveLength(1);
    expect(await getCredentialSecret(USER, "removed-provider")).toBe("gone");
  });
});

describe("getCredentialSecret / getCredentialSecrets", () => {
  it("returns null when no key exists", async () => {
    expect(await getCredentialSecret(USER, "tavily")).toBeNull();
  });

  it("returns the decrypted key when present", async () => {
    await setCredential({
      userId: USER,
      provider: "tavily",
      kind: "tool",
      secret: "tvly-live",
    });
    expect(await getCredentialSecret(USER, "tavily")).toBe("tvly-live");
  });

  it("getCredentialSecrets batches all keys keyed by provider", async () => {
    await setCredential({ userId: USER, provider: "openai", kind: "llm", secret: "sk-a" });
    await setCredential({ userId: USER, provider: "tavily", kind: "tool", secret: "tvly-b" });
    const secrets = await getCredentialSecrets(USER);
    expect(secrets).toEqual({ openai: "sk-a", tavily: "tvly-b" });
  });

  it("getCredentialSecrets skips undecryptable rows instead of throwing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setCredential({ userId: USER, provider: "openai", kind: "llm", secret: "good" });
    // Simulate a row ciphertext-encrypted with a different key: it carries
    // the `enc:v1:` prefix (so it's NOT legacy plaintext passthrough) but
    // the auth tag won't verify → decryptSecret throws → the row is
    // skipped, not surfaced as a garbage key.
    await query(
      `UPDATE credentials SET secret = 'enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==' WHERE user_id = $1`,
      [USER],
    );
    const secrets = await getCredentialSecrets(USER);
    expect(secrets).toEqual({});
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("deleteCredential", () => {
  it("deletes an existing key and returns true", async () => {
    await setCredential({ userId: USER, provider: "tavily", kind: "tool", secret: "x" });
    expect(await deleteCredential(USER, "tavily")).toBe(true);
    expect(await getCredentialSecret(USER, "tavily")).toBeNull();
  });

  it("deletes a provider that is no longer in the catalog (accepts any saved provider)", async () => {
    await setCredential({
      userId: USER,
      provider: "removed-provider",
      kind: "tool",
      secret: "x",
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
      secret: "x",
    });
    expect(await deleteCredential(USER, "tavily")).toBe(false);
    expect(await getCredentialSecret(OTHER_USER, "tavily")).toBe("x");
  });
});

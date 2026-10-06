import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EncryptModule = typeof import("./encrypt");

// 64 hex chars = 32 bytes
const VALID_KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);

// loadKey caches per module instance — reset the module registry before
// each test so every scenario starts with a fresh key cache.
async function loadModule(): Promise<EncryptModule> {
  return await import("./encrypt");
}

beforeEach(() => {
  vi.resetModules();
  // Default to "unset" so a developer's exported DB_ENCRYPTION_KEY
  // can't leak into test behavior; individual tests stub a real key.
  vi.stubEnv("DB_ENCRYPTION_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("encryptSecret / decryptSecret round-trip", () => {
  it("encrypts and decrypts a secret", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { encryptSecret, decryptSecret } = await loadModule();
    const plain = "my-super-secret-jwt-key-0123456789abcdef";
    const stored = encryptSecret(plain);
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain(plain);
    expect(decryptSecret(stored)).toBe(plain);
  });

  it("produces unique ciphertext per call (random IV)", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { encryptSecret, decryptSecret } = await loadModule();
    const plain = "x".repeat(40);
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it("round-trips secrets containing special characters and newlines", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { encryptSecret, decryptSecret } = await loadModule();
    const plain = "p@$$w0rd\nwith\"quotes'\rand\ttabs—unicode ✓";
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });
});

describe("decryptSecret failure modes", () => {
  it("throws when the ciphertext was tampered with", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { encryptSecret, decryptSecret } = await loadModule();
    const stored = encryptSecret("y".repeat(40));
    const [, , iv, ct, tag] = stored.split(":");
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(() => decryptSecret(`enc:v1:${iv}:${flipped}:${tag}`)).toThrow(
      /Decryption failed/,
    );
  });

  it("throws when decrypted with a different key", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { encryptSecret } = await loadModule();
    const stored = encryptSecret("z".repeat(40));
    vi.resetModules();
    vi.stubEnv("DB_ENCRYPTION_KEY", OTHER_KEY);
    const { decryptSecret } = await loadModule();
    expect(() => decryptSecret(stored)).toThrow(/different DB_ENCRYPTION_KEY/);
  });

  it("throws on a malformed encrypted value (wrong segment count)", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { decryptSecret } = await loadModule();
    expect(() => decryptSecret("enc:v1:not-enough-segments")).toThrow(
      /Malformed encrypted-secret value/,
    );
  });
});

describe("legacy plaintext passthrough", () => {
  it("decryptSecret passes un-prefixed values through unchanged", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { decryptSecret, isEncrypted } = await loadModule();
    expect(isEncrypted("raw-legacy-secret-value")).toBe(false);
    expect(decryptSecret("raw-legacy-secret-value")).toBe("raw-legacy-secret-value");
  });

  it("isEncrypted detects the versioned prefix", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { encryptSecret, isEncrypted } = await loadModule();
    expect(isEncrypted(encryptSecret("s".repeat(32)))).toBe(true);
  });
});

describe("when DB_ENCRYPTION_KEY is not set", () => {
  it("encryptSecret stores plaintext as-is (documented fallback)", async () => {
    const { encryptSecret, isEncrypted } = await loadModule();
    const plain = "p".repeat(32);
    expect(encryptSecret(plain)).toBe(plain);
    expect(isEncrypted(plain)).toBe(false);
  });

  it("decryptSecret still passes legacy plaintext through", async () => {
    const { decryptSecret } = await loadModule();
    expect(decryptSecret("still-plaintext")).toBe("still-plaintext");
  });

  it("decryptSecret refuses to decrypt encrypted values", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const { encryptSecret } = await loadModule();
    const stored = encryptSecret("q".repeat(32));
    vi.resetModules();
    vi.stubEnv("DB_ENCRYPTION_KEY", ""); // simulate key removed
    const { decryptSecret } = await loadModule();
    expect(() => decryptSecret(stored)).toThrow(/DB_ENCRYPTION_KEY is not set/);
  });
});

describe("key validation", () => {
  it("throws on a malformed key (not 32 bytes of hex)", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", "not-a-valid-hex-key");
    const { encryptSecret, decryptSecret, isEncryptionConfigured } = await loadModule();
    expect(() => isEncryptionConfigured()).toThrow(/openssl rand -hex 32/);
    expect(() => encryptSecret("x".repeat(32))).toThrow(/openssl rand -hex 32/);
    expect(() => decryptSecret("enc:v1:a:b:c")).toThrow(/openssl rand -hex 32/);
  });

  it("isEncryptionConfigured — true when set, false when unset/empty", async () => {
    vi.stubEnv("DB_ENCRYPTION_KEY", VALID_KEY);
    const configured = await loadModule();
    expect(configured.isEncryptionConfigured()).toBe(true);

    vi.resetModules();
    vi.stubEnv("DB_ENCRYPTION_KEY", "");
    const unset = await loadModule();
    expect(unset.isEncryptionConfigured()).toBe(false);
  });
});

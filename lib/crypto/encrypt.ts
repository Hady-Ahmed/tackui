import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * At-rest encryption for DB-stored secrets (agent `jwt_secret`).
 *
 * AES-256-GCM with a random 12-byte IV per write and a 16-byte auth
 * tag. Ciphertext is stored in the existing TEXT column as:
 *
 *   enc:v1:<iv_b64>:<ciphertext_b64>:<tag_b64>
 *
 * The `enc:v1:` prefix makes encrypted values self-describing and
 * versionable: legacy plaintext rows (written before DB_ENCRYPTION_KEY
 * was configured) are detected by its absence and passed through
 * unchanged on read — `lib/crypto/backfill.ts` re-encrypts them at
 * boot.
 *
 * Key management:
 * - `DB_ENCRYPTION_KEY` env var: 64 hex chars = 32 bytes
 *   (generate with `openssl rand -hex 32`), loaded lazily and cached.
 * - Unset/empty → secrets are stored as plaintext (documented
 *   fallback, loud warning at boot + once per process on write).
 * - Set but malformed → throws (boot backfill surfaces it loudly).
 * - Rotating the key invalidates existing ciphertexts (GCM auth
 *   fails) — re-save each agent's JWT secret after rotation.
 */

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// undefined = not loaded yet; null = unset (plaintext mode)
let cachedKey: Buffer | null | undefined;

/**
 * Whether encryption is configured. Throws if DB_ENCRYPTION_KEY is set
 * but malformed (so boot surfaces a bad key immediately), returns false
 * when unset/empty.
 */
export function isEncryptionConfigured(): boolean {
  return loadKey() !== null;
}

function loadKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.DB_ENCRYPTION_KEY?.trim();
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `[encrypt] DB_ENCRYPTION_KEY is malformed — expected 64 hex chars encoding ${KEY_BYTES} bytes (generate with: openssl rand -hex 32). Encryption is enforced when the variable is set; fix it or unset it to fall back to plaintext storage.`,
    );
  }
  cachedKey = key;
  return cachedKey;
}

let warnedPlaintext = false;
function warnPlaintextOnce(): void {
  if (warnedPlaintext) return;
  warnedPlaintext = true;
  console.warn(
    "[encrypt] DB_ENCRYPTION_KEY is not set — agent JWT secrets are being stored in PLAINTEXT. Set DB_ENCRYPTION_KEY (generate with: openssl rand -hex 32) to enable encryption at rest.",
  );
}

/**
 * Encrypt a secret for storage. Without DB_ENCRYPTION_KEY, returns the
 * input unchanged (documented plaintext fallback — warned once).
 */
export function encryptSecret(plain: string): string {
  const key = loadKey();
  if (!key) {
    warnPlaintextOnce();
    return plain;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${ciphertext.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

/**
 * Decrypt a stored secret. Legacy plaintext values (no `enc:v1:`
 * prefix) pass through unchanged. Throws on tampered values, wrong
 * key, or encrypted values with no key configured — callers that must
 * not crash (agent-store row mapping) catch and degrade gracefully.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const key = loadKey();
  if (!key) {
    throw new Error(
      "[encrypt] Cannot decrypt: the stored value is encrypted but DB_ENCRYPTION_KEY is not set. Restore the key it was encrypted with, or re-save the agent's JWT secret.",
    );
  }
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error(
      "[encrypt] Malformed encrypted-secret value — expected enc:v1:<iv>:<ciphertext>:<tag>.",
    );
  }
  const [ivB64, ciphertextB64, tagB64] = parts;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64"),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "[encrypt] Decryption failed — the stored secret was encrypted with a different DB_ENCRYPTION_KEY (or the value was modified). Restore the original key or re-save the agent's JWT secret.",
    );
  }
}

/**
 * Whether a stored value is encrypted (has the versioned prefix).
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

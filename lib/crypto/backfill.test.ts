import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillEncryptedSecrets } from "./backfill";
import { decryptSecret, isEncrypted } from "./encrypt";
import { query } from "@/lib/db/pg";
import { runMigrations } from "@/lib/db/migrate";

const KEY = "ef".repeat(32);
const LEGACY_SECRET = "legacy-plaintext-secret-0123456789ab";

async function insertLegacyAgent(id: string, secret: string) {
  await query(
    `INSERT INTO agents (id, name, description, endpoint, org_id, auth_mode, jwt_secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, "Legacy Agent", "inserted raw for backfill test", "http://localhost:8001/agent", "backfill-org", "jwt", secret],
  );
}

beforeAll(() => {
  vi.stubEnv("DB_ENCRYPTION_KEY", KEY);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await runMigrations();
  await query(`DELETE FROM agents`);
});

describe("backfillEncryptedSecrets", () => {
  it("is a no-op when there are no agents", async () => {
    expect(await backfillEncryptedSecrets()).toEqual({ encrypted: 0, skipped: 0 });
  });

  it("encrypts legacy plaintext rows (idempotent on re-run)", async () => {
    await insertLegacyAgent("legacy0000001", LEGACY_SECRET);
    const first = await backfillEncryptedSecrets();
    expect(first).toEqual({ encrypted: 1, skipped: 0 });

    const row = await query<{ jwt_secret: string }>(
      `SELECT jwt_secret FROM agents WHERE id = $1`,
      ["legacy0000001"],
    );
    expect(isEncrypted(row.rows[0].jwt_secret)).toBe(true);
    expect(row.rows[0].jwt_secret).not.toContain(LEGACY_SECRET);
    expect(decryptSecret(row.rows[0].jwt_secret)).toBe(LEGACY_SECRET);

    // Second run: nothing left to do
    expect(await backfillEncryptedSecrets()).toEqual({ encrypted: 0, skipped: 0 });
  });

  it("leaves already-encrypted rows untouched", async () => {
    await insertLegacyAgent("legacy0000001", LEGACY_SECRET);
    await backfillEncryptedSecrets();
    const before = await query<{ jwt_secret: string }>(
      `SELECT jwt_secret FROM agents WHERE id = $1`,
      ["legacy0000001"],
    );

    expect(await backfillEncryptedSecrets()).toEqual({ encrypted: 0, skipped: 0 });
    const after = await query<{ jwt_secret: string }>(
      `SELECT jwt_secret FROM agents WHERE id = $1`,
      ["legacy0000001"],
    );
    expect(after.rows[0].jwt_secret).toBe(before.rows[0].jwt_secret);
  });
});

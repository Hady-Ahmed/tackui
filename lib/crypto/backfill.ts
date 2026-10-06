import { query } from "@/lib/db/pg";
import { encryptSecret } from "./encrypt";

/**
 * One-time (idempotent) boot pass: re-encrypts agent `jwt_secret`
 * values written in plaintext before DB_ENCRYPTION_KEY was configured.
 * Encrypted rows (with the `enc:v1:` prefix) are filtered out by the
 * WHERE clause, so repeated boots are no-ops.
 *
 * When no key is configured, `encryptSecret` passes values through
 * unchanged and those rows are counted as skipped — the boot sequence
 * in instrumentation.ts only calls this when a key IS configured, so
 * this guard is a standalone-safety net.
 */
export interface BackfillResult {
  encrypted: number;
  skipped: number;
}

export async function backfillEncryptedSecrets(): Promise<BackfillResult> {
  const result = await query<{
    id: string;
    org_id: string;
    jwt_secret: string;
  }>(
    `SELECT id, org_id, jwt_secret
     FROM agents
     WHERE jwt_secret IS NOT NULL AND jwt_secret NOT LIKE 'enc:v1:%'`,
  );

  let encrypted = 0;
  let skipped = 0;
  for (const row of result.rows) {
    const encryptedValue = encryptSecret(row.jwt_secret);
    if (encryptedValue === row.jwt_secret) {
      skipped++;
      continue;
    }
    await query(
      `UPDATE agents SET jwt_secret = $1 WHERE id = $2 AND org_id = $3`,
      [encryptedValue, row.id, row.org_id],
    );
    encrypted++;
  }
  return { encrypted, skipped };
}

/**
 * Per-user credential store — the runner's BYOK keys for LLM providers and
 * keyed tools. Keys are encrypted at rest (lib/crypto/encrypt.ts) and never
 * leave the server except in the per-run AG-UI context delivered to the
 * AgentOS dispatcher.
 *
 * The one rule: agent definitions declare REQUIREMENTS; whoever RUNS an
 * agent brings credentials. This store is where runners keep theirs.
 * Providers are NOT enumerated here — the catalog is derived from the
 * AgentOS platform (lib/credentials/catalog.ts). This store accepts any
 * catalog-declared provider and keeps serving saved ones even after a
 * provider leaves the catalog: deletion must never lock a key in.
 *
 * GET responses (via app/api/credentials) return existence booleans only —
 * the plaintext key is write-only, same boundary discipline as
 * agents.jwtSecret.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query } from "@/lib/db/pg";
import { decryptSecret, encryptSecret } from "@/lib/crypto/encrypt";

export type CredentialKind = "llm" | "tool";

const providerSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^\w[\w-]*$/, "Provider must be a slug (letters, digits, dashes, underscores)");

const kindSchema = z.enum(["llm", "tool"]);

interface CredentialRow {
  id: string;
  user_id: string;
  provider: string;
  kind: string;
  secret: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const CREDENTIAL_SELECT = `id, user_id, provider, kind, created_at, updated_at`;

export interface StoredCredential {
  id: string;
  userId: string;
  provider: string;
  kind: CredentialKind;
  createdAt: string;
  updatedAt: string;
}

function rowToCredential(row: CredentialRow): StoredCredential {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    kind: row.kind as CredentialKind,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface SetCredentialInput {
  userId: string;
  provider: string;
  /** From the derived catalog — the kind the provider serves. */
  kind: CredentialKind;
  secret: string;
}

/**
 * Upsert the runner's key for a provider. Rotating a key = setting it
 * again; the very next run uses the new value (per-run delivery — nothing
 * is cached agent-side).
 */
export async function setCredential(
  input: SetCredentialInput,
): Promise<StoredCredential> {
  const provider = providerSchema.parse(input.provider);
  const kind = kindSchema.parse(input.kind);
  const secret = input.secret.trim();
  if (!secret) {
    throw new Error("Credential secret must not be empty");
  }
  // Encrypt at the write boundary (no-op passthrough when
  // DB_ENCRYPTION_KEY is unset — see lib/crypto/encrypt.ts).
  const encrypted = encryptSecret(secret);
  const result = await query<CredentialRow>(
    `INSERT INTO credentials (id, user_id, provider, kind, secret)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET secret = EXCLUDED.secret, kind = EXCLUDED.kind, updated_at = now()
     RETURNING ${CREDENTIAL_SELECT}`,
    [randomUUID(), input.userId, provider, kind, encrypted],
  );
  return rowToCredential(result.rows[0]);
}

/** Existence list for the credentials UI — no secrets, ever. */
export async function listCredentials(
  userId: string,
): Promise<StoredCredential[]> {
  const result = await query<CredentialRow>(
    `SELECT ${CREDENTIAL_SELECT}
     FROM credentials
     WHERE user_id = $1
     ORDER BY provider ASC`,
    [userId],
  );
  return result.rows.map(rowToCredential);
}

/**
 * The decrypted key for a provider — only consumed by the run path
 * (run gate + per-run context delivery). Returns null when the runner
 * has no key for the provider.
 */
export async function getCredentialSecret(
  userId: string,
  provider: string,
): Promise<string | null> {
  const result = await query<{ secret: string }>(
    `SELECT secret FROM credentials WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    return decryptSecret(row.secret);
  } catch (err) {
    console.error(
      "[credential-store] failed to decrypt credential secret — treating as absent",
      {
        userId,
        provider,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}

/**
 * Batch lookup for the run path: all of a runner's keys, decrypted.
 * One query instead of one per provider.
 */
export async function getCredentialSecrets(
  userId: string,
): Promise<Record<string, string>> {
  const result = await query<{ provider: string; secret: string }>(
    `SELECT provider, secret FROM credentials WHERE user_id = $1`,
    [userId],
  );
  const out: Record<string, string> = {};
  for (const row of result.rows) {
    try {
      out[row.provider] = decryptSecret(row.secret);
    } catch (err) {
      console.error(
        "[credential-store] failed to decrypt credential secret — skipping",
        {
          userId,
          provider: row.provider,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  return out;
}

export async function deleteCredential(
  userId: string,
  provider: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM credentials WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

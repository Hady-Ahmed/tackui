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
 * A provider's saved value is a NAMED FIELD MAP (migration 0014): single-key
 * providers have one field ("api_key"); multi-credential toolkits (the X
 * toolkit's consumer key + secret + access token + access token secret)
 * have several. Field names are the toolkit constructor arguments the
 * AgentOS per-run delivery fills; the wire dep key is <provider>_<field>.
 *
 * GET responses (via app/api/credentials) return field NAMES only — the
 * plaintext values are write-only, same boundary discipline as
 * agents.jwtSecret.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, type PgQueryable } from "@/lib/db/pg";
import { decryptSecret, encryptSecret } from "@/lib/crypto/encrypt";

export type CredentialKind = "llm" | "tool";

const providerSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^\w[\w-]*$/, "Provider must be a slug (letters, digits, dashes, underscores)");

const kindSchema = z.enum(["llm", "tool"]);

/** One saved credential field: a constructor arg name → encrypted secret. */
const fieldSchema = z.string().trim().min(1).max(64).regex(/^\w+$/, "Field must be a name (letters, digits, underscores)");

interface CredentialRow {
  id: string;
  user_id: string;
  provider: string;
  kind: string;
  fields: Record<string, string> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const CREDENTIAL_SELECT = `id, user_id, provider, kind, fields, created_at, updated_at`;

export interface StoredCredential {
  id: string;
  userId: string;
  provider: string;
  kind: CredentialKind;
  /** Field NAMES saved for this provider — values are write-only. */
  fields: string[];
  createdAt: string;
  updatedAt: string;
}

function rowToCredential(row: CredentialRow): StoredCredential {
  const fields = row.fields ?? {};
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    kind: row.kind as CredentialKind,
    fields: Object.keys(fields),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface SetCredentialInput {
  userId: string;
  provider: string;
  /** From the derived catalog — the kind the provider serves. */
  kind: CredentialKind;
  /** The named field map (e.g. {api_key: "sk-..."} or the X toolkit's four). */
  fields: Record<string, string>;
}

/**
 * Upsert the runner's key(s) for a provider. Rotating = setting again; the
 * very next run uses the new values (per-run delivery — nothing is cached
 * agent-side). Every field must be non-empty: a partial contract would
 * pass the run gate and fail mid-run.
 *
 * `tx` runs the upsert on a caller-owned transaction client (the route's
 * locked read-merge-write; the lock is worthless if the write escapes the
 * transaction). Omitted → the shared pool, the standalone default.
 */
export async function setCredential(
  input: SetCredentialInput,
  tx?: PgQueryable,
): Promise<StoredCredential> {
  const provider = providerSchema.parse(input.provider);
  const kind = kindSchema.parse(input.kind);
  const cleaned: Record<string, string> = {};
  for (const [field, value] of Object.entries(input.fields)) {
    const name = fieldSchema.parse(field);
    const secret = value.trim();
    if (!secret) {
      throw new Error(`Credential field "${field}" must not be empty`);
    }
    cleaned[name] = secret;
  }
  if (Object.keys(cleaned).length === 0) {
    throw new Error("Credential must carry at least one field");
  }
  // Encrypt at the write boundary (no-op passthrough when
  // DB_ENCRYPTION_KEY is unset — see lib/crypto/encrypt.ts).
  const encrypted = Object.fromEntries(
    Object.entries(cleaned).map(([field, secret]) => [field, encryptSecret(secret)]),
  );
  const upsert = `INSERT INTO credentials (id, user_id, provider, kind, fields)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET fields = EXCLUDED.fields, kind = EXCLUDED.kind, updated_at = now()
     RETURNING ${CREDENTIAL_SELECT}`;
  const params = [randomUUID(), input.userId, provider, kind, JSON.stringify(encrypted)];
  const result = tx
    ? await tx.query<CredentialRow>(upsert, params)
    : await query<CredentialRow>(upsert, params);
  return rowToCredential(result.rows[0]);
}

/** Existence list for the credentials UI — field names only, never values. */
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
 * Batch lookup for the run path: all of a runner's credentials, decrypted.
 * One query instead of one per provider. Shape: provider → field map.
 */
export async function getCredentialSecrets(
  userId: string,
): Promise<Record<string, Record<string, string>>> {
  const result = await query<{ provider: string; fields: Record<string, string> | null }>(
    `SELECT provider, fields FROM credentials WHERE user_id = $1`,
    [userId],
  );
  const out: Record<string, Record<string, string>> = {};
  for (const row of result.rows) {
    if (!row.fields) continue;
    const decrypted = decryptFields(row.fields, row.provider);
    if (decrypted) out[row.provider] = decrypted;
  }
  return out;
}

/**
 * Decrypt one provider's saved fields — the update path's merge source
 * (blank submitted field = keep the stored value). Returns null when
 * nothing is saved, or when nothing decrypts (same fail-closed treatment
 * as the run path: an undecryptable row is treated as absent, forcing a
 * full re-entry rather than silently keeping garbage).
 *
 * `tx` reads on a caller-owned transaction client (the route reads the
 * merge base under the same row lock it writes under). Omitted → the
 * shared pool, the standalone default.
 */
export async function getCredentialDecrypted(
  userId: string,
  provider: string,
  tx?: PgQueryable,
): Promise<Record<string, string> | null> {
  const select = `SELECT fields FROM credentials WHERE user_id = $1 AND provider = $2`;
  const result = tx
    ? await tx.query<{ fields: Record<string, string> | null }>(select, [userId, provider])
    : await query<{ fields: Record<string, string> | null }>(select, [userId, provider]);
  const row = result.rows[0];
  if (!row?.fields) return null;
  return decryptFields(row.fields, provider);
}

function decryptFields(
  fields: Record<string, string>,
  provider: string,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [field, stored] of Object.entries(fields)) {
    try {
      out[field] = decryptSecret(stored);
    } catch (err) {
      console.error(
        "[credential-store] failed to decrypt credential field — treating as absent",
        {
          provider,
          field,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  return Object.keys(out).length > 0 ? out : null;
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

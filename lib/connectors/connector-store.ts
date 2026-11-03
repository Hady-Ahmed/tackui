/**
 * Org-level MCP connector store — the admin-managed "connect an MCP
 * server" registry (migration 0013).
 *
 * Connectors are configured once per org and referenced in builder agent
 * definitions (AgentRequirements.connectors) as {id, name} pairs — the ID
 * is the stable reference (it's what the stored AgentOS config declares
 * and what the dispatcher matches the run wire against); the name is for
 * org-facing copy. At run time the run path resolves each referenced id
 * to its URL + token and delivers them per-run via AG-UI context
 * (mcp_connectors) — the AgentOS never stores connector config itself.
 *
 * The token is encrypted at rest (AES-256-GCM via lib/crypto/encrypt.ts)
 * and write-only: GET responses return hasToken booleans only, same
 * boundary discipline as agents.jwtSecret and the BYOK credentials.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query } from "@/lib/db/pg";
import { decryptSecret, encryptSecret } from "@/lib/crypto/encrypt";

interface ConnectorRow {
  id: string;
  org_id: string;
  name: string;
  url: string;
  token: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Connector {
  id: string;
  orgId: string;
  name: string;
  url: string;
  /** Decrypted bearer token. Empty string = connector has no auth. */
  token: string;
  /**
   * True when the stored ciphertext exists but can no longer be decrypted
   * (key rotation, hand-edited row, backup mismatch). Distinct from "no
   * auth": the run gate must 402 on it (a run would attach an EMPTY
   * bearer token and fail mid-run against an authed MCP server), while a
   * genuinely tokenless connector runs fine.
   */
  tokenUndecryptable: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Public shape — no token, only its existence/readability. */
export interface PublicConnector {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  tokenUndecryptable: boolean;
  createdAt: string;
  updatedAt: string;
}

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100)
  // The name is the reference key in agent definitions (requirements.
  // connectors) and the AG-UI context payload — keep it URL/payload-safe.
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/i,
    "Name must be alphanumeric with dashes/underscores",
  );
// Only http(s): connector URLs are fetched by the AgentOS at run time —
// other schemes (file:, ftp:, data:) have no legitimate use here.
const urlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:$/.test(new URL(u).protocol), {
    message: "URL must be http(s)",
  });

function rowToConnector(row: ConnectorRow): Connector {
  let token = "";
  let tokenUndecryptable = false;
  if (row.token) {
    try {
      token = decryptSecret(row.token);
    } catch (err) {
      // NOT "no auth": the ciphertext exists but can't be opened. The run
      // gate turns this into a 402 (re-enter the token) instead of
      // silently attaching an empty bearer token and failing mid-run.
      tokenUndecryptable = true;
      console.error(
        "[connector-store] failed to decrypt token — flagging as undecryptable",
        {
          connectorId: row.id,
          orgId: row.org_id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    url: row.url,
    token,
    tokenUndecryptable,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function toPublicConnector(connector: Connector): PublicConnector {
  return {
    id: connector.id,
    name: connector.name,
    url: connector.url,
    hasToken: Boolean(connector.token),
    tokenUndecryptable: connector.tokenUndecryptable,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}

export interface UpsertConnectorInput {
  orgId: string;
  name: string;
  url: string;
  /** Plaintext bearer token. Empty string / undefined = no auth. */
  token?: string;
  /**
   * The row id for a NEW connector. The connectors route generates it
   * BEFORE the platform-registry push (the id is the registry key), so
   * the push can precede the local insert; on conflict (existing row)
   * this value is ignored. Omitted → generated here (direct-store calls
   * that don't push-first).
   */
  id?: string;
}

/**
 * Create or update a connector by (orgId, name). Omitting `token`
 * preserves the stored token (edit-URL-without-retyping-secret);
 * passing an explicit "" clears it.
 */
export async function upsertConnector(
  input: UpsertConnectorInput,
): Promise<Connector> {
  const name = nameSchema.parse(input.name);
  const url = urlSchema.parse(input.url);
  // Encrypt at the write boundary (no-op passthrough when
  // DB_ENCRYPTION_KEY is unset — see lib/crypto/encrypt.ts).
  // undefined → keep the stored token; "" → clear it (COALESCE's
  // final '' covers the never-set case).
  const tokenForDb =
    input.token === undefined ? null : encryptSecret(input.token);
  // tokenForDb is null when the caller omitted the token: the INSERT
  // branch must still satisfy NOT NULL (COALESCE → ''), while the
  // conflict branch preserves the stored token (CASE on the raw param).
  // An explicit "" clears it (EXCLUDED.token = '').
  const result = await query<ConnectorRow>(
    `INSERT INTO connectors (id, org_id, name, url, token)
     VALUES ($1, $2, $3, $4, COALESCE($5, ''))
     ON CONFLICT (org_id, name)
     DO UPDATE SET
       url = EXCLUDED.url,
       token = CASE WHEN $5::text IS NULL THEN connectors.token ELSE EXCLUDED.token END,
       updated_at = now()
     RETURNING id, org_id, name, url, token, created_at, updated_at`,
    [input.id ?? randomUUID(), input.orgId, name, url, tokenForDb],
  );
  return rowToConnector(result.rows[0]);
}

/** All of an org's connectors, decrypted (run path + admin UI). */
export async function listConnectors(orgId: string): Promise<Connector[]> {
  const result = await query<ConnectorRow>(
    `SELECT id, org_id, name, url, token, created_at, updated_at
     FROM connectors WHERE org_id = $1 ORDER BY name ASC`,
    [orgId],
  );
  return result.rows.map(rowToConnector);
}

/** Batch named lookup for the run path (requirements.connectors). */
export async function getConnectorsByNames(
  orgId: string,
  names: string[],
): Promise<Map<string, Connector>> {
  if (names.length === 0) return new Map();
  const result = await query<ConnectorRow>(
    `SELECT id, org_id, name, url, token, created_at, updated_at
     FROM connectors WHERE org_id = $1 AND name = ANY($2)`,
    [orgId, names],
  );
  return new Map(result.rows.map((row) => [row.name, rowToConnector(row)]));
}

/**
 * Batch ID lookup for the run path (id-based requirements snapshots).
 * The run gate resolves the snapshot's connector refs by ID — a
 * deleted-and-recreated connector keeps its name but gets a NEW id, so a
 * name lookup would silently satisfy the gate with a connector the
 * agent's stored config never declared.
 */
export async function getConnectorsByIds(
  orgId: string,
  ids: string[],
): Promise<Map<string, Connector>> {
  if (ids.length === 0) return new Map();
  // IN-list with individual placeholders (portable across pg + pg-mem —
  // pg-mem mis-parses `id = ANY($2)` even though `name = ANY($2)` works).
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await query<ConnectorRow>(
    `SELECT id, org_id, name, url, token, created_at, updated_at
     FROM connectors WHERE org_id = $1 AND id IN (${placeholders})`,
    [orgId, ...ids],
  );
  return new Map(result.rows.map((row) => [row.id, rowToConnector(row)]));
}

export async function deleteConnector(
  orgId: string,
  name: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM connectors WHERE org_id = $1 AND name = $2`,
    [orgId, name],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

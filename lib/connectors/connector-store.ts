/**
 * Org-level MCP connector store — the admin-managed "connect an MCP
 * server" registry (migration 0013).
 *
 * Connectors are configured once per org and referenced BY NAME in
 * builder agent definitions (AgentRequirements.connectors). At run time
 * the run path resolves each named connector to its URL + token and
 * delivers them per-run via AG-UI context (mcp_connectors) — the AgentOS
 * never stores connector config itself.
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
  createdAt: string;
  updatedAt: string;
}

/** Public shape — no token, only its existence. */
export interface PublicConnector {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
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
  if (row.token) {
    try {
      token = decryptSecret(row.token);
    } catch (err) {
      console.error(
        "[connector-store] failed to decrypt token — treating as no-auth",
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
    [randomUUID(), input.orgId, name, url, tokenForDb],
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

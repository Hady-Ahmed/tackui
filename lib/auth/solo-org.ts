import { randomUUID } from "node:crypto";
import { query } from "@/lib/db/pg";

let soloOrgId: string | null = null;

const SOLO_ORG_SLUG = "solo";
const SOLO_ORG_NAME = "Solo workspace";
const FALLBACK_SOLO_ORG_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Ensure a solo workspace org row exists when AUTH_DISABLED=true.
 * Called from instrumentation.ts on boot. Idempotent — safe to call
 * on every boot.
 *
 * In solo mode there is no real user or session, so the synthetic admin
 * (id: "local") has no row in the `user` table. We create a real org row
 * so every `org_id` column has a real value (NOT NULL constraint is
 * enforced by migration 0002). No `member` row is created — the org is
 * ownerless by design in solo mode.
 *
 * On failure (table doesn't exist yet, PG not ready, or pg-mem in tests),
 * falls back to a deterministic UUID so the caller always gets a non-null
 * string. The fallback is logged but not fatal — the org_id column just
 * needs a value, and wipe-and-restart means solo data is disposable.
 */
export async function ensureSoloOrg(): Promise<string> {
  if (soloOrgId) return soloOrgId;
  try {
    const existing = await query<{ id: string }>(
      `SELECT id FROM organization WHERE slug = $1`,
      [SOLO_ORG_SLUG],
    );
    if (existing.rows[0]) {
      soloOrgId = existing.rows[0].id;
      return soloOrgId;
    }
    const id = randomUUID();
    await query(
      `INSERT INTO organization (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, now())`,
      [id, SOLO_ORG_NAME, SOLO_ORG_SLUG],
    );
    soloOrgId = id;
    return soloOrgId;
  } catch (err) {
    if (!soloOrgId) soloOrgId = FALLBACK_SOLO_ORG_ID;
    // Suppress the expected error in test mode (pg-mem has no organization
    // table) — the fallback UUID is the intended behavior there.
    if (process.env.NODE_ENV !== "test") {
      console.error("[solo-org] failed to create solo org, using fallback", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return soloOrgId;
  }
}

/**
 * Resolve the solo org id. Ensures the org exists first.
 * Used by getSyntheticAdmin() to populate RequestUser.orgId.
 */
export async function getSoloOrgId(): Promise<string> {
  if (soloOrgId) return soloOrgId;
  return ensureSoloOrg();
}

/** Reset cached state — for tests. */
export function _resetSoloOrgCache(): void {
  soloOrgId = null;
}

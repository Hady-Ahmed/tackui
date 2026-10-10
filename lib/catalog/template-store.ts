import { query } from "@/lib/db/pg";
import { decryptSecret, encryptSecret } from "@/lib/crypto/encrypt";
import { generateAgentId, getAgent, toPublicAgent } from "@/lib/agents/agent-store";
import { z } from "zod";
import type {
  AgentTemplate,
  PublicAgentTemplate,
  RequiredPlan,
  TemplateAuthMode,
} from "./catalog.config";
import type { AgentEntry, PublicAgent } from "@/lib/agents/agents.config";

const templateAuthModeSchema = z.enum(["none", "jwt"]);
const requiredPlanSchema = z.enum(["pro", "team"]);

// Shared field definitions — used by the create + update input schemas.
// `id` is intentionally absent: server-generated on create, URL path
// param on update.
const fieldShapes = {
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Use lowercase letters, numbers, and dashes",
    ),
  tagline: z.string().trim().min(1, "Tagline is required").max(200),
  description: z.string().trim().min(1, "Description is required").max(2000),
  // Clearable optional fields: `null` clears the stored value, absent
  // key preserves it (partial-update semantics).
  category: z.string().max(50).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  endpoint: z.string().url(),
  authMode: templateAuthModeSchema.default("none"),
  // HS256 needs ≥256 bits = 32 chars. Only validated when present
  // (blank submit on PATCH preserves the existing value).
  jwtSecret: z.string().min(32).optional(),
  jwtScopes: z.array(z.string()).optional(),
  requiredPlan: requiredPlanSchema.nullable().optional(),
  freeDailyQuota: z.number().int().min(1).max(100000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  isActive: z.boolean().default(true),
};

/**
 * A plan-gated template has no free tier at all — free users can't run
 * it, so a free quota alongside requiredPlan is contradictory. Rejected
 * at the schema level to keep the admin form honest.
 */
function refineNoQuotaWhenPlanGated(
  data: { requiredPlan?: RequiredPlan | null; freeDailyQuota?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (data.requiredPlan && data.freeDailyQuota != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["freeDailyQuota"],
      message:
        "freeDailyQuota cannot be set when requiredPlan is set — a plan-gated agent has no free tier.",
    });
  }
}

/**
 * Body schema for POST /api/catalog. `id` is never accepted from the
 * client — the server generates it.
 */
export const createTemplateBodySchema = z
  .object(fieldShapes)
  .superRefine(refineNoQuotaWhenPlanGated);
export type CreateTemplateInput = z.infer<typeof createTemplateBodySchema>;

/**
 * Body schema for PATCH /api/catalog/[id]. All fields optional; `id`
 * is never accepted (comes from the URL path param).
 */
export const updateTemplateBodySchema = z
  .object(fieldShapes)
  .partial()
  .superRefine(refineNoQuotaWhenPlanGated);
export type UpdateTemplateInput = z.infer<typeof updateTemplateBodySchema>;

/**
 * Internal schema used to validate the fully-merged template row before
 * persisting (in updateTemplate). `id` comes from the URL param /
 * existing row — never from client input.
 */
const templateRowSchema = z
  .object({ id: z.string().min(1).max(64), ...fieldShapes })
  .superRefine(refineNoQuotaWhenPlanGated);

interface TemplateRow {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  icon: string | null;
  endpoint: string;
  auth_mode: string | null;
  jwt_secret: string | null;
  jwt_scopes: string | null;
  required_plan: string | null;
  free_daily_quota: number | null;
  sort_order: number;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToTemplate(row: TemplateRow): AgentTemplate {
  // Decrypt at the read boundary — same graceful-degrade contract as
  // agent-store (a decrypt failure treats the template as secret-less;
  // installed copies are unaffected either way).
  let jwtSecret: string | undefined;
  if (row.jwt_secret) {
    try {
      jwtSecret = decryptSecret(row.jwt_secret);
    } catch (err) {
      console.error("[template-store] failed to decrypt jwt_secret — treating template as secret-less", {
        templateId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline ?? "",
    description: row.description ?? "",
    ...(row.category ? { category: row.category } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    endpoint: row.endpoint,
    authMode: (row.auth_mode ?? "none") as TemplateAuthMode,
    jwtSecret,
    jwtScopes: row.jwt_scopes
      ? row.jwt_scopes.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    ...(row.required_plan ? { requiredPlan: row.required_plan as RequiredPlan } : {}),
    ...(row.free_daily_quota != null ? { freeDailyQuota: row.free_daily_quota } : {}),
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Strip raw secrets (`jwtSecret`) from an AgentTemplate and replace them
 * with a boolean. Use for any response that leaves the server.
 */
export function toPublicTemplate(template: AgentTemplate): PublicAgentTemplate {
  return {
    id: template.id,
    slug: template.slug,
    name: template.name,
    tagline: template.tagline,
    description: template.description,
    ...(template.category !== undefined ? { category: template.category } : {}),
    ...(template.icon !== undefined ? { icon: template.icon } : {}),
    endpoint: template.endpoint,
    authMode: template.authMode,
    hasJwtSecret: Boolean(template.jwtSecret),
    ...(template.jwtScopes !== undefined ? { jwtScopes: template.jwtScopes } : {}),
    ...(template.requiredPlan !== undefined ? { requiredPlan: template.requiredPlan } : {}),
    ...(template.freeDailyQuota !== undefined ? { freeDailyQuota: template.freeDailyQuota } : {}),
    sortOrder: template.sortOrder,
    isActive: template.isActive,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

export function toPublicTemplates(templates: AgentTemplate[]): PublicAgentTemplate[] {
  return templates.map(toPublicTemplate);
}

const TEMPLATE_COLUMNS = `id, slug, name, tagline, description, category, icon, endpoint,
  auth_mode, jwt_secret, jwt_scopes, required_plan, free_daily_quota,
  sort_order, is_active, created_at, updated_at`;

/**
 * List templates. `activeOnly` (the default) hides deactivated ones —
 * that's what the catalog UI shows. The admin CRUD passes activeOnly:
 * false to manage the full set. Ordered by sort_order, then creation.
 */
export async function listTemplates(
  opts?: { activeOnly?: boolean },
): Promise<AgentTemplate[]> {
  const sql = opts?.activeOnly
    ? `SELECT ${TEMPLATE_COLUMNS} FROM agent_templates WHERE is_active = TRUE ORDER BY sort_order ASC, created_at ASC`
    : `SELECT ${TEMPLATE_COLUMNS} FROM agent_templates ORDER BY sort_order ASC, created_at ASC`;
  const result = await query<TemplateRow>(sql);
  return result.rows.map(rowToTemplate);
}

export async function getTemplate(id: string): Promise<AgentTemplate | null> {
  const result = await query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM agent_templates WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? rowToTemplate(result.rows[0]) : null;
}

export async function getTemplateBySlug(slug: string): Promise<AgentTemplate | null> {
  const result = await query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM agent_templates WHERE slug = $1`,
    [slug],
  );
  return result.rows[0] ? rowToTemplate(result.rows[0]) : null;
}

/**
 * Batch load templates by id — the runtime's live-resolve path
 * (registry.ts resolves installed agents' endpoint/auth from the
 * template on every request). Inactive templates are included (the
 * caller decides what to do with them); missing ids are simply absent
 * from the result.
 */
export async function getTemplatesByIds(ids: string[]): Promise<AgentTemplate[]> {
  if (ids.length === 0) return [];
  // IN-list with individual placeholders (portable across pg + pg-mem —
  // pg-mem doesn't handle `= ANY($1)` with a JS array param).
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const result = await query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM agent_templates WHERE id IN (${placeholders})`,
    ids,
  );
  return result.rows.map(rowToTemplate);
}

/**
 * Create a template. The `id` is server-generated (never client-supplied).
 * The jwtSecret is encrypted at the write boundary (no-op passthrough
 * when DB_ENCRYPTION_KEY is unset).
 */
export async function createTemplate(
  input: CreateTemplateInput,
): Promise<AgentTemplate> {
  const id = generateAgentId();
  const jwtSecretForDb = input.jwtSecret ? encryptSecret(input.jwtSecret) : null;
  const result = await query<TemplateRow>(
    `INSERT INTO agent_templates
       (id, slug, name, tagline, description, category, icon, endpoint,
        auth_mode, jwt_secret, jwt_scopes, required_plan, free_daily_quota,
        sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      id,
      input.slug,
      input.name,
      input.tagline,
      input.description,
      input.category ?? null,
      input.icon ?? null,
      input.endpoint,
      input.authMode,
      jwtSecretForDb,
      input.jwtScopes?.join(",") ?? null,
      input.requiredPlan ?? null,
      input.freeDailyQuota ?? null,
      input.sortOrder ?? 0,
      input.isActive ?? true,
    ],
  );
  return rowToTemplate(result.rows[0]);
}

/**
 * Update a template. The `id` comes from the URL path param (never from
 * the patch body). Absent patch keys preserve the stored values; explicit
 * `null` on clearable fields (category, icon, requiredPlan,
 * freeDailyQuota, jwtScopes) clears them. Omitting jwtSecret preserves
 * the existing secret (blank-preserve, same as agents).
 */
export async function updateTemplate(
  id: string,
  patch: UpdateTemplateInput,
): Promise<AgentTemplate | null> {
  const existing = await getTemplate(id);
  if (!existing) return null;
  const merged = {
    id,
    name: existing.name,
    slug: existing.slug,
    tagline: existing.tagline,
    description: existing.description,
    category: existing.category ?? null,
    icon: existing.icon ?? null,
    endpoint: existing.endpoint,
    authMode: existing.authMode,
    jwtSecret: existing.jwtSecret,
    jwtScopes: existing.jwtScopes,
    requiredPlan: existing.requiredPlan ?? null,
    freeDailyQuota: existing.freeDailyQuota ?? null,
    sortOrder: existing.sortOrder,
    isActive: existing.isActive,
    ...patch,
  };
  const parsed = templateRowSchema.parse(merged);
  // Re-encrypt (fresh IV) even when the secret is preserved — same
  // behavior as agent-store's updateAgent.
  const jwtSecretForDb = parsed.jwtSecret ? encryptSecret(parsed.jwtSecret) : null;
  const result = await query<TemplateRow>(
    `UPDATE agent_templates
     SET name = $1, slug = $2, tagline = $3, description = $4,
         category = $5, icon = $6, endpoint = $7, auth_mode = $8,
         jwt_secret = $9, jwt_scopes = $10, required_plan = $11,
         free_daily_quota = $12, sort_order = $13, is_active = $14,
         updated_at = now()
     WHERE id = $15
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      parsed.name,
      parsed.slug,
      parsed.tagline,
      parsed.description,
      parsed.category ?? null,
      parsed.icon ?? null,
      parsed.endpoint,
      parsed.authMode,
      jwtSecretForDb,
      parsed.jwtScopes?.join(",") ?? null,
      parsed.requiredPlan ?? null,
      parsed.freeDailyQuota ?? null,
      parsed.sortOrder,
      parsed.isActive,
      id,
    ],
  );
  return result.rows[0] ? rowToTemplate(result.rows[0]) : null;
}

/**
 * Delete a template and tombstone its installed copies.
 *
 * The installed agent rows are NOT hard-deleted: they're stamped with
 * `template_deleted_at` so they stay listed (with a "Removed" chip) and
 * past conversations remain browsable — but they can never run again
 * (the route 410s runs; there is no ungated-orphan path). Orgs can
 * "Remove" the tombstone themselves via the normal agent delete.
 * Callers should surface the blast radius first via countTemplateInstalls.
 */
export async function deleteTemplate(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM agent_templates WHERE id = $1`,
    [id],
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    await query(
      `UPDATE agents SET template_deleted_at = now() WHERE source_template_id = $1 AND template_deleted_at IS NULL`,
      [id],
    );
  }
  return deleted;
}

/**
 * How many org-installed agents reference this template — the delete
 * confirmation's "N workspaces have this installed" number.
 */
export async function countTemplateInstalls(templateId: string): Promise<number> {
  const result = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM agents WHERE source_template_id = $1`,
    [templateId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Find the id of the agent row this org installed from a template (the
 * upsert target). Oldest wins if duplicates somehow exist (they
 * shouldn't — install is guarded, and nothing can set
 * source_template_id on a manually-created agent). Exported for the
 * install route, which must distinguish new installs (agent-count cap
 * applies) from re-syncs (no new row, cap irrelevant).
 */
export async function findInstalledAgentId(
  templateId: string,
  orgId: string,
): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT id FROM agents
     WHERE org_id = $1 AND source_template_id = $2
     ORDER BY created_at ASC LIMIT 1`,
    [orgId, templateId],
  );
  return result.rows[0]?.id ?? null;
}

export interface InstallResult {
  agent: AgentEntry;
  /** true when a NEW agent row was created (vs. re-syncing an existing one). */
  installed: boolean;
  /** true when the sync changed the stored config (or refreshed a stale snapshot). */
  updated: boolean;
}

/**
 * Idempotent install: registers a template as installed in the org's
 * `agents` table.
 *
 * The agents row is an ENTITLEMENT/reference, not the config source —
 * the runtime resolves endpoint/auth live from the template on every
 * request (lib/agents/registry.ts), so template edits propagate without
 * user action. The row's copied config (synced here on every call) is
 * the fallback that keeps history replay working if the template is
 * later deleted (tombstone).
 *
 * - First call creates the agent row stamped with source_template_id.
 * - A later call refreshes the row's config snapshot from the template
 *   (agent id preserved — threads intact). The catalog UI shows this
 *   simply as "Added ✓"; the refresh is invisible to users.
 *
 * Plan/count gates are the caller's job (checkTemplateInstall +
 * checkAgentCountLimit); on the re-sync path the caller skips the
 * agent-count check (no new agent is created).
 */
export async function installTemplate(
  template: AgentTemplate,
  orgId: string,
): Promise<InstallResult> {
  const existingId = await findInstalledAgentId(template.id, orgId);
  const syncedAt = new Date(template.updatedAt);
  const jwtSecretForDb = template.jwtSecret ? encryptSecret(template.jwtSecret) : null;
  const jwtScopesForDb = template.jwtScopes?.join(",") ?? null;

  if (existingId) {
    // Capture the previous sync snapshot BEFORE the update so `updated`
    // reflects whether this re-sync actually brought anything new.
    const previousSyncedAt =
      (await getAgent(existingId, orgId))?.installedTemplateUpdatedAt ?? null;
    await query(
      `UPDATE agents
       SET name = $1, description = $2, endpoint = $3, auth_mode = $4,
           jwt_secret = $5, jwt_scopes = $6,
           installed_template_updated_at = $7, updated_at = now()
       WHERE id = $8 AND org_id = $9`,
      [
        template.name,
        template.description,
        template.endpoint,
        template.authMode,
        jwtSecretForDb,
        jwtScopesForDb,
        syncedAt,
        existingId,
        orgId,
      ],
    );
    const agent = (await getAgent(existingId, orgId))!;
    const changed = previousSyncedAt === null || template.updatedAt > previousSyncedAt;
    return { agent, installed: false, updated: changed };
  }

  const id = generateAgentId();
  await query(
    `INSERT INTO agents
       (id, name, description, endpoint, org_id, auth_mode, jwt_secret,
        jwt_scopes, source_template_id, installed_template_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      template.name,
      template.description,
      template.endpoint,
      orgId,
      template.authMode,
      jwtSecretForDb,
      jwtScopesForDb,
      template.id,
      syncedAt,
    ],
  );
  const agent = (await getAgent(id, orgId))!;
  return { agent, installed: true, updated: false };
}

export interface RunUsage {
  /** Runs inside the window. */
  count: number;
  /** Oldest run's timestamp inside the window (null when none) — the
   * quota reset moment is oldestAt + windowMs. */
  oldestAt: string | null;
}

/**
 * Annotate public agents with curator state for the UI: managed agents
 * whose template is currently deactivated get `templateUnpublished: true`
 * (the sidebar's "Paused" chip; runs 402 "unpublished by the curator"
 * until re-shown). Tombstones never carry it — Removed wins. Batched:
 * one template query per call regardless of agent count.
 *
 * Lives here (not agent-store) because it needs the templates table and
 * agent-store must not import template-store (template-store already
 * imports agent-store — a cycle would break the module graph).
 */
export async function annotateAgentTemplateState(
  entries: AgentEntry[],
): Promise<PublicAgent[]> {
  const managed = entries.filter(
    (e) => e.sourceTemplateId && !e.templateRemovedAt,
  );
  const templates = await getTemplatesByIds(
    [...new Set(managed.map((e) => e.sourceTemplateId as string))],
  );
  const inactive = new Set(
    templates.filter((t) => !t.isActive).map((t) => t.id),
  );
  return entries.map((entry) => {
    const pub = toPublicAgent(entry);
    if (entry.sourceTemplateId && inactive.has(entry.sourceTemplateId)) {
      pub.templateUnpublished = true;
    }
    return pub;
  });
}

/**
 * Count a user's runs of a specific agent inside a rolling window.
 *
 * Rides the existing event log: every run is persisted in `agent_runs`
 * (keyed by thread) and `thread_metadata` carries the agent + user the
 * thread belongs to. No counter infrastructure — the log IS the counter.
 * Both sides of the join are indexed (agent_runs.thread_id,
 * thread_metadata PK + user_id).
 *
 * The window boundary is computed in JS and passed as a parameter (not
 * SQL `now() - interval`) — clock arithmetic stays in one place and
 * pg-mem handles the plain comparison.
 */
export async function getRunUsage(
  userId: string,
  agentId: string,
  windowMs = 24 * 60 * 60 * 1000,
): Promise<RunUsage> {
  const since = new Date(Date.now() - windowMs);
  const result = await query<{ count: number; oldest: Date | string | null }>(
    `SELECT count(*)::int AS count, min(r.created_at) AS oldest
     FROM agent_runs r
     JOIN thread_metadata t ON t.thread_id = r.thread_id
     WHERE t.user_id = $1 AND t.agent_id = $2 AND r.created_at >= $3`,
    [userId, agentId, since],
  );
  const row = result.rows[0];
  return {
    count: row?.count ?? 0,
    oldestAt: row?.oldest ? iso(row.oldest) : null,
  };
}

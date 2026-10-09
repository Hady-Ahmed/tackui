// Agent catalog ("agent templates") — types only, safe to import from
// client components (no runtime config, no DB imports). The store lives
// in lib/catalog/template-store.ts.
//
// A template is a curator-published creation template for an agent.
// Installing copies its config into an org-scoped row of the `agents`
// table — the installed copy is the org's property (deleting the
// template never deletes installed copies). The runtime needs no changes:
// installed agents are ordinary agents to `getAgents()`.

export type TemplateAuthMode = "none" | "jwt";

/** Minimum plan required to install/run a gated template. */
export type RequiredPlan = "pro" | "team";

/**
 * Internal template shape (server-side only — carries the decrypted
 * `jwtSecret`). Never leave the server in this form.
 */
export interface AgentTemplate {
  id: string;
  /** URL-safe identifier for shareable anchors (/catalog#slug). */
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category?: string;
  /** Emoji (or short glyph) shown on catalog cards. */
  icon?: string;
  endpoint: string;
  authMode: TemplateAuthMode;
  /**
   * Shared HS256 signing secret (write-only — never returned by GET
   * responses). Encrypted at rest, same machinery as agents.
   */
  jwtSecret?: string;
  jwtScopes?: string[];
  /** Plan gate — undefined = installable on all plans. */
  requiredPlan?: RequiredPlan;
  /**
   * Rolling-24h per-user run cap for free-plan orgs (SaaS enforcement).
   * undefined = unlimited. Meaningless when requiredPlan is set (free
   * users can't run a gated agent at all).
   */
  freeDailyQuota?: number;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Template shape returned by read endpoints (GET /api/catalog). Secrets
 * are stripped and replaced with a boolean. Write endpoints (POST/PATCH)
 * still accept the raw secret.
 */
export interface PublicAgentTemplate {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category?: string;
  icon?: string;
  endpoint: string;
  authMode: TemplateAuthMode;
  hasJwtSecret: boolean;
  jwtScopes?: string[];
  requiredPlan?: RequiredPlan;
  freeDailyQuota?: number;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

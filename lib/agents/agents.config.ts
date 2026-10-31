// Agents speak the AG-UI protocol via `HttpAgent` — Agno, CrewAI,
// Pydantic AI, Mastra, LangGraph (via ag-ui-langgraph), or a custom
// backend. There is no `kind` field: the speculative `langgraph` kind
// (LangGraph Platform API) was removed in migration 0008 and the whole
// `kind` field in migration 0009. When a second kind is genuinely
// demanded, re-add the column + adapter in the same migration as its
// config fields.

import type { RequiredPlan } from "@/lib/catalog/catalog.config";

export type AgentAuthMode = "none" | "jwt";

/**
 * Agent provenance:
 * - "manual"   — added via the admin /agents page (default).
 * - "template" — legacy label kept for rows created before migration 0013
 *   (equivalent to "manual" for permissions; catalog installs are
 *   distinguished by sourceTemplateId, not origin).
 * - "builder"  — created through the builder (member-accessible). The
 *   runtime config resolves from platform env at run time (endpoint from
 *   AGENTOS_BASE_URL + remoteAgentId, JWT secret from AGENTOS_JWT_SECRET,
 *   scopes ["app:user"]); the row's endpoint/jwtSecret carry nothing.
 */
export const AGENT_ORIGINS = ["manual", "template", "builder"] as const;
export type AgentOrigin = (typeof AGENT_ORIGINS)[number];

/**
 * What a RUNNER needs to run a builder agent — snapshot written by the
 * builder create/update path from the definition tackui itself built.
 * The AgentOS stored config is the source of truth; this snapshot only
 * powers the pre-run run gate (model tier / tool key checks) without an
 * AgentOS round-trip.
 */
export interface AgentRequirements {
  /**
   * Model requirements snapshot — sourced from the platform models catalog
   * at create/update time. `requiresKey` mirrors the catalog's wire field:
   * false for keyless providers (e.g. ollama) where no credential is
   * demanded and the provider is deliberately excluded from the runner's
   * credentials catalog — the gate must not 402 a run that can never
   * satisfy its own requirement.
   */
  model: { provider: string; id: string; platformTier: boolean; requiresKey?: boolean };
  /**
   * Tool requirements snapshot — sourced from the platform tools catalog
   * at create/update time. `requiresKey` is the AG-UI context dep key the
   * runner delivers; `provider` is the derived provider slug (the key the
   * runner saves under); `platformFallback` (true = the platform key
   * serves a runner without one) drives the run gate's fallback decision.
   * The run gate reads ONLY this snapshot — never a live catalog — so a
   * tool unknown to the snapshot fails closed.
   */
  tools: {
    name: string;
    label?: string;
    requiresKey?: string | null;
    provider?: string | null;
    /**
     * Always present after the store parses a requirements payload —
     * old snapshots default to false (fail-closed: the run gate then
     * requires a runner key). New snapshots carry the platform-derived
     * value computed at create/update time.
     */
    platformFallback: boolean;
    /**
     * The full credential contract — multi-credential toolkits (the X
     * toolkit's four) carry several; single-key tools carry exactly one.
     * Absent on snapshots written before multi-credential support: the
     * run gate then treats the single `requiresKey` dep as the contract.
     */
    credentials?: { depKey: string; label: string }[];
  }[];
  /**
   * MCP connector names (org-level, connectors table) this agent wires in.
   * The run gate checks the runner's org has each connector configured;
   * their URL + token are delivered per-run via AG-UI context.
   */
  connectors: string[];
}

export interface AgentEntry {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  orgId: string;
  /**
   * How the runtime authenticates to the agent's backend.
   * - "none" (default): no auth — the agent endpoint is anonymous and
   *   the runtime falls back to forwarding the user id via
   *   `forwardedProps.user_id` (Agno's anonymous-caller convention).
   * - "jwt": the runtime mints a short-lived HS256 JWT per run with
   *   `sub` = the authenticated user's id, signed with `jwtSecret`, and
   *   sends it as `Authorization: Bearer <token>`. The backend verifies
   *   the signature (shared secret) and uses `sub` to identify the user.
   *   Authorization (what the user can do) stays the backend's job —
   *   tackui only vouches for *who* the user is.
   */
  authMode: AgentAuthMode;
  /**
   * Shared HS256 signing secret for JWT auth (write-only — accepted on
   * POST/PATCH but never returned in GET responses). Must be ≥32 chars
   * (HS256 needs ≥256 bits). Set this to the same value as the agent
   * backend's JWT verification key (e.g. Agno's `JWT_VERIFICATION_KEY`).
   * Blank submit on PATCH preserves the existing value.
   */
  jwtSecret?: string;
  /**
   * Optional JWT `scopes` claim — a list of permission scopes included
   * in the JWT payload when the agent's backend has `authorization=True`
   * enabled (e.g. Agno's AuthMiddleware checks this claim for RBAC
   * gatekeeping). Only needed when the backend requires specific scopes;
   * omit entirely when the backend's authorization is off (the default).
   * tackui sends identity (`sub`); scopes are a backend-specific config,
   * not derived from the tackui user — set them per agent to match what
   * the backend expects.
   */
  jwtScopes?: string[];
  /**
   * Catalog provenance — the agent template this row was installed from
   * (undefined for manually-added agents). Plain provenance, no FK:
   * deleting a template leaves installed copies working.
   */
  sourceTemplateId?: string;
  /**
   * Builder provenance (migration 0013). "builder" agents resolve their
   * runtime config from platform env at run time (see AgentOrigin docs).
   * The store defaults absent rows to "manual".
   */
  origin?: AgentOrigin;
  /**
   * The member who created a builder agent (attribution survives
   * membership changes). Undefined for manual/template rows.
   */
  authorUserId?: string;
  /**
   * The AgentOS-side component id for builder agents. Server-side only:
   * the run/edit machinery uses it; it never leaves the server (the
   * AgentOS's address is platform config).
   */
  remoteAgentId?: string;
  /**
   * Runner-requirements snapshot for builder agents (powers the pre-run
   * gate). Undefined for non-builder agents.
   */
  requirements?: AgentRequirements;
  /**
   * Snapshot of the template's updated_at at install/last-sync time.
   * With live propagation the template is the runtime's source of truth;
   * this snapshot is the config fallback that tombstone history replay
   * relies on.
   */
  installedTemplateUpdatedAt?: string;
  /**
   * Tombstone (migration 0011): the template this agent was installed
   * from was deleted. The agent stays listed (with a "Removed" chip) so
   * past conversations remain browsable, but it can never run again —
   * runs are 410'd at the route before anything reaches a backend.
   * Presence of the timestamp IS the flag; undefined for live agents.
   */
  templateRemovedAt?: string;
  /**
   * The template is currently deactivated (`is_active = false`) — the
   * reversible curator kill switch. The sidebar shows a "Paused" chip;
   * runs 402 ("unpublished by the curator") until re-shown. Tombstones
   * (templateRemovedAt) never carry this — Removed wins. Server-side
   * annotation on GET /api/agents (batch template lookup).
   */
  templateUnpublished?: boolean;
}
/**
 * Agent shape returned by read endpoints (GET /api/agents,
 * GET /api/agents/[id]). Secrets are stripped and replaced with booleans
 * so callers (e.g. the admin edit form) can tell whether a secret is
 * configured without ever receiving the value. Write endpoints
 * (POST/PATCH) still accept the raw secrets.
 *
 * Managed agents (catalog installs, `sourceTemplateId` set) are
 * references to their template, not org-owned config: `endpoint` is
 * stripped — the curator's backend URLs never leave the server.
 */
export interface PublicAgent {
  id: string;
  name: string;
  description: string;
  /** Omitted for managed (catalog-installed) agents. */
  endpoint?: string;
  orgId: string;
  authMode: AgentAuthMode;
  hasJwtSecret: boolean;
  jwtScopes?: string[];
  sourceTemplateId?: string;
  /** Builder provenance (absent = "manual"). */
  origin?: AgentOrigin;
  /** Creator attribution for builder agents. */
  authorUserId?: string;
  /** Runner-requirements snapshot for builder agents (run-gate display). */
  requirements?: AgentRequirements;
  installedTemplateUpdatedAt?: string;
  templateRemovedAt?: string;
  /**
   * The template is currently deactivated (`is_active = false`) — the
   * reversible curator kill switch. The sidebar shows a "Paused" chip;
   * runs 402 ("unpublished by the curator") until re-shown. Tombstones
   * (templateRemovedAt) never carry this — Removed wins. Server-side
   * annotation on GET /api/agents (batch template lookup).
   */
  templateUnpublished?: boolean;
  /**
   * The template is plan-gated (`required_plan` set) and the viewer's
   * org plan doesn't satisfy it — the third silently-dead state (along
   * Removed/Paused). Pure curator state, billing-free: the server sends
   * the gate; the client (sidebar) compares it against useBilling()'s
   * plan and renders a 🔒 Pro/Team chip, SaaS-only. Tombstones never
   * carry it — Removed wins. Server-side annotation on GET /api/agents.
   */
  templateRequiredPlan?: RequiredPlan;
  /**
   * The live template's tagline/description, stamped by
   * annotateAgentTemplateState on GET /api/agents for managed
   * (non-tombstoned) agents. Display text propagates live the same way
   * endpoint/auth do at run time — a template edit reaches every
   * installed workspace's UI on the next fetch, with no re-install.
   * Tombstones never carry them (the template row is gone; the agent
   * row's install-time snapshot is all that's left), so clients fall
   * back to `description` there. Paused agents DO get live values —
   * the template row still exists, and freezing text during a pause
   * would make the un-pause transition a visible stale→live jump.
   */
  templateTagline?: string;
  templateDescription?: string;
  /**
   * The live template's icon (emoji), stamped by
   * annotateAgentTemplateState alongside the tagline/description copy —
   * same live-propagation rule: managed (non-tombstoned) agents get it,
   * tombstones and manual agents don't (the client falls back to the
   * first-letter placeholder). The sidebar renders it as the row's
   * avatar glyph (catalog-card treatment).
   */
  templateIcon?: string;
}

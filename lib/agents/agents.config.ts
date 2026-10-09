// Agents speak the AG-UI protocol via `HttpAgent` — Agno, CrewAI,
// Pydantic AI, Mastra, LangGraph (via ag-ui-langgraph), or a custom
// backend. There is no `kind` field: the speculative `langgraph` kind
// (LangGraph Platform API) was removed in migration 0008 and the whole
// `kind` field in migration 0009. When a second kind is genuinely
// demanded, re-add the column + adapter in the same migration as its
// config fields.

export type AgentAuthMode = "none" | "jwt";

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
}

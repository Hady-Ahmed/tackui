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
}

/**
 * Agent shape returned by read endpoints (GET /api/agents,
 * GET /api/agents/[id]). Secrets are stripped and replaced with booleans
 * so callers (e.g. the admin edit form) can tell whether a secret is
 * configured without ever receiving the value. Write endpoints
 * (POST/PATCH) still accept the raw secrets.
 */
export interface PublicAgent {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  orgId: string;
  authMode: AgentAuthMode;
  hasJwtSecret: boolean;
  jwtScopes?: string[];
}

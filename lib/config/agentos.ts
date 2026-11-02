/**
 * AgentOS platform configuration.
 *
 * The platform-os service is shared multi-tenant
 * infrastructure: builder-created agents are versioned component configs
 * on the AgentOS, and tackui's run path reaches them through this
 * deployment's platform credentials. This file is the single source of
 * truth for those credentials (same boot-constant convention as
 * lib/config/saas.ts and lib/auth/auth.ts — evaluated once at module
 * load; restart the server after changing these in `.env.local`).
 *
 * When AGENTOS_BASE_URL is unset, builder features are disabled: the
 * builder create path 503s and any stale builder agents (a self-hoster
 * who removed the env) resolve to nothing rather than half-running.
 */

/** True when the AgentOS platform is configured for this deployment. */
export const AGENTOS_ENABLED = !!process.env.AGENTOS_BASE_URL;

/**
 * Base URL of the platform-os AgentOS (e.g. "http://agent-os:7778").
 * No trailing slash — builderEndpoint joins path segments directly.
 */
export const AGENTOS_BASE_URL = (process.env.AGENTOS_BASE_URL ?? "").replace(
  /\/+$/,
  "",
);

/**
 * The platform JWT secret the AgentOS dispatcher verifies. tackui signs
 * per-request service tokens (app:superadmin) and user tokens (app:user,
 * sub = the running user's id) with this secret — the same HS256 wire
 * contract proven in the platform's own credentials module.
 * Required when AGENTOS_BASE_URL is set; a missing secret with a set
 * URL is a boot misconfiguration (every run would 401 at the dispatcher).
 */
export const AGENTOS_JWT_SECRET = process.env.AGENTOS_JWT_SECRET ?? "";

/**
 * True when the URL is set but the secret is missing — a deployment
 * error that would make every builder run fail with 401 at the
 * dispatcher. Surfaced at boot via logAgentosWarnings() (called from
 * instrumentation) rather than a throw, so the rest of the app still
 * works (non-builder agents are unaffected).
 */
export const AGENTOS_MISCONFIGURED =
  !!process.env.AGENTOS_BASE_URL && !AGENTOS_JWT_SECRET;

/**
 * The AG-UI endpoint for a builder agent given its AgentOS-side
 * component id: `{AGENTOS_BASE_URL}/agui/{remoteAgentId}`. Only call
 * when AGENTOS_ENABLED — callers must check first (returns null
 * otherwise, so a half-configured env can't produce a broken endpoint).
 */
export function builderEndpoint(remoteAgentId: string): string | null {
  if (!AGENTOS_ENABLED) return null;
  return `${AGENTOS_BASE_URL}/agui/${encodeURIComponent(remoteAgentId)}`;
}

/** Boot-time warning for a set-URL/missing-secret misconfiguration. */
export function logAgentosWarnings(): void {
  if (AGENTOS_MISCONFIGURED) {
    console.error(
      "[agentos] AGENTOS_BASE_URL is set but AGENTOS_JWT_SECRET is missing — " +
        "builder agent runs will fail with 401 at the AgentOS dispatcher. " +
        "Set AGENTOS_JWT_SECRET to the platform-os JWT secret.",
    );
  }
}

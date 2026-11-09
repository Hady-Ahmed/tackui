/**
 * Numeric env override for one limit's max — e.g. AGENT_READ_RATE_MAX.
 * Self-hosters with many humans on one busy single-instance deployment
 * legitimately outgrow per-user read presets; the E2E harness sets this
 * because its entire suite is ONE shared user charging the same buckets
 * from ten routes (see docs/e2e.md "The auth budget" — without it the
 * 15-test run trips the agentRead cap by design). Read once at module
 * load (the same boot-time contract as lib/config) — never per request.
 * Only a positive integer overrides; junk, zero, and negatives keep the
 * preset so a typo can't silently disable a limit.
 */
export function maxFromEnv(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/**
 * Named rate-limit presets. Each defines a max count and a window in ms.
 * Used by the route handlers and proxy to enforce consistent limits.
 *
 * Limits are deliberately generous for reads and tight for expensive
 * operations (agent runs, SSRF-adjacent probes, mutations).
 */
export const LIMITS = {
  /** Per-user: agent run requests (POST /api/copilotkit). 20/min. */
  copilotkit: { max: 20, windowMs: 60_000 },
  /** Per-user: concurrent in-flight SSE streams. 3 at a time. */
  copilotkitConcurrent: { max: 3 },
  /** Per-user: reachability probe (outbound fetch). 30/min. */
  reachabilityProbe: { max: 30, windowMs: 60_000 },
  /** Per-user: agent mutations (POST/PATCH/DELETE /api/agents). 10/min,
   *  AGENT_MUTATE_RATE_MAX-overridable (same contract as agentRead
   *  above): the catalog's install/template routes share this bucket
   *  with agent CRUD, and one busy deployment (or one e2e suite) where
   *  several surfaces mutate in the same minute legitimately outgrows
   *  the member-facing preset. */
  agentMutate: {
    max: maxFromEnv("AGENT_MUTATE_RATE_MAX", 10),
    windowMs: 60_000,
  },
  /** Per-user: agent reads (GET /api/agents — and the ten other routes
   *  that charge this bucket: agent detail, catalog, connectors,
   *  credentials, models, tools, can-manage-agents). 60/min by default,
   *  AGENT_READ_RATE_MAX-overridable (see maxFromEnv above). */
  agentRead: {
    max: maxFromEnv("AGENT_READ_RATE_MAX", 60),
    windowMs: 60_000,
  },
  /**
   * Per-user: platform-admin catalog writes (PUT catalog, POST test-model).
   * Separate from agentMutate: admin configuration legitimately bursts
   * (fix-and-resave validation loops, testing several models) and must
   * not compete with the member-facing mutation budget. Still bounded —
   * a buggy loop can't hammer the AgentOS.
   */
  adminMutate: { max: 30, windowMs: 60_000 },
  /** Per-user: thread mutations (PATCH/DELETE /api/threads). 30/min. */
  threadMutate: { max: 30, windowMs: 60_000 },
  /** Per-IP: sign-in/sign-up attempts. 10/min. */
  authIp: { max: 10, windowMs: 60_000 },
  /** Per-IP: global flood protection on all /api/* routes. 300/min.
   *  Generous enough for active use (page refreshes, CopilotKit connect/info
   *  streams, conversation switching) while still blocking flood attacks.
   *  GLOBAL_IP_RATE_MAX-overridable for the same busy-deployment case as
   *  agentRead above — the aggregate of many humans (or the E2E suite's
   *  concurrent browser workers) is one IP's worth of /api traffic. */
  globalIp: {
    max: maxFromEnv("GLOBAL_IP_RATE_MAX", 300),
    windowMs: 60_000,
  },
  /** PUT/DELETE /api/credentials — BYOK key upserts/removals. */
  credentialMutate: { max: 20, windowMs: 60_000 },
  /** PUT/DELETE /api/connectors — org connector upserts/removals. */
  connectorMutate: { max: 20, windowMs: 60_000 },
  /** POST /api/billing/checkout + /api/billing/portal — each creates an
   *  outbound Stripe session. Tight: nothing legitimate bursts these. */
  billingMutate: { max: 10, windowMs: 60_000 },
  /** GET /api/billing/subscription + GET /api/org — account/org reads
   *  that hit multiple DB tables (org also counts members per org). */
  accountRead: { max: 60, windowMs: 60_000 },
  /** GET /api/health?deep=true — unauthenticated DB roundtrip. The proxy
   *  leaves /api/health unlimited (orchestrators poll it without a
   *  session), so the deep branch rate-limits itself per IP: liveness
   *  stays free, but the DB-touching readiness probe can't be flooded. */
  healthDeep: { max: 30, windowMs: 60_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

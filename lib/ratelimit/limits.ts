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
  /** Per-user: agent mutations (POST/PATCH/DELETE /api/agents). 10/min. */
  agentMutate: { max: 10, windowMs: 60_000 },
  /** Per-user: agent reads (GET /api/agents). 60/min. */
  agentRead: { max: 60, windowMs: 60_000 },
  /** Per-user: thread mutations (PATCH/DELETE /api/threads). 30/min. */
  threadMutate: { max: 30, windowMs: 60_000 },
  /** Per-IP: sign-in/sign-up attempts. 10/min. */
  authIp: { max: 10, windowMs: 60_000 },
  /** Per-IP: global flood protection on all /api/* routes. 300/min.
   *  Generous enough for active use (page refreshes, CopilotKit connect/info
   *  streams, conversation switching) while still blocking flood attacks. */
  globalIp: { max: 300, windowMs: 60_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

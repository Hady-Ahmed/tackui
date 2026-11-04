/**
 * Per-user daily counter for platform-key builder-agent runs.
 *
 * A run is "platform-key" when tackui does NOT deliver the runner's own
 * key for a dependency the run needs — i.e. the platform key (mini-tier
 * model via the AgentOS env, or a tool's platform fallback) serves it.
 * BYOK runs (runner's key delivered as an AG-UI context dep) never touch
 * this counter — they cost the platform ~nothing.
 *
 * Backed by lib/ratelimit's sliding-window store: same in-memory
 * single-instance semantics as every other limit here (swap for Redis in
 * multi-instance deployments). The counter is consumed at run start —
 * a run that fails mid-flight still counts (the platform key was spent),
 * and a gate that blocks the run before it starts does not consume.
 */

import { checkLimit } from "./store";

/** Rolling 24h window — matches the catalog daily-quota window. */
const PLATFORM_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable key prefix so the counter can't collide with a user limit name. */
const PLATFORM_QUOTA_KEY = "platformKeyDaily";

export interface PlatformQuotaResult {
  allowed: boolean;
  /** Epoch ms when the oldest run in the window falls out of the window. */
  resetAt: number;
  /** Runs consumed in the current window (includes this run when allowed). */
  used: number;
}

/**
 * Check and consume one platform-key run slot. `max` comes from the
 * plan's `platformDailyQuota` (null/unlimited is handled by the caller —
 * the gate short-circuits before calling this).
 */
export function consumePlatformKeyQuota(
  userId: string,
  max: number,
): PlatformQuotaResult {
  const result = checkLimit(
    `${PLATFORM_QUOTA_KEY}:${userId}`,
    max,
    PLATFORM_QUOTA_WINDOW_MS,
  );
  return {
    allowed: result.allowed,
    resetAt: result.resetAt,
    used: max - result.remaining,
  };
}

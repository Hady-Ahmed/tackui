/**
 * In-memory rate-limit store for single-instance deployments.
 *
 * Two types of limits:
 * 1. **Sliding-window** — counts requests in a time window. When the
 *    window expires, the counter resets. Used for request-rate limits
 *    (e.g. "20 runs per minute").
 * 2. **Concurrent** — tracks in-flight items. Caller must increment on
 *    start and decrement on completion. Used for concurrent-stream caps
 *    (e.g. "3 concurrent SSE streams").
 *
 * State lives in module-level `Map`s — shared across all requests in the
 * same Node.js process. A GC sweep runs periodically to evict expired
 * entries (prevents memory growth from one-off IP/user keys).
 *
 * For multi-instance deployments, replace this with a Redis-backed store.
 * The interface stays the same — `checkLimit` / `increment` / `decrement`.
 */

interface WindowEntry {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowEntry>();
const concurrent = new Map<string, number>();

const GC_INTERVAL_MS = 60_000;
let gcTimer: ReturnType<typeof setInterval> | null = null;

function ensureGc() {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (entry.resetAt <= now) windows.delete(key);
    }
    for (const [key, count] of concurrent) {
      if (count <= 0) concurrent.delete(key);
    }
  }, GC_INTERVAL_MS);
  gcTimer.unref();
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check a sliding-window rate limit. If allowed, increments the counter.
 * Key should be `${limitName}:${identifier}` (e.g. `copilotkit:user-123`).
 */
export function checkLimit(
  key: string,
  max: number,
  windowMs: number,
): RateLimitResult {
  ensureGc();
  const now = Date.now();
  const entry = windows.get(key);

  if (!entry || entry.resetAt <= now) {
    // First request or window expired — start fresh.
    const resetAt = now + windowMs;
    windows.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: max - 1, resetAt };
  }

  if (entry.count >= max) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: max - entry.count,
    resetAt: entry.resetAt,
  };
}

export interface ConcurrentResult {
  allowed: boolean;
  current: number;
}

/**
 * Check a concurrent limit WITHOUT incrementing. Caller must call
 * `incrementConcurrent` if allowed, and `decrementConcurrent` when the
 * item completes (on success, error, or abort).
 */
export function checkConcurrent(
  key: string,
  max: number,
): ConcurrentResult {
  ensureGc();
  const current = concurrent.get(key) ?? 0;
  return { allowed: current < max, current };
}

/**
 * Increment the concurrent counter. Call after `checkConcurrent` returns
 * `allowed: true`.
 */
export function incrementConcurrent(key: string): number {
  const current = (concurrent.get(key) ?? 0) + 1;
  concurrent.set(key, current);
  return current;
}

/**
 * Decrement the concurrent counter. Call on EVERY exit path — success,
 * error, stream close, client disconnect. Idempotent (never goes below 0).
 */
export function decrementConcurrent(key: string): number {
  const current = Math.max(0, (concurrent.get(key) ?? 0) - 1);
  if (current === 0) {
    concurrent.delete(key);
  } else {
    concurrent.set(key, current);
  }
  return current;
}

/**
 * Get the current concurrent count for a key (without modifying it).
 * Useful for debugging / metrics.
 */
export function getConcurrent(key: string): number {
  return concurrent.get(key) ?? 0;
}

/**
 * Reset all state — for tests only.
 */
export function _resetForTests(): void {
  windows.clear();
  concurrent.clear();
}

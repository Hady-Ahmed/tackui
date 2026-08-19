import { NextResponse } from "next/server";
import {
  checkLimit,
  checkConcurrent,
  incrementConcurrent,
  decrementConcurrent,
  type RateLimitResult,
} from "./store";
import { LIMITS, type LimitName } from "./limits";
import { isAuthDisabled } from "@/lib/auth/auth";

// Max wall-clock time a concurrent-run slot can be held before the
// watchdog force-releases it. This is a SAFETY NET, not a run-cancellation:
// the actual SSE stream / agent execution keeps running untouched. The
// watchdog only releases the rate-limit accounting slot so a malicious
// user can't stall N slots indefinitely by opening N runs and dropping
// TCP without triggering ReadableStream.cancel() (the normal release path).
//
// Side effect: if a legitimate run takes longer than this, the user's
// concurrent counter drops early — they could start another run before
// the slow one finishes. That's a soft tradeoff (occasionally
// under-counting) vs the alternative (permanently over-counting on
// abandoned connections, requiring a server restart to clear).
//
// Default 10 min — generous for chat-style AG-UI token streaming.
// Override with CONCURRENT_RUN_TIMEOUT_MS (milliseconds) if your
// agents do long research runs.
const CONCURRENT_RUN_TIMEOUT_MS = Math.max(
  60_000, // floor: 1 min — never lower than this
  Number(process.env.CONCURRENT_RUN_TIMEOUT_MS ?? "") || 10 * 60 * 1000,
);

/**
 * Build a 429 Too Many Requests response with standard rate-limit headers.
 */
export function rateLimitResponse(
  result: RateLimitResult,
  message: string,
): NextResponse {
  const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: {
        "X-RateLimit-Limit": String(result.remaining + 1),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.floor(result.resetAt / 1000)),
        "Retry-After": String(Math.max(1, retryAfter)),
      },
    },
  );
}

/**
 * Build a 429 for concurrent-limit exceeded.
 */
export function concurrentLimitResponse(max: number): NextResponse {
  return NextResponse.json(
    {
      error: `Too many concurrent agent runs (${max} max). Wait for one to finish.`,
    },
    {
      status: 429,
      headers: {
        "X-RateLimit-Limit": String(max),
        "X-RateLimit-Remaining": "0",
        "Retry-After": "10",
      },
    },
  );
}

/**
 * Check a named sliding-window limit for a user/IP. Returns a 429
 * NextResponse if exceeded, or null if allowed (in which case the counter
 * has been incremented).
 *
 * Usage in a route handler:
 * ```ts
 * const limited = checkUserLimit(user.id, "copilotkit");
 * if (limited) return limited;
 * ```
 *
 * `opts.max` overrides the preset's max — used by the SaaS plan-enforcement
 * layer to feed per-plan limits (e.g. free=10/min, pro=20/min). When
 * omitted, the preset's max from LIMITS is used (the self-host default).
 */
export function checkUserLimit(
  identifier: string,
  limitName: LimitName,
  opts?: { max?: number },
): NextResponse | null {
  // Solo mode (AUTH_DISABLED=true): per-user limits are not enforced.
  // Per-IP flood protection from proxy.ts still applies.
  if (isAuthDisabled()) return null;
  const limit = LIMITS[limitName];
  if (!("windowMs" in limit)) return null; // concurrent limits use checkConcurrent below
  const max = opts?.max ?? limit.max;
  const key = `${limitName}:${identifier}`;
  const result = checkLimit(key, max, limit.windowMs);
  if (!result.allowed) {
    return rateLimitResponse(
      result,
      `Rate limit exceeded. Try again in ${Math.ceil((result.resetAt - Date.now()) / 1000)} seconds.`,
    );
  }
  return null;
}

/**
 * Check, increment, and register a decrement hook for a concurrent limit.
 * Returns a 429 NextResponse if over cap, or a `release` function if
 * allowed. The caller MUST call `release()` on every exit path (success,
 * error, stream close).
 *
 * Usage:
 * ```ts
 * const concurrent = acquireConcurrent(user.id, "copilotkitConcurrent");
 * if (concurrent instanceof NextResponse) return concurrent;
 * // ... do work ...
 * // on completion:
 * concurrent.release();
 * ```
 */
export function acquireConcurrent(
  identifier: string,
  limitName: LimitName,
  opts?: { max?: number },
): NextResponse | (() => void) {
  // Solo mode (AUTH_DISABLED=true): concurrent cap is not enforced.
  if (isAuthDisabled()) return () => {};
  const limit = LIMITS[limitName];
  if (!("max" in limit) || "windowMs" in limit) return () => {}; // not a concurrent limit
  const max = opts?.max ?? limit.max;
  const key = `${limitName}:${identifier}`;
  const result = checkConcurrent(key, max);
  if (!result.allowed) {
    return concurrentLimitResponse(max);
  }
  incrementConcurrent(key);
  let released = false;
  // Watchdog: force-release the slot after CONCURRENT_RUN_TIMEOUT_MS
  // if release() hasn't been called. Prevents slot leaks when a client
  // opens a run and drops TCP without triggering the stream's
  // cancel/done/error path. The actual run is NOT cancelled — only the
  // rate-limit counter is decremented. See CONCURRENT_RUN_TIMEOUT_MS
  // doc above for the tradeoff.
  const watchdog = setTimeout(() => {
    if (released) return;
    released = true;
    decrementConcurrent(key);
    console.error("[ratelimit] watchdog force-released concurrent slot", {
      key,
      timeoutMs: CONCURRENT_RUN_TIMEOUT_MS,
    });
  }, CONCURRENT_RUN_TIMEOUT_MS);
  // unref so the timer can't keep the event loop alive on shutdown.
  watchdog.unref?.();
  return () => {
    if (released) return;
    released = true;
    clearTimeout(watchdog);
    decrementConcurrent(key);
  };
}

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
 */
export function checkUserLimit(
  identifier: string,
  limitName: LimitName,
): NextResponse | null {
  // Solo mode (AUTH_DISABLED=true): per-user limits are not enforced.
  // Per-IP flood protection from proxy.ts still applies.
  if (isAuthDisabled()) return null;
  const limit = LIMITS[limitName];
  if (!("windowMs" in limit)) return null; // concurrent limits use checkConcurrent below
  const key = `${limitName}:${identifier}`;
  const result = checkLimit(key, limit.max, limit.windowMs);
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
): NextResponse | (() => void) {
  // Solo mode (AUTH_DISABLED=true): concurrent cap is not enforced.
  if (isAuthDisabled()) return () => {};
  const limit = LIMITS[limitName];
  if (!("max" in limit) || "windowMs" in limit) return () => {}; // not a concurrent limit
  const key = `${limitName}:${identifier}`;
  const result = checkConcurrent(key, limit.max);
  if (!result.allowed) {
    return concurrentLimitResponse(limit.max);
  }
  incrementConcurrent(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    decrementConcurrent(key);
  };
}

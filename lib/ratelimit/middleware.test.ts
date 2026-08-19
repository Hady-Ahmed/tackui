import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// The middleware reads isAuthDisabled() at call time. The test env sets
// AUTH_DISABLED=true (vitest.setup.ts), which would short-circuit all
// limits to "allow". Mock it to false so the tests exercise the real
// rate-limit / concurrent-cap logic.
vi.mock("@/lib/auth/auth", () => ({
  isAuthDisabled: () => false,
}));

import {
  rateLimitResponse,
  concurrentLimitResponse,
  checkUserLimit,
  acquireConcurrent,
} from "./middleware";
import { _resetForTests, getConcurrent } from "./store";

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimitResponse", () => {
  it("returns 429 with rate-limit headers", () => {
    const res = rateLimitResponse(
      { allowed: false, remaining: 0, resetAt: Date.now() + 30_000 },
      "Rate limit exceeded",
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("includes the message in the JSON body", async () => {
    const res = rateLimitResponse(
      { allowed: false, remaining: 0, resetAt: Date.now() + 30_000 },
      "Rate limit exceeded. Try again in 30 seconds.",
    );
    const data = await res.json();
    expect(data.error).toContain("Rate limit exceeded");
  });
});

describe("concurrentLimitResponse", () => {
  it("returns 429 with max in the message", async () => {
    const res = concurrentLimitResponse(3);
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toContain("3 max");
  });
});

describe("checkUserLimit", () => {
  it("returns null when under the limit", () => {
    const result = checkUserLimit("user-1", "agentMutate");
    expect(result).toBeNull();
  });

  it("returns 429 when over the limit", () => {
    // Exhaust the limit (10/min)
    for (let i = 0; i < 10; i++) {
      checkUserLimit("user-1", "agentMutate");
    }
    const result = checkUserLimit("user-1", "agentMutate");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it("tracks users independently", () => {
    for (let i = 0; i < 10; i++) {
      checkUserLimit("user-1", "agentMutate");
    }
    expect(checkUserLimit("user-2", "agentMutate")).toBeNull();
  });
});

describe("acquireConcurrent", () => {
  it("returns a release function when allowed", () => {
    const result = acquireConcurrent("user-1", "copilotkitConcurrent");
    expect(typeof result).toBe("function");
  });

  it("returns 429 when concurrent cap is reached", () => {
    acquireConcurrent("user-1", "copilotkitConcurrent");
    acquireConcurrent("user-1", "copilotkitConcurrent");
    acquireConcurrent("user-1", "copilotkitConcurrent");
    const result = acquireConcurrent("user-1", "copilotkitConcurrent");
    expect(result).not.toBeNull();
    expect(typeof result).not.toBe("function");
    expect((result as Response).status).toBe(429);
  });

  it("release decrements the count, allowing new acquisitions", () => {
    const release1 = acquireConcurrent("user-1", "copilotkitConcurrent") as () => void;
    acquireConcurrent("user-1", "copilotkitConcurrent");
    acquireConcurrent("user-1", "copilotkitConcurrent");
    expect(acquireConcurrent("user-1", "copilotkitConcurrent")).toBeInstanceOf(Response);

    release1();
    const result = acquireConcurrent("user-1", "copilotkitConcurrent");
    expect(typeof result).toBe("function");
  });

  it("release is idempotent (safe to call twice)", () => {
    const release = acquireConcurrent("user-1", "copilotkitConcurrent") as () => void;
    release();
    release(); // should not throw or go negative
    // Should be able to acquire 3 times again
    expect(typeof acquireConcurrent("user-1", "copilotkitConcurrent")).toBe("function");
    expect(typeof acquireConcurrent("user-1", "copilotkitConcurrent")).toBe("function");
    expect(typeof acquireConcurrent("user-1", "copilotkitConcurrent")).toBe("function");
  });

  it("watchdog force-releases the slot after the timeout if release() is never called", () => {
    // Real-world scenario this guards: a client opens a run and drops
    // TCP without triggering ReadableStream.cancel() (the normal release
    // path). Without the watchdog, the slot leaks until server restart.
    vi.useFakeTimers();
    const key = "user-1";
    // Acquire but DON'T release — simulate a stalled client.
    const release = acquireConcurrent(key, "copilotkitConcurrent") as () => void;
    expect(typeof release).toBe("function");
    expect(getConcurrent(`copilotkitConcurrent:${key}`)).toBe(1);

    // Advance past the watchdog timeout (default 10 min).
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    // The watchdog must have decremented the counter.
    expect(getConcurrent(`copilotkitConcurrent:${key}`)).toBe(0);

    // And the slot is now reusable.
    const release2 = acquireConcurrent(key, "copilotkitConcurrent");
    expect(typeof release2).toBe("function");
    (release2 as () => void)();
  });

  it("watchdog is cancelled when release() is called normally", () => {
    vi.useFakeTimers();
    const key = "user-2";
    const release = acquireConcurrent(key, "copilotkitConcurrent") as () => void;
    expect(getConcurrent(`copilotkitConcurrent:${key}`)).toBe(1);

    release(); // normal release — should clear the watchdog
    expect(getConcurrent(`copilotkitConcurrent:${key}`)).toBe(0);

    // Advance past the timeout — watchdog must NOT fire (counter stays 0,
    // no negative count, no error logged).
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(getConcurrent(`copilotkitConcurrent:${key}`)).toBe(0);
  });
});

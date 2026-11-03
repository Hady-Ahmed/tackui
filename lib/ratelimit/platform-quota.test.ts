import { describe, it, expect, beforeEach } from "vitest";
import { consumePlatformKeyQuota } from "./platform-quota";
import { _resetForTests, checkLimit } from "./store";

beforeEach(() => {
  _resetForTests();
});

describe("consumePlatformKeyQuota", () => {
  it("allows up to max runs and counts each consumed run", () => {
    const first = consumePlatformKeyQuota("user-1", 3);
    expect(first.allowed).toBe(true);
    expect(first.used).toBe(1);

    const second = consumePlatformKeyQuota("user-1", 3);
    expect(second.allowed).toBe(true);
    expect(second.used).toBe(2);

    const third = consumePlatformKeyQuota("user-1", 3);
    expect(third.allowed).toBe(true);
    expect(third.used).toBe(3);
  });

  it("refuses the run that exceeds max, reporting the used count", () => {
    for (let i = 0; i < 5; i++) consumePlatformKeyQuota("user-1", 5);
    const refused = consumePlatformKeyQuota("user-1", 5);
    expect(refused.allowed).toBe(false);
    expect(refused.used).toBe(5);
    // A refused run does NOT consume a slot: the used count stays at max.
    const stillRefused = consumePlatformKeyQuota("user-1", 5);
    expect(stillRefused.allowed).toBe(false);
    expect(stillRefused.used).toBe(5);
  });

  it("keys are per-user — one user's spend never gates another's", () => {
    for (let i = 0; i < 2; i++) consumePlatformKeyQuota("user-1", 2);
    expect(consumePlatformKeyQuota("user-1", 2).allowed).toBe(false);
    // A different user starts from zero.
    expect(consumePlatformKeyQuota("user-2", 2).allowed).toBe(true);
  });

  it("exhausting the quota never consumes a route limit's budget (disjoint key namespaces)", () => {
    // Route limiters key as `${limitName}:${userId}` (copilotkit:user-1 …);
    // the quota's platformKeyDaily prefix lives outside that namespace —
    // spending the daily quota doesn't touch any route counter, and
    // hammering the run limit doesn't spend quota.
    for (let i = 0; i < 3; i++) consumePlatformKeyQuota("user-1", 3); // quota exhausted
    for (let i = 0; i < 20; i++) {
      expect(checkLimit("copilotkit:user-1", 20, 60_000).allowed).toBe(true);
    }
    expect(checkLimit("copilotkit:user-1", 20, 60_000).allowed).toBe(false);

    // And the reverse: 20 exhausted run-limit requests didn't spend quota.
    const result = consumePlatformKeyQuota("user-1", 3);
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(3);
  });

  it("reports resetAt as a future epoch (the rolling window edge)", () => {
    const before = Date.now();
    const result = consumePlatformKeyQuota("user-1", 1);
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkLimit,
  checkConcurrent,
  incrementConcurrent,
  decrementConcurrent,
  getConcurrent,
  _resetForTests,
} from "./store";

beforeEach(() => {
  _resetForTests();
});

describe("checkLimit (sliding window)", () => {
  it("allows first request and starts a window", () => {
    const result = checkLimit("test:user-1", 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it("increments count on subsequent requests", () => {
    checkLimit("test:user-1", 5, 60_000);
    checkLimit("test:user-1", 5, 60_000);
    const result = checkLimit("test:user-1", 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks when limit is reached", () => {
    for (let i = 0; i < 5; i++) {
      checkLimit("test:user-1", 5, 60_000);
    }
    const result = checkLimit("test:user-1", 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("does not increment when blocked", () => {
    for (let i = 0; i < 5; i++) {
      checkLimit("test:user-1", 5, 60_000);
    }
    checkLimit("test:user-1", 5, 60_000); // blocked
    // Try again — still blocked, count didn't go to 6
    const result = checkLimit("test:user-1", 5, 60_000);
    expect(result.allowed).toBe(false);
  });

  it("resets after the window expires", () => {
    vi.useFakeTimers();
    checkLimit("test:user-1", 2, 60_000);
    checkLimit("test:user-1", 2, 60_000);
    expect(checkLimit("test:user-1", 2, 60_000).allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(61_000);
    const result = checkLimit("test:user-1", 2, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
    vi.useRealTimers();
  });

  it("tracks separate keys independently", () => {
    checkLimit("test:user-1", 2, 60_000);
    checkLimit("test:user-1", 2, 60_000);
    expect(checkLimit("test:user-1", 2, 60_000).allowed).toBe(false);
    expect(checkLimit("test:user-2", 2, 60_000).allowed).toBe(true);
  });

  it("uses fresh window when resetAt is in the past", () => {
    vi.useFakeTimers();
    const result1 = checkLimit("test:user-1", 2, 10_000);
    vi.advanceTimersByTime(11_000);
    const result2 = checkLimit("test:user-1", 2, 10_000);
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(1);
    expect(result2.resetAt).toBeGreaterThan(result1.resetAt);
    vi.useRealTimers();
  });
});

describe("checkConcurrent", () => {
  it("allows when count is below max", () => {
    const result = checkConcurrent("test:user-1", 3);
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(0);
  });

  it("blocks when count reaches max", () => {
    incrementConcurrent("test:user-1");
    incrementConcurrent("test:user-1");
    incrementConcurrent("test:user-1");
    const result = checkConcurrent("test:user-1", 3);
    expect(result.allowed).toBe(false);
    expect(result.current).toBe(3);
  });
});

describe("incrementConcurrent / decrementConcurrent", () => {
  it("increments and decrements correctly", () => {
    expect(getConcurrent("test:user-1")).toBe(0);
    incrementConcurrent("test:user-1");
    expect(getConcurrent("test:user-1")).toBe(1);
    incrementConcurrent("test:user-1");
    expect(getConcurrent("test:user-1")).toBe(2);
    decrementConcurrent("test:user-1");
    expect(getConcurrent("test:user-1")).toBe(1);
  });

  it("decrement never goes below 0", () => {
    decrementConcurrent("test:user-1");
    expect(getConcurrent("test:user-1")).toBe(0);
    decrementConcurrent("test:user-1");
    expect(getConcurrent("test:user-1")).toBe(0);
  });

  it("deletes the key when count reaches 0", () => {
    incrementConcurrent("test:user-1");
    decrementConcurrent("test:user-1");
    expect(getConcurrent("test:user-1")).toBe(0);
  });

  it("tracks separate keys independently", () => {
    incrementConcurrent("test:user-1");
    incrementConcurrent("test:user-2");
    incrementConcurrent("test:user-2");
    expect(getConcurrent("test:user-1")).toBe(1);
    expect(getConcurrent("test:user-2")).toBe(2);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";

// LIMITS reads its env override at module load, so each case re-imports
// the module after stubbing the env — the same boot-time contract the
// app runs under.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("LIMITS env overrides", () => {
  it("keeps the agentRead preset when no override is set", async () => {
    const { LIMITS } = await import("./limits");
    expect(LIMITS.agentRead.max).toBe(60);
    expect(LIMITS.agentRead.windowMs).toBe(60_000);
  });

  it("raises agentRead when AGENT_READ_RATE_MAX is a positive integer", async () => {
    vi.stubEnv("AGENT_READ_RATE_MAX", "600");
    const { LIMITS } = await import("./limits");
    expect(LIMITS.agentRead.max).toBe(600);
  });

  it("ignores junk, zero, and negative overrides — a typo can't disable a limit", async () => {
    vi.stubEnv("AGENT_READ_RATE_MAX", "banana");
    const { LIMITS } = await import("./limits");
    expect(LIMITS.agentRead.max).toBe(60);

    vi.stubEnv("AGENT_READ_RATE_MAX", "0");
    vi.resetModules();
    const { LIMITS: zero } = await import("./limits");
    expect(zero.agentRead.max).toBe(60);

    vi.stubEnv("AGENT_READ_RATE_MAX", "-5");
    vi.resetModules();
    const { LIMITS: negative } = await import("./limits");
    expect(negative.agentRead.max).toBe(60);
  });
});

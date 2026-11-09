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

  it("ignores junk, zero, negative, fractional, and empty overrides — a typo can't disable a limit", async () => {
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

    vi.stubEnv("AGENT_READ_RATE_MAX", "60.5");
    vi.resetModules();
    const { LIMITS: fractional } = await import("./limits");
    expect(fractional.agentRead.max).toBe(60);

    vi.stubEnv("AGENT_READ_RATE_MAX", "");
    vi.resetModules();
    const { LIMITS: empty } = await import("./limits");
    expect(empty.agentRead.max).toBe(60);
  });

  it("keeps the globalIp preset when no override is set", async () => {
    const { LIMITS } = await import("./limits");
    expect(LIMITS.globalIp.max).toBe(300);
    expect(LIMITS.globalIp.windowMs).toBe(60_000);
  });

  it("raises globalIp when GLOBAL_IP_RATE_MAX is a positive integer, ignores junk", async () => {
    vi.stubEnv("GLOBAL_IP_RATE_MAX", "1200");
    const { LIMITS } = await import("./limits");
    expect(LIMITS.globalIp.max).toBe(1200);

    vi.stubEnv("GLOBAL_IP_RATE_MAX", "banana");
    vi.resetModules();
    const { LIMITS: junk } = await import("./limits");
    expect(junk.globalIp.max).toBe(300);
  });
});

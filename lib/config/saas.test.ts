import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * lib/config/saas.ts exports module-level constants computed from env vars.
 * Because they're evaluated at import time, each test stubs the env and
 * re-imports the module fresh so the constants pick up the new values.
 */
describe("lib/config/saas", () => {
  const orig = { ...process.env };

  afterEach(() => {
    // Restore env, then reset modules so the next test's import re-evaluates.
    for (const k of Object.keys(process.env)) {
      if (!(k in orig)) delete process.env[k];
    }
    Object.assign(process.env, orig);
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return await import("@/lib/config/saas");
  }

  it("defaults to self-host mode when SAAS_MODE unset", async () => {
    delete process.env.SAAS_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    const m = await load();
    expect(m.SAAS_MODE).toBe(false);
    expect(m.BILLING_ENABLED).toBe(false);
    expect(m.SSRF_GUARD_FORCE_ON).toBe(false);
  });

  it("enables SaaS mode + forced SSRF guard when SAAS_MODE=true", async () => {
    process.env.SAAS_MODE = "true";
    delete process.env.STRIPE_SECRET_KEY;
    const m = await load();
    expect(m.SAAS_MODE).toBe(true);
    expect(m.SSRF_GUARD_FORCE_ON).toBe(true);
    // Without a Stripe key, billing stays off (users sit on Free).
    expect(m.BILLING_ENABLED).toBe(false);
  });

  it("enables billing only with both SAAS_MODE and STRIPE_SECRET_KEY", async () => {
    process.env.SAAS_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    const m = await load();
    expect(m.BILLING_ENABLED).toBe(true);
  });

  it("does NOT enable billing with a Stripe key but SaaS mode off", async () => {
    delete process.env.SAAS_MODE;
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    const m = await load();
    expect(m.BILLING_ENABLED).toBe(false);
    expect(m.SSRF_GUARD_FORCE_ON).toBe(false);
  });

  it("SSRF rejection message differs by mode", async () => {
    delete process.env.SAAS_MODE;
    const selfHost = await load();
    expect(selfHost.SSRF_REJECTION_MESSAGE).toContain("ALLOW_PRIVATE_ENDPOINTS");

    process.env.SAAS_MODE = "true";
    const saas = await load();
    expect(saas.SSRF_REJECTION_MESSAGE).toContain("not permitted on the hosted service");
    expect(saas.SSRF_REJECTION_MESSAGE).not.toContain("ALLOW_PRIVATE_ENDPOINTS");
  });
});

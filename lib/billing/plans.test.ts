import { describe, it, expect, afterEach, vi } from "vitest";
import { getPlanLimits, planIdFromPriceId, priceIdForPlan } from "./plans";

describe("billing/plans", () => {
  describe("getPlanLimits", () => {
    it("self-host = unlimited agents + unlimited members + canCreateOrg", () => {
      const l = getPlanLimits("self-host");
      expect(l.maxAgents).toBeNull();
      expect(l.maxMembers).toBeNull();
      expect(l.canCreateOrg).toBe(true);
      expect(l.concurrentRuns).toBe(3);
    });

    it("free = 3 agents, 1 concurrent, 1 member, no org creation", () => {
      const l = getPlanLimits("free");
      expect(l.maxAgents).toBe(3);
      expect(l.concurrentRuns).toBe(1);
      expect(l.runsPerMinute).toBe(10);
      expect(l.maxMembers).toBe(1);
      expect(l.canCreateOrg).toBe(false);
    });

    it("pro = unlimited agents, 3 concurrent, 1 member, no org creation", () => {
      const l = getPlanLimits("pro");
      expect(l.maxAgents).toBeNull();
      expect(l.concurrentRuns).toBe(3);
      expect(l.runsPerMinute).toBe(20);
      expect(l.maxMembers).toBe(1);
      expect(l.canCreateOrg).toBe(false);
    });

    it("team = unlimited agents, 5 concurrent, canCreateOrg", () => {
      const l = getPlanLimits("team");
      expect(l.maxAgents).toBeNull();
      expect(l.concurrentRuns).toBe(5);
      expect(l.maxMembers).toBeNull(); // governed by seats, not a hard cap
      expect(l.canCreateOrg).toBe(true);
    });
  });

  describe("defaultPlan", () => {
    const origSaas = process.env.SAAS_MODE;
    const origStripe = process.env.STRIPE_SECRET_KEY;

    afterEach(() => {
      if (origSaas === undefined) delete process.env.SAAS_MODE;
      else process.env.SAAS_MODE = origSaas;
      if (origStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = origStripe;
      vi.resetModules();
    });

    it("returns 'self-host' when BILLING_ENABLED is false", async () => {
      delete process.env.SAAS_MODE;
      vi.resetModules();
      const { defaultPlan } = await import("./plans");
      expect(defaultPlan()).toBe("self-host");
    });

    it("returns 'free' when BILLING_ENABLED is true", async () => {
      process.env.SAAS_MODE = "true";
      process.env.STRIPE_SECRET_KEY = "sk_test_x";
      vi.resetModules();
      const { defaultPlan } = await import("./plans");
      expect(defaultPlan()).toBe("free");
    });
  });

  describe("planIdFromPriceId", () => {
    afterEach(() => {
      delete process.env.STRIPE_PRICE_PRO;
      delete process.env.STRIPE_PRICE_TEAM;
      vi.resetModules();
    });

    it("maps STRIPE_PRICE_TEAM → team", () => {
      process.env.STRIPE_PRICE_TEAM = "price_team_xxx";
      expect(planIdFromPriceId("price_team_xxx")).toBe("team");
    });

    it("maps STRIPE_PRICE_PRO → pro", () => {
      process.env.STRIPE_PRICE_PRO = "price_pro_xxx";
      expect(planIdFromPriceId("price_pro_xxx")).toBe("pro");
    });

    it("defaults to free for unknown / null / undefined price ids", () => {
      expect(planIdFromPriceId("price_unknown")).toBe("free");
      expect(planIdFromPriceId(null)).toBe("free");
      expect(planIdFromPriceId(undefined)).toBe("free");
    });
  });

  describe("priceIdForPlan", () => {
    afterEach(() => {
      delete process.env.STRIPE_PRICE_PRO;
      delete process.env.STRIPE_PRICE_TEAM;
      vi.resetModules();
    });

    it("returns the env price id for pro / team", () => {
      process.env.STRIPE_PRICE_PRO = "price_pro_xxx";
      process.env.STRIPE_PRICE_TEAM = "price_team_xxx";
      expect(priceIdForPlan("pro")).toBe("price_pro_xxx");
      expect(priceIdForPlan("team")).toBe("price_team_xxx");
    });

    it("returns null when the env var is missing", () => {
      delete process.env.STRIPE_PRICE_PRO;
      delete process.env.STRIPE_PRICE_TEAM;
      expect(priceIdForPlan("pro")).toBeNull();
      expect(priceIdForPlan("team")).toBeNull();
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the subscription store + agent store so enforcement logic is tested
// in isolation (no DB). The store + agent-store have their own suites.
const mockGetOrgPlan = vi.fn();
const mockGetSubscription = vi.fn();
vi.mock("@/lib/billing/subscription-store", () => ({
  getOrgPlan: (...a: unknown[]) => mockGetOrgPlan(...a),
  getSubscription: (...a: unknown[]) => mockGetSubscription(...a),
}));

const mockListAgents = vi.fn();
vi.mock("@/lib/agents/agent-store", () => ({
  listAgents: (...a: unknown[]) => mockListAgents(...a),
}));

import {
  getEnforcementLimits,
  checkAgentCountLimit,
  checkMemberCountLimit,
  checkCanCreateOrg,
} from "./enforcement";

// These are imported at the top so the mock wiring applies, but the
// individual tests re-import under the right env via loadSaaS()/inline
// import. Reference them to satisfy the unused-vars rule.
void getEnforcementLimits;
void checkAgentCountLimit;
void checkMemberCountLimit;
void checkCanCreateOrg;

async function loadSaaS() {
  process.env.SAAS_MODE = "true";
  vi.resetModules();
  return await import("./enforcement");
}

describe("lib/plans/enforcement", () => {
  beforeEach(() => {
    mockGetOrgPlan.mockReset();
    mockGetSubscription.mockReset();
    mockListAgents.mockReset();
  });
  afterEach(() => {
    delete process.env.SAAS_MODE;
    vi.resetModules();
  });

  describe("getEnforcementLimits", () => {
    it("returns self-host limits without a DB call when !SAAS_MODE", async () => {
      // Default import: !SAAS_MODE
      const { getEnforcementLimits } = await import("./enforcement");
      const { plan, limits } = await getEnforcementLimits("org-1");
      expect(plan).toBe("self-host");
      expect(limits.maxAgents).toBeNull();
      expect(limits.maxMembers).toBeNull();
      expect(mockGetOrgPlan).not.toHaveBeenCalled();
    });

    it("reads the org plan under SaaS mode", async () => {
      mockGetOrgPlan.mockResolvedValue("pro");
      const { getEnforcementLimits } = await loadSaaS();
      const { plan, limits } = await getEnforcementLimits("org-1");
      expect(plan).toBe("pro");
      expect(limits.maxAgents).toBeNull(); // pro = unlimited agents
      expect(mockGetOrgPlan).toHaveBeenCalledWith("org-1");
    });
  });

  describe("checkAgentCountLimit", () => {
    it("always allows under self-host", async () => {
      const { checkAgentCountLimit } = await import("./enforcement");
      expect(await checkAgentCountLimit("org-1")).toBeNull();
      expect(mockListAgents).not.toHaveBeenCalled();
    });

    it("allows under free plan when under the cap (3)", async () => {
      mockGetOrgPlan.mockResolvedValue("free");
      mockListAgents.mockResolvedValue([{}, {}, {}]); // 3 — not yet over
      // free cap is 3; 3 existing agents means a 4th would be rejected.
      // Test the boundary: 2 existing → allowed.
      mockListAgents.mockResolvedValueOnce([{}, {}]);
      const { checkAgentCountLimit } = await loadSaaS();
      expect(await checkAgentCountLimit("org-1")).toBeNull();
    });

    it("rejects (402) under free plan at the cap", async () => {
      mockGetOrgPlan.mockResolvedValue("free");
      mockListAgents.mockResolvedValue([{}, {}, {}]); // 3 = cap
      const { checkAgentCountLimit } = await loadSaaS();
      const res = await checkAgentCountLimit("org-1");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(402);
      const data = await res!.json();
      expect(data.code).toBe("PLAN_AGENT_LIMIT");
      expect(data.limit).toBe(3);
    });

    it("allows unlimited agents under pro/team", async () => {
      mockGetOrgPlan.mockResolvedValue("pro");
      mockListAgents.mockResolvedValue(Array.from({ length: 1000 }));
      const { checkAgentCountLimit } = await loadSaaS();
      expect(await checkAgentCountLimit("org-1")).toBeNull();
      // pro maxAgents is null → listAgents not even needed, but called for count; fine.
    });
  });

  describe("checkMemberCountLimit", () => {
    it("always allows under self-host", async () => {
      const { checkMemberCountLimit } = await import("./enforcement");
      expect(await checkMemberCountLimit("org-1", 999)).toBeNull();
    });

    it("rejects (402) free/pro at 1 member (personal, no invites)", async () => {
      mockGetOrgPlan.mockResolvedValue("free");
      const { checkMemberCountLimit } = await loadSaaS();
      const res = await checkMemberCountLimit("org-1", 1);
      expect(res!.status).toBe(402);
      expect((await res!.json()).code).toBe("PLAN_SEAT_LIMIT");
    });

    it("allows team invites under the seat cap", async () => {
      mockGetOrgPlan.mockResolvedValue("team");
      mockGetSubscription.mockResolvedValue({ seats: 5 });
      const { checkMemberCountLimit } = await loadSaaS();
      expect(await checkMemberCountLimit("org-1", 4)).toBeNull();
    });

    it("rejects team invites at the seat cap", async () => {
      mockGetOrgPlan.mockResolvedValue("team");
      mockGetSubscription.mockResolvedValue({ seats: 5 });
      const { checkMemberCountLimit } = await loadSaaS();
      const res = await checkMemberCountLimit("org-1", 5);
      expect(res!.status).toBe(402);
      expect((await res!.json()).seats).toBe(5);
    });
  });

  describe("checkCanCreateOrg", () => {
    it("always allows under self-host", async () => {
      const { checkCanCreateOrg } = await import("./enforcement");
      expect(await checkCanCreateOrg("org-1")).toBeNull();
    });

    it("always allows under SaaS (workspace creation is free — Team gates invites, not creation)", async () => {
      const { checkCanCreateOrg } = await loadSaaS();
      expect(await checkCanCreateOrg("org-1")).toBeNull();
    });

    it("always allows under SaaS even on free plan", async () => {
      mockGetOrgPlan.mockResolvedValue("free");
      const { checkCanCreateOrg } = await loadSaaS();
      expect(await checkCanCreateOrg("org-1")).toBeNull();
    });
  });
});

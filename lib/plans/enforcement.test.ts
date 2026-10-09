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
const mockGetAgent = vi.fn();
const mockCountAgents = vi.fn();
vi.mock("@/lib/agents/agent-store", () => ({
  listAgents: (...a: unknown[]) => mockListAgents(...a),
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
  countAgents: (...a: unknown[]) => mockCountAgents(...a),
}));

const mockGetTemplate = vi.fn();
const mockGetRunUsage = vi.fn();
vi.mock("@/lib/catalog/template-store", () => ({
  getTemplate: (...a: unknown[]) => mockGetTemplate(...a),
  getRunUsage: (...a: unknown[]) => mockGetRunUsage(...a),
}));

import {
  getEnforcementLimits,
  checkAgentCountLimit,
  checkMemberCountLimit,
  checkCanCreateOrg,
  planSatisfies,
  checkTemplateInstall,
  checkCatalogRunGates,
} from "./enforcement";

// These are imported at the top so the mock wiring applies, but the
// individual tests re-import under the right env via loadSaaS()/inline
// import. Reference them to satisfy the unused-vars rule.
void getEnforcementLimits;
void checkAgentCountLimit;
void checkMemberCountLimit;
void checkCanCreateOrg;
void planSatisfies;
void checkTemplateInstall;
void checkCatalogRunGates;

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
    mockGetAgent.mockReset();
    mockCountAgents.mockReset();
    mockGetTemplate.mockReset();
    mockGetRunUsage.mockReset();
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
      // free cap is 3; test the boundary: 2 existing → allowed.
      mockCountAgents.mockResolvedValueOnce(2);
      const { checkAgentCountLimit } = await loadSaaS();
      expect(await checkAgentCountLimit("org-1")).toBeNull();
    });

    it("rejects (402) under free plan at the cap", async () => {
      mockGetOrgPlan.mockResolvedValue("free");
      mockCountAgents.mockResolvedValue(3); // 3 = cap
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
      mockCountAgents.mockResolvedValue(1000);
      const { checkAgentCountLimit } = await loadSaaS();
      expect(await checkAgentCountLimit("org-1")).toBeNull();
      // pro maxAgents is null → countAgents not even called; fine.
    });

    it("tombstones don't consume the cap (counted via countAgents)", async () => {
      // countAgents excludes template-deleted rows; the enforcement layer
      // just trusts it — assert the boundary passes with tombstones present.
      mockGetOrgPlan.mockResolvedValue("free");
      mockCountAgents.mockResolvedValueOnce(1);
      const { checkAgentCountLimit } = await loadSaaS();
      expect(await checkAgentCountLimit("org-1")).toBeNull();
      expect(mockCountAgents).toHaveBeenCalledWith("org-1");
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

  describe("planSatisfies", () => {
    it("free < pro < team; self-host satisfies everything", async () => {
      const { planSatisfies } = await import("./enforcement");
      expect(planSatisfies("free", "pro")).toBe(false);
      expect(planSatisfies("pro", "pro")).toBe(true);
      expect(planSatisfies("team", "pro")).toBe(true);
      expect(planSatisfies("free", "team")).toBe(false);
      expect(planSatisfies("pro", "team")).toBe(false);
      expect(planSatisfies("team", "team")).toBe(true);
      expect(planSatisfies("self-host", "team")).toBe(true);
    });
  });

  describe("checkTemplateInstall", () => {
    const ungated = { id: "tpl-1", name: "Flight Finder" };
    const proGated = { id: "tpl-1", name: "Flight Finder", requiredPlan: "pro" };

    it("always allows under self-host (no plan concept)", async () => {
      const { checkTemplateInstall } = await import("./enforcement");
      expect(await checkTemplateInstall(proGated as never, "org-1")).toBeNull();
      expect(mockGetOrgPlan).not.toHaveBeenCalled();
    });

    it("allows ungated templates under SaaS without a plan lookup", async () => {
      const { checkTemplateInstall } = await loadSaaS();
      expect(await checkTemplateInstall(ungated as never, "org-1")).toBeNull();
      expect(mockGetOrgPlan).not.toHaveBeenCalled();
    });

    it("rejects (402 PLAN_AGENT_LOCKED) free orgs from pro-gated templates", async () => {
      mockGetOrgPlan.mockResolvedValue("free");
      const { checkTemplateInstall } = await loadSaaS();
      const res = await checkTemplateInstall(proGated as never, "org-1");
      expect(res!.status).toBe(402);
      const data = await res!.json();
      expect(data.code).toBe("PLAN_AGENT_LOCKED");
      expect(data.requiredPlan).toBe("pro");
      expect(data.error).toContain("Flight Finder");
      expect(data.error).toContain("pro");
    });

    it("allows pro orgs to install pro-gated templates", async () => {
      mockGetOrgPlan.mockResolvedValue("pro");
      const { checkTemplateInstall } = await loadSaaS();
      expect(await checkTemplateInstall(proGated as never, "org-1")).toBeNull();
    });

    it("allows team orgs to install pro-gated templates (plan rank)", async () => {
      mockGetOrgPlan.mockResolvedValue("team");
      const { checkTemplateInstall } = await loadSaaS();
      expect(await checkTemplateInstall(proGated as never, "org-1")).toBeNull();
    });
  });

  describe("checkCatalogRunGates", () => {
    const user = { id: "u1", orgId: "org-1" };
    const plainAgent = { id: "agent-1" };
    // A live managed agent (template installed, not tombstoned).
    const catalogAgent = {
      id: "agent-1",
      sourceTemplateId: "tpl-1",
    };
    const tombstonedAgent = {
      id: "agent-1",
      sourceTemplateId: "tpl-1",
      templateRemovedAt: new Date().toISOString(),
    };
    const activeTemplate = { id: "tpl-1", isActive: true };

    it("allows runs of non-catalog (manually-added) agents in both modes", async () => {
      mockGetAgent.mockResolvedValue(plainAgent);
      const selfHost = await import("./enforcement");
      expect(await selfHost.checkCatalogRunGates(user as never, "agent-1")).toBeNull();
      mockGetAgent.mockResolvedValue(plainAgent);
      const saas = await loadSaaS();
      expect(await saas.checkCatalogRunGates(user as never, "agent-1", "free")).toBeNull();
      expect(mockGetTemplate).not.toHaveBeenCalled();
    });

    it("tombstoned agents never run — 410 AGENT_REMOVED in BOTH modes (history stays viewable, runs are gone)", async () => {
      mockGetAgent.mockResolvedValue(tombstonedAgent);
      const selfHost = await import("./enforcement");
      let res = await selfHost.checkCatalogRunGates(user as never, "agent-1");
      expect(res!.status).toBe(410);
      expect((await res!.json()).code).toBe("AGENT_REMOVED");

      mockGetAgent.mockResolvedValue(tombstonedAgent);
      const saas = await loadSaaS();
      res = await saas.checkCatalogRunGates(user as never, "agent-1");
      expect(res!.status).toBe(410);
    });

    it("a managed agent whose template is missing is treated as removed (410) — no ungated-orphan path", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue(null);
      const { checkCatalogRunGates } = await import("./enforcement");
      const res = await checkCatalogRunGates(user as never, "agent-1");
      expect(res!.status).toBe(410);
      expect((await res!.json()).code).toBe("AGENT_REMOVED");
    });

    it("deactivated templates block runs — 402 AGENT_UNPUBLISHED in BOTH modes (reversible kill switch)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ id: "tpl-1", isActive: false, name: "Flight Finder" });
      const selfHost = await import("./enforcement");
      let res = await selfHost.checkCatalogRunGates(user as never, "agent-1");
      expect(res!.status).toBe(402);
      let data = await res!.json();
      expect(data.code).toBe("AGENT_UNPUBLISHED");
      expect(data.error).toContain("Flight Finder");

      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ id: "tpl-1", isActive: false, name: "Flight Finder" });
      const saas = await loadSaaS();
      res = await saas.checkCatalogRunGates(user as never, "agent-1");
      expect(res!.status).toBe(402);
      data = await res!.json();
      expect(data.code).toBe("AGENT_UNPUBLISHED");
    });

    it("allows free-plan runs under the daily quota (SaaS)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ ...activeTemplate, freeDailyQuota: 10 });
      mockGetRunUsage.mockResolvedValue({ count: 9, oldestAt: new Date().toISOString() });
      const { checkCatalogRunGates } = await loadSaaS();
      expect(await checkCatalogRunGates(user as never, "agent-1", "free")).toBeNull();
    });

    it("rejects (402 AGENT_QUOTA_EXCEEDED) free-plan runs at the daily quota (SaaS)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ ...activeTemplate, freeDailyQuota: 10 });
      mockGetRunUsage.mockResolvedValue({ count: 10, oldestAt: new Date().toISOString() });
      const { checkCatalogRunGates } = await loadSaaS();
      const res = await checkCatalogRunGates(user as never, "agent-1", "free");
      expect(res!.status).toBe(402);
      const data = await res!.json();
      expect(data.code).toBe("AGENT_QUOTA_EXCEEDED");
      expect(data.quota).toBe(10);
      expect(data.used).toBe(10);
      expect(typeof data.resetsAt).toBe("number");
      // Vague-copy policy: the message never states the run number.
      expect(data.error).not.toContain("10");
      expect(data.error).toContain("resets in");
      expect(data.error).toContain("Upgrade to Pro");
    });

    it("unlimited (no quota) templates never gate free runs (SaaS)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue(activeTemplate);
      const { checkCatalogRunGates } = await loadSaaS();
      expect(await checkCatalogRunGates(user as never, "agent-1", "free")).toBeNull();
      expect(mockGetRunUsage).not.toHaveBeenCalled();
    });

    it("paid plans skip the quota (unlimited catalog usage, SaaS)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ ...activeTemplate, freeDailyQuota: 10 });
      const { checkCatalogRunGates } = await loadSaaS();
      expect(await checkCatalogRunGates(user as never, "agent-1", "pro")).toBeNull();
      expect(mockGetRunUsage).not.toHaveBeenCalled();
    });

    it("re-fetches the plan from the DB when the caller doesn't pass one (SaaS)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ ...activeTemplate, freeDailyQuota: 10 });
      mockGetOrgPlan.mockResolvedValue("pro");
      const { checkCatalogRunGates } = await loadSaaS();
      expect(await checkCatalogRunGates(user as never, "agent-1")).toBeNull();
      expect(mockGetOrgPlan).toHaveBeenCalledWith("org-1");
    });

    it("blocks runs of gated agents for downgraded orgs (run-time plan gate, SaaS)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ ...activeTemplate, requiredPlan: "pro" });
      const { checkCatalogRunGates } = await loadSaaS();
      const res = await checkCatalogRunGates(user as never, "agent-1", "free");
      expect(res!.status).toBe(402);
      const data = await res!.json();
      expect(data.code).toBe("PLAN_AGENT_LOCKED");
    });

    it("counts from the log on EVERY run — quota 3 trips exactly on run 4 (no cache)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({ ...activeTemplate, freeDailyQuota: 3 });
      // Each gate call re-queries: prior runs land in agent_runs at run
      // end, so the count grows per completed run. Failed attempts that
      // produced no events never write a row → never counted (that's
      // the runner's storeRun contract, not this layer's).
      mockGetRunUsage
        .mockResolvedValueOnce({ count: 0, oldestAt: null })
        .mockResolvedValueOnce({ count: 1, oldestAt: new Date().toISOString() })
        .mockResolvedValueOnce({ count: 2, oldestAt: new Date().toISOString() })
        .mockResolvedValueOnce({ count: 3, oldestAt: new Date().toISOString() });
      const { checkCatalogRunGates } = await loadSaaS();
      expect(await checkCatalogRunGates(user as never, "agent-1", "free")).toBeNull();
      expect(await checkCatalogRunGates(user as never, "agent-1", "free")).toBeNull();
      expect(await checkCatalogRunGates(user as never, "agent-1", "free")).toBeNull();
      const res = await checkCatalogRunGates(user as never, "agent-1", "free");
      expect(res!.status).toBe(402);
      const data = await res!.json();
      expect(data.code).toBe("AGENT_QUOTA_EXCEEDED");
      expect(data.used).toBe(3);
      // Fresh query per run — no cache to go stale or over-consume.
      expect(mockGetRunUsage).toHaveBeenCalledTimes(4);
    });

    it("under self-host, live catalog agents run without billing gates (no plan lookup)", async () => {
      mockGetAgent.mockResolvedValue(catalogAgent);
      mockGetTemplate.mockResolvedValue({
        ...activeTemplate,
        freeDailyQuota: 10,
        requiredPlan: "pro",
      });
      const { checkCatalogRunGates } = await import("./enforcement");
      expect(await checkCatalogRunGates(user as never, "agent-1")).toBeNull();
      expect(mockGetRunUsage).not.toHaveBeenCalled();
      expect(mockGetOrgPlan).not.toHaveBeenCalled();
    });
  });
});

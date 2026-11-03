import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

const mockGetOrgSubscription = vi.fn();
vi.mock("@/lib/billing/subscription-store", () => ({
  getOrgSubscription: (...a: unknown[]) => mockGetOrgSubscription(...a),
}));

const mockGetPlanLimits = vi.fn();
vi.mock("@/lib/billing/plans", () => ({
  getPlanLimits: (...a: unknown[]) => mockGetPlanLimits(...a),
}));

// Rate limiting is mocked (the store has its own suite).
const mockCheckUserLimit = vi.fn().mockReturnValue(null);
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: (...a: unknown[]) => mockCheckUserLimit(...a),
}));

import { GET } from "./route";

const user = () => ({ id: "u1", role: "user", email: "t@e.com", orgId: "org-1" });

async function loadSaaS() {
  process.env.SAAS_MODE = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
  vi.resetModules();
  return await import("./route");
}

describe("GET /api/billing/subscription", () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetOrgSubscription.mockReset();
    mockGetPlanLimits.mockReset();
    mockCheckUserLimit.mockReset().mockReturnValue(null);
  });
  afterEach(() => {
    delete process.env.SAAS_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    vi.resetModules();
  });

  it("returns 404 when billing is not configured", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    const { GET } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the plan + limits for the current org", async () => {
    const { GET } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockGetOrgSubscription.mockResolvedValue({
      plan: "pro",
      public: { plan: "pro", status: "active", seats: 1, currentPeriodEnd: 1700000000 },
    });
    mockGetPlanLimits.mockReturnValue({ maxAgents: null, concurrentRuns: 3 });
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan).toBe("pro");
    expect(data.status).toBe("active");
    expect(data.limits.maxAgents).toBeNull();
    expect(mockGetOrgSubscription).toHaveBeenCalledWith("org-1");
  });

  it("enforces the accountRead rate limit", async () => {
    const { GET: G } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCheckUserLimit.mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await G();
    expect(res.status).toBe(429);
    expect(mockCheckUserLimit).toHaveBeenCalledWith("u1", "accountRead");
    expect(mockGetOrgSubscription).not.toHaveBeenCalled();
  });
});

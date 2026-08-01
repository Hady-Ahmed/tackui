import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const mockGetCurrentUser = vi.fn();
const mockCanManageAgents = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
  canManageAgents: (...a: unknown[]) => mockCanManageAgents(...a),
}));

const mockCreatePortalSession = vi.fn();
vi.mock("@/lib/billing/checkout", () => ({
  createPortalSession: (...a: unknown[]) => mockCreatePortalSession(...a),
}));

import { POST } from "./route";

const user = () => ({
  id: "u1",
  role: "user",
  name: "Test",
  email: "test@example.com",
  orgId: "org-1",
});

async function loadSaaS() {
  process.env.SAAS_MODE = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
  vi.resetModules();
  return await import("./route");
}

describe("POST /api/billing/portal", () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockCanManageAgents.mockReset();
    mockCreatePortalSession.mockReset();
  });
  afterEach(() => {
    delete process.env.SAAS_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    vi.resetModules();
  });

  it("returns 404 when billing is not configured", async () => {
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns 403 when user cannot manage agents", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(false);
    const res = await POST();
    expect(res.status).toBe(403);
  });

  it("returns 404 when there is no subscription to manage", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    mockCreatePortalSession.mockResolvedValue({ error: "No active subscription to manage." });
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it("returns the portal url on success", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    mockCreatePortalSession.mockResolvedValue({ url: "https://billing.stripe.com/portal" });
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://billing.stripe.com/portal");
    expect(mockCreatePortalSession).toHaveBeenCalledWith("org-1");
  });
});

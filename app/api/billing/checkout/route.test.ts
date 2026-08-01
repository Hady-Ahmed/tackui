import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock auth context so we control the user + permissions per test.
const mockGetCurrentUser = vi.fn();
const mockCanManageAgents = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
  canManageAgents: (...a: unknown[]) => mockCanManageAgents(...a),
}));

// Mock the checkout helper so we don't hit Stripe.
const mockCreateCheckoutSession = vi.fn();
vi.mock("@/lib/billing/checkout", () => ({
  createCheckoutSession: (...a: unknown[]) => mockCreateCheckoutSession(...a),
}));

import { POST } from "./route";

const user = (overrides: Record<string, unknown> = {}) => ({
  id: "u1",
  role: "user",
  name: "Test",
  email: "test@example.com",
  orgId: "org-1",
  ...overrides,
});

async function loadSaaS() {
  process.env.SAAS_MODE = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
  vi.resetModules();
  return await import("./route");
}

describe("POST /api/billing/checkout", () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockCanManageAgents.mockReset();
    mockCreateCheckoutSession.mockReset();
  });
  afterEach(() => {
    delete process.env.SAAS_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    vi.resetModules();
  });

  it("returns 404 when billing is not configured", async () => {
    // Default env: no SAAS_MODE → BILLING_ENABLED=false
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when user cannot manage agents", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(false);
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when user has no email", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user({ email: null }));
    mockCanManageAgents.mockResolvedValue(true);
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid body (bad plan)", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "enterprise" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 when createCheckoutSession errors", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ error: "no price configured" });
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("returns the checkout url on success", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/abc" });
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "team", seats: 5 }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe("https://checkout.stripe.com/abc");
    // Team passed seats through
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      "org-1",
      "team",
      expect.objectContaining({ seats: 5, customerEmail: "test@example.com" }),
    );
  });

  it("returns 400 when Team seats is 1 (min 2 — collaboration tier)", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "team", seats: 1 }),
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation failed");
    // Should NOT have called Stripe — rejected before that.
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("accepts Team with 2 seats (the minimum for collaboration)", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/abc" });
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "team", seats: 2 }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts Pro without a seats field (seats is irrelevant for Pro)", async () => {
    const { POST } = await loadSaaS();
    mockGetCurrentUser.mockResolvedValue(user());
    mockCanManageAgents.mockResolvedValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/abc" });
    const res = await POST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

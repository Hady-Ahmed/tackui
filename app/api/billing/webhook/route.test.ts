import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the Stripe SDK module. constructEventAsync returns a controlled
// event; subscriptions.retrieve returns a controlled subscription.
const mockConstructEvent = vi.fn();
const mockRetrieveSubscription = vi.fn();
const mockGetStripe = vi.fn();
vi.mock("@/lib/billing/stripe", () => ({
  getStripe: () => mockGetStripe(),
  getWebhookSecret: () => "whsec_test",
}));

// Mock the store so we can assert on upsert/delete calls without DB.
const mockUpsert = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockResolvedValue(true);
const mockGetOrgIdByCustomerId = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/billing/subscription-store", () => ({
  upsertSubscription: (...a: unknown[]) => mockUpsert(...a),
  deleteSubscription: (...a: unknown[]) => mockDelete(...a),
  getOrgIdByCustomerId: (...a: unknown[]) => mockGetOrgIdByCustomerId(...a),
}));

// Mock plans so price-id → plan mapping is deterministic.
vi.mock("@/lib/billing/plans", () => ({
  planIdFromPriceId: (priceId: string | null) =>
    priceId === "price_team" ? "team" : priceId === "price_pro" ? "pro" : "free",
}));

function stripeInstance() {
  return {
    webhooks: { constructEventAsync: mockConstructEvent },
    subscriptions: { retrieve: mockRetrieveSubscription },
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    status: "active",
    customer: "cus_123",
    metadata: {},
    current_period_end: 1700000000,
    items: {
      data: [{ quantity: 1, price: { id: "price_pro" } }],
    },
    ...overrides,
  };
}

function event(type: string, object: Record<string, unknown>) {
  return { type, data: { object } };
}

async function postWebhook(body = "{}", sig = "t=1,v1=valid") {
  const { POST } = await import("./route");
  return await POST(
    new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": sig },
      body,
    }),
  );
}

describe("POST /api/billing/webhook", () => {
  beforeEach(() => {
    mockConstructEvent.mockReset();
    mockRetrieveSubscription.mockReset();
    mockGetStripe.mockReset();
    mockUpsert.mockReset().mockResolvedValue(undefined);
    mockDelete.mockReset().mockResolvedValue(true);
    mockGetOrgIdByCustomerId.mockReset().mockResolvedValue(null);
    mockGetStripe.mockReturnValue(stripeInstance());
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("returns 200 { received: false } when Stripe isn't configured", async () => {
    mockGetStripe.mockReturnValue(null);
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(false);
  });

  it("returns 400 when the signature header is missing", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when signature verification fails", async () => {
    mockConstructEvent.mockRejectedValue(new Error("bad signature"));
    const res = await postWebhook();
    expect(res.status).toBe(400);
  });

  it("checkout.session.completed upserts a subscription row from metadata", async () => {
    mockConstructEvent.mockResolvedValue(
      event("checkout.session.completed", {
        id: "cs_1",
        metadata: { orgId: "org-A" },
        subscription: "sub_123",
        customer: "cus_123",
      }),
    );
    mockRetrieveSubscription.mockResolvedValue(
      subscription({ items: { data: [{ quantity: 5, price: { id: "price_team" } }] } }),
    );
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockRetrieveSubscription).toHaveBeenCalledWith("sub_123");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-A",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        plan: "team",
        seats: 5,
      }),
    );
  });

  it("checkout.session.completed logs and skips when metadata has no orgId", async () => {
    mockConstructEvent.mockResolvedValue(
      event("checkout.session.completed", {
        id: "cs_1",
        metadata: {},
        subscription: "sub_123",
        customer: "cus_123",
      }),
    );
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("customer.subscription.updated upserts using metadata orgId", async () => {
    mockConstructEvent.mockResolvedValue(
      event(
        "customer.subscription.updated",
        subscription({ metadata: { orgId: "org-B" } }),
      ),
    );
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-B", plan: "pro" }),
    );
  });

  it("customer.subscription.updated falls back to customer-id lookup", async () => {
    mockConstructEvent.mockResolvedValue(
      event("customer.subscription.updated", subscription({ metadata: {} })),
    );
    mockGetOrgIdByCustomerId.mockResolvedValue("org-via-lookup");
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockGetOrgIdByCustomerId).toHaveBeenCalledWith("cus_123");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-via-lookup" }),
    );
  });

  it("customer.subscription.deleted deletes the row", async () => {
    mockConstructEvent.mockResolvedValue(
      event(
        "customer.subscription.deleted",
        subscription({ metadata: { orgId: "org-C" } }),
      ),
    );
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("org-C");
  });

  it("customer.subscription.deleted with no resolvable orgId is a no-op", async () => {
    mockConstructEvent.mockResolvedValue(
      event("customer.subscription.deleted", subscription({ metadata: {} })),
    );
    mockGetOrgIdByCustomerId.mockResolvedValue(null);
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("unhandled event types are acknowledged (200)", async () => {
    mockConstructEvent.mockResolvedValue(event("invoice.paid", {}));
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("returns 500 when a handler throws (so Stripe retries)", async () => {
    mockConstructEvent.mockResolvedValue(
      event(
        "customer.subscription.updated",
        subscription({ metadata: { orgId: "org-X" } }),
      ),
    );
    mockUpsert.mockRejectedValue(new Error("db down"));
    const res = await postWebhook();
    expect(res.status).toBe(500);
  });

  it("customer.subscription.updated drops when metadata orgId disagrees with customer-id lookup (tampered metadata)", async () => {
    // Defense against Stripe-account compromise: if someone edits the
    // subscription's metadata in Stripe to point at a different org,
    // the cross-check against our own DB (row created at checkout)
    // catches the mismatch and refuses to write a paid-plan row.
    mockConstructEvent.mockResolvedValue(
      event(
        "customer.subscription.updated",
        subscription({ metadata: { orgId: "org-attacker" } }),
      ),
    );
    mockGetOrgIdByCustomerId.mockResolvedValue("org-legit");
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("customer.subscription.updated upserts when metadata orgId matches the customer-id lookup", async () => {
    mockConstructEvent.mockResolvedValue(
      event(
        "customer.subscription.updated",
        subscription({ metadata: { orgId: "org-same" } }),
      ),
    );
    mockGetOrgIdByCustomerId.mockResolvedValue("org-same");
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-same" }),
    );
  });

  it("customer.subscription.deleted drops when metadata orgId disagrees with customer-id lookup", async () => {
    mockConstructEvent.mockResolvedValue(
      event(
        "customer.subscription.deleted",
        subscription({ metadata: { orgId: "org-attacker" } }),
      ),
    );
    mockGetOrgIdByCustomerId.mockResolvedValue("org-legit");
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("customer.subscription.deleted with matching metadata + lookup proceeds", async () => {
    mockConstructEvent.mockResolvedValue(
      event(
        "customer.subscription.deleted",
        subscription({ metadata: { orgId: "org-same" } }),
      ),
    );
    mockGetOrgIdByCustomerId.mockResolvedValue("org-same");
    const res = await postWebhook();
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("org-same");
  });
});

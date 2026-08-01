import { describe, it, expect, beforeEach } from "vitest";
import { getSyntheticAdmin } from "@/lib/auth/context";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSubscription,
  getOrgPlan,
  getOrgSubscription,
  upsertSubscription,
  deleteSubscription,
  getOrgIdByCustomerId,
  upsertSubscriptionSchema,
  type UpsertSubscriptionInput,
} from "./subscription-store";

let testOrg: string;

beforeEach(async () => {
  await runMigrations();
  testOrg = (await getSyntheticAdmin()).orgId;
  // Clean up any subscription row left by a previous test (shared org id).
  await deleteSubscription(testOrg);
});

const baseInput = (overrides: Partial<UpsertSubscriptionInput> = {}): UpsertSubscriptionInput => ({
  orgId: testOrg,
  stripeCustomerId: "cus_test_123",
  stripeSubscriptionId: "sub_test_123",
  plan: "pro",
  status: "active",
  seats: 1,
  currentPeriodEnd: new Date("2026-12-31T00:00:00Z"),
  ...overrides,
});

describe("subscription-store", () => {
  describe("getSubscription", () => {
    it("returns null when no row exists", async () => {
      expect(await getSubscription(testOrg)).toBeNull();
    });

    it("returns the row after upsert", async () => {
      await upsertSubscription(baseInput());
      const row = await getSubscription(testOrg);
      expect(row).not.toBeNull();
      expect(row!.plan).toBe("pro");
      expect(row!.stripeCustomerId).toBe("cus_test_123");
      expect(row!.seats).toBe(1);
    });

    it("scopes by org id (other orgs invisible)", async () => {
      await upsertSubscription(baseInput());
      expect(await getSubscription("other-org-id")).toBeNull();
    });
  });

  describe("getOrgPlan", () => {
    it("returns the stored plan when a row exists", async () => {
      await upsertSubscription(baseInput({ plan: "team" }));
      expect(await getOrgPlan(testOrg)).toBe("team");
    });

    it("returns the default plan when no row exists", async () => {
      // !BILLING_ENABLED in test env → default is "self-host"
      expect(await getOrgPlan(testOrg)).toBe("self-host");
    });
  });

  describe("getOrgSubscription", () => {
    it("returns stored subscription with public shape", async () => {
      await upsertSubscription(baseInput({ plan: "pro", seats: 1 }));
      const { plan, public: sub } = await getOrgSubscription(testOrg);
      expect(plan).toBe("pro");
      expect(sub.plan).toBe("pro");
      expect(sub.seats).toBe(1);
      expect(sub.status).toBe("active");
      expect(sub.currentPeriodEnd).toBeGreaterThan(0);
    });

    it("returns default plan for missing rows", async () => {
      const { plan, public: sub } = await getOrgSubscription(testOrg);
      // test env: !BILLING_ENABLED → default "self-host"
      expect(plan).toBe("self-host");
      expect(sub.status).toBe("active");
      expect(sub.seats).toBe(1);
    });
  });

  describe("upsertSubscription", () => {
    it("inserts a new row", async () => {
      const row = await upsertSubscription(baseInput());
      expect(row.orgId).toBe(testOrg);
      expect(row.plan).toBe("pro");
    });

    it("updates an existing row on conflict (same org id)", async () => {
      await upsertSubscription(baseInput({ plan: "pro", seats: 1 }));
      const updated = await upsertSubscription(
        baseInput({ plan: "team", seats: 5, stripeSubscriptionId: "sub_new" }),
      );
      expect(updated.plan).toBe("team");
      expect(updated.seats).toBe(5);
      expect(updated.stripeSubscriptionId).toBe("sub_new");
      // Only one row for this org
      expect(await getSubscription(testOrg)).toMatchObject({ plan: "team" });
    });

    it("rejects invalid plan via zod", async () => {
      await expect(
        upsertSubscription(baseInput({ plan: "enterprise" as never })),
      ).rejects.toThrow();
    });

    it("rejects non-positive seats via zod", async () => {
      await expect(
        upsertSubscription(baseInput({ seats: 0 })),
      ).rejects.toThrow();
    });

    it("accepts the upsert schema shape directly", () => {
      const parsed = upsertSubscriptionSchema.safeParse(baseInput());
      expect(parsed.success).toBe(true);
    });
  });

  describe("deleteSubscription", () => {
    it("deletes a row and returns true", async () => {
      await upsertSubscription(baseInput());
      expect(await deleteSubscription(testOrg)).toBe(true);
      expect(await getSubscription(testOrg)).toBeNull();
    });

    it("returns false when no row exists", async () => {
      expect(await deleteSubscription("no-such-org")).toBe(false);
    });
  });

  describe("getOrgIdByCustomerId", () => {
    it("resolves org id from a stripe customer id", async () => {
      await upsertSubscription(
        baseInput({ stripeCustomerId: "cus_lookup_1" }),
      );
      expect(await getOrgIdByCustomerId("cus_lookup_1")).toBe(testOrg);
    });

    it("returns null for unknown customer id", async () => {
      expect(await getOrgIdByCustomerId("cus_unknown")).toBeNull();
    });
  });
});

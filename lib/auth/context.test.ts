import { describe, it, expect, beforeEach } from "vitest";
import { getCurrentUser, getRequestUser, canManageAgents } from "./context";
import { getRunnerUser, runWithUser, type RequestUser } from "./request-context";
import { query } from "@/lib/db/pg";

const testUser: RequestUser = {
  id: "test-user-id",
  role: "admin",
  name: "Test User",
  email: "test@example.com",
  orgId: "test-org-id",
};

describe("AUTH_DISABLED mode (set in vitest.setup.ts)", () => {
  it("getCurrentUser returns synthetic admin with orgId", async () => {
    const user = await getCurrentUser();
    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
    expect(user!.id).toBe("local");
    expect(user!.orgId).toBeTruthy();
  });

  it("getRequestUser returns synthetic admin for any request", async () => {
    const request = new Request("http://localhost/api/test");
    const user = await getRequestUser(request);
    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
    expect(user!.orgId).toBeTruthy();
  });
});

describe("AsyncLocalStorage (request-context)", () => {
  it("getRunnerUser returns null outside ALS context", () => {
    expect(getRunnerUser()).toBeNull();
  });

  it("runWithUser sets the user for sync callbacks", () => {
    const result = runWithUser(testUser, () => getRunnerUser());
    expect(result).toEqual(testUser);
  });

  it("runWithUserAsync sets the user for async callbacks", async () => {
    const { runWithUserAsync } = await import("./request-context");
    const result = await runWithUserAsync(testUser, async () => {
      return getRunnerUser();
    });
    expect(result).toEqual(testUser);
  });

  it("getRunnerUser is cleared after runWithUser scope exits", () => {
    runWithUser(testUser, () => {
      expect(getRunnerUser()).toEqual(testUser);
    });
    expect(getRunnerUser()).toBeNull();
  });

  it("nested ALS contexts work correctly", () => {
    const innerUser: RequestUser = { ...testUser, id: "inner-user" };
    runWithUser(testUser, () => {
      expect(getRunnerUser()?.id).toBe("test-user-id");
      runWithUser(innerUser, () => {
        expect(getRunnerUser()?.id).toBe("inner-user");
      });
      expect(getRunnerUser()?.id).toBe("test-user-id");
    });
  });
});

describe("canManageAgents", () => {
  const ORG = "org-canmanage";
  const PLATFORM_ADMIN: RequestUser = {
    id: "platform-admin", role: "admin", name: "P", email: null, orgId: ORG,
  };
  const ORG_OWNER: RequestUser = {
    id: "org-owner", role: "user", name: "O", email: null, orgId: ORG,
  };
  const ORG_MEMBER: RequestUser = {
    id: "org-member", role: "user", name: "M", email: null, orgId: ORG,
  };
  const NON_MEMBER: RequestUser = {
    id: "non-member", role: "user", name: "N", email: null, orgId: "other-org",
  };

  beforeEach(async () => {
    const exists = await query<{ exists: number }>(
      `SELECT count(*)::int as exists FROM information_schema.tables WHERE table_name = 'member'`,
    );
    if ((exists.rows[0]?.exists ?? 0) === 0) {
      await query(
        `CREATE TABLE member (id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT, role TEXT, "createdAt" TIMESTAMPTZ)`,
      );
    }
    await query(`DELETE FROM member`);
    await query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
      ["m1", ORG, "org-owner", "owner"],
    );
    await query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
      ["m2", ORG, "org-member", "member"],
    );
  });

  it("platform admin returns true (short-circuit, no DB query needed)", async () => {
    expect(await canManageAgents(PLATFORM_ADMIN)).toBe(true);
  });

  it("org owner returns true", async () => {
    expect(await canManageAgents(ORG_OWNER)).toBe(true);
  });

  it("org admin returns true", async () => {
    const orgAdmin: RequestUser = { ...ORG_MEMBER, id: "org-admin" };
    await query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
      ["m3", ORG, "org-admin", "admin"],
    );
    expect(await canManageAgents(orgAdmin)).toBe(true);
  });

  it("org member returns false", async () => {
    expect(await canManageAgents(ORG_MEMBER)).toBe(false);
  });

  it("non-member returns false", async () => {
    expect(await canManageAgents(NON_MEMBER)).toBe(false);
  });
});

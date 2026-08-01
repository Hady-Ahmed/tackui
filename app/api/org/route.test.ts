import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock auth context — synthetic admin in solo mode (test env default).
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

// Mock enforcement + subscription-store so the route is tested in
// isolation. Defaults to "allowed / unlimited".
const mockCheckCanCreateOrg = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/plans/enforcement", () => ({
  checkCanCreateOrg: (...a: unknown[]) => mockCheckCanCreateOrg(...a),
}));

const mockGetMembershipLimit = vi.fn().mockResolvedValue(Infinity);
vi.mock("@/lib/billing/subscription-store", () => ({
  getMembershipLimit: (...a: unknown[]) => mockGetMembershipLimit(...a),
}));

// Mock the DB query — the route joins member + organization. Return a
// controlled row set per test.
const mockQuery = vi.fn();
vi.mock("@/lib/db/pg", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import { GET } from "./route";

const user = (orgId = "org-1") => ({
  id: "u1",
  role: "admin",
  email: "t@e.com",
  orgId,
});

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockCheckCanCreateOrg.mockReset();
  mockGetMembershipLimit.mockReset();
  mockQuery.mockReset();
  // re-establish defaults after reset
  mockCheckCanCreateOrg.mockResolvedValue(null);
  mockGetMembershipLimit.mockResolvedValue(Infinity);
  mockQuery.mockImplementation(async (sql: string) => {
    // member count query
    if (sql.includes("count(*)")) {
      return { rows: [{ count: 1 }] };
    }
    // orgs list query
    return {
      rows: [{ id: "org-1", name: "Acme", slug: "acme", role: "owner" }],
    };
  });
});

describe("GET /api/org", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the user's orgs + seat info", async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeOrgId).toBe("org-1");
    expect(data.orgs).toHaveLength(1);
    expect(data.orgs[0].name).toBe("Acme");
    expect(data.canCreateOrg).toBe(true);
    expect(data.seats).toBeNull(); // Infinity → null
    expect(data.memberCount).toBe(1);
  });

  it("reports a finite seat cap when the plan limits seats", async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockGetMembershipLimit.mockResolvedValue(5);
    const res = await GET();
    const data = await res.json();
    expect(data.seats).toBe(5);
  });

  it("reports canCreateOrg=false when the plan blocks creation", async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    const { NextResponse } = await import("next/server");
    mockCheckCanCreateOrg.mockResolvedValue(
      NextResponse.json({ error: "no" }, { status: 403 }),
    );
    const res = await GET();
    const data = await res.json();
    expect(data.canCreateOrg).toBe(false);
  });
});

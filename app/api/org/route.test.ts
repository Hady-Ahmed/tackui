import { describe, it, expect, beforeEach, vi } from "vitest";

const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

const mockCheckCanCreateOrg = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/plans/enforcement", () => ({
  checkCanCreateOrg: (...a: unknown[]) => mockCheckCanCreateOrg(...a),
}));

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
  mockQuery.mockReset();
  mockCheckCanCreateOrg.mockResolvedValue(null);
  mockQuery.mockImplementation(async (sql: string) => {
    // Member count query (GROUP BY)
    if (sql.includes("GROUP BY")) {
      return { rows: [{ organizationId: "org-1", count: 1 }, { organizationId: "org-2", count: 3 }] };
    }
    // Org list query (JOIN + LEFT JOIN subscriptions)
    return {
      rows: [
        { id: "org-1", name: "Personal", slug: "personal", role: "owner", plan: "free", seats: null },
        { id: "org-2", name: "My Team", slug: "my-team", role: "owner", plan: "team", seats: 5 },
      ],
    };
  });
});

describe("GET /api/org", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns orgs with per-org plan + seats + memberCount", async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.orgs).toHaveLength(2);
    expect(data.orgs[0]).toMatchObject({ id: "org-1", name: "Personal", plan: "free", seats: null, memberCount: 1 });
    expect(data.orgs[1]).toMatchObject({ id: "org-2", name: "My Team", plan: "team", seats: 5, memberCount: 3 });
  });

  it("includes active org's seat info at the top level", async () => {
    mockGetCurrentUser.mockResolvedValue(user("org-2"));
    const res = await GET();
    const data = await res.json();
    expect(data.activeOrgId).toBe("org-2");
    expect(data.seats).toBe(5);
    expect(data.memberCount).toBe(3);
  });

  it("returns null seats for a Free active org", async () => {
    mockGetCurrentUser.mockResolvedValue(user("org-1"));
    const res = await GET();
    const data = await res.json();
    expect(data.seats).toBeNull();
    expect(data.memberCount).toBe(1);
  });

  it("canCreateOrg is always true", async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    const res = await GET();
    const data = await res.json();
    expect(data.canCreateOrg).toBe(true);
  });
});

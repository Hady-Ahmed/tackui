import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockOrg } = vi.hoisted(() => {
  const mockOrg = {
    listMembers: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
    listInvitations: vi.fn(),
    cancelInvitation: vi.fn(),
  };
  return { mockOrg };
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { organization: mockOrg },
}));

import {
  listMembers,
  removeMember,
  updateMemberRole,
  listInvitations,
  cancelInvitation,
} from "@/lib/org-members";

beforeEach(() => {
  for (const k of Object.keys(mockOrg) as (keyof typeof mockOrg)[]) {
    mockOrg[k].mockReset();
  }
});

describe("listMembers", () => {
  it("returns a typed roster on success", async () => {
    mockOrg.listMembers.mockResolvedValue({
      data: {
        members: [
          {
            id: "m1",
            userId: "u1",
            role: "owner",
            user: { email: "a@e.com", name: "Alice" },
            createdAt: "2024-01-01",
          },
          {
            id: "m2",
            userId: "u2",
            role: "member",
            user: { email: "b@e.com", name: "Bob" },
          },
        ],
        total: 2,
      },
      error: null,
    });
    const res = await listMembers();
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2);
    expect(res.data![0]).toMatchObject({
      id: "m1",
      userId: "u1",
      role: "owner",
      email: "a@e.com",
      name: "Alice",
      createdAt: "2024-01-01",
    });
    expect(res.data![1].email).toBe("b@e.com");
  });

  it("surfaces the error on failure", async () => {
    mockOrg.listMembers.mockResolvedValue({
      data: null,
      error: { code: "NO_ACTIVE_ORGANIZATION", message: "no active org" },
    });
    const res = await listMembers();
    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({
      code: "NO_ACTIVE_ORGANIZATION",
      message: "no active org",
    });
  });

  it("returns an empty list when data is null", async () => {
    mockOrg.listMembers.mockResolvedValue({ data: null, error: null });
    const res = await listMembers();
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  it("returns an empty list when members is absent", async () => {
    mockOrg.listMembers.mockResolvedValue({
      data: { total: 0 },
      error: null,
    });
    const res = await listMembers();
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });
});

describe("removeMember", () => {
  it("calls the client with the id and returns the member id", async () => {
    mockOrg.removeMember.mockResolvedValue({
      data: { member: { id: "m2" } },
      error: null,
    });
    const res = await removeMember("m2");
    expect(mockOrg.removeMember).toHaveBeenCalledWith({
      memberIdOrEmail: "m2",
    });
    expect(res.data).toEqual({ memberId: "m2" });
    expect(res.error).toBeNull();
  });

  it("routes emails through the same entry point", async () => {
    mockOrg.removeMember.mockResolvedValue({
      data: { member: { id: "m3" } },
      error: null,
    });
    await removeMember("bob@e.com");
    expect(mockOrg.removeMember).toHaveBeenCalledWith({
      memberIdOrEmail: "bob@e.com",
    });
  });

  it("propagates the only-owner error code", async () => {
    mockOrg.removeMember.mockResolvedValue({
      data: null,
      error: {
        code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
        message: "cannot leave",
      },
    });
    const res = await removeMember("m1");
    expect(res.data).toBeNull();
    expect(res.error?.code).toBe(
      "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
    );
  });

  it("propagates the not-allowed error code for non-admin callers", async () => {
    mockOrg.removeMember.mockResolvedValue({
      data: null,
      error: {
        code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER",
        message: "not allowed",
      },
    });
    const res = await removeMember("m2");
    expect(res.error?.code).toBe("YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER");
  });
});

describe("updateMemberRole", () => {
  it("calls the client with memberId + role and returns the member id", async () => {
    mockOrg.updateMemberRole.mockResolvedValue({
      data: { id: "m2", userId: "u2", role: "admin" },
      error: null,
    });
    const res = await updateMemberRole("m2", "admin");
    expect(mockOrg.updateMemberRole).toHaveBeenCalledWith({
      memberId: "m2",
      role: "admin",
    });
    expect(res.data).toEqual({ memberId: "m2" });
    expect(res.error).toBeNull();
  });

  it("accepts 'owner' as a role (ownership transfer)", async () => {
    mockOrg.updateMemberRole.mockResolvedValue({
      data: { id: "m2", userId: "u2", role: "owner" },
      error: null,
    });
    const res = await updateMemberRole("m2", "owner");
    expect(mockOrg.updateMemberRole).toHaveBeenCalledWith({
      memberId: "m2",
      role: "owner",
    });
    expect(res.data).toEqual({ memberId: "m2" });
  });

  it("surfaces errors", async () => {
    mockOrg.updateMemberRole.mockResolvedValue({
      data: null,
      error: { code: "UNAUTHORIZED", message: "nope" },
    });
    const res = await updateMemberRole("m2", "member");
    expect(res.error?.code).toBe("UNAUTHORIZED");
  });
});

describe("listInvitations", () => {
  it("returns typed sent invitations on success", async () => {
    mockOrg.listInvitations.mockResolvedValue({
      data: [
        {
          id: "inv1",
          email: "c@e.com",
          role: "member",
          status: "pending",
          organizationId: "org-1",
          createdAt: "2024-02-01",
        },
      ],
      error: null,
    });
    const res = await listInvitations();
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(res.data![0]).toMatchObject({
      id: "inv1",
      email: "c@e.com",
      role: "member",
      status: "pending",
    });
  });

  it("surfaces errors", async () => {
    mockOrg.listInvitations.mockResolvedValue({
      data: null,
      error: { code: "FAILED", message: "oops" },
    });
    const res = await listInvitations();
    expect(res.error?.code).toBe("FAILED");
  });

  it("filters out accepted, rejected, and cancelled invitations", async () => {
    mockOrg.listInvitations.mockResolvedValue({
      data: [
        { id: "inv1", email: "a@e.com", role: "member", status: "pending" },
        { id: "inv2", email: "b@e.com", role: "member", status: "accepted" },
        { id: "inv3", email: "c@e.com", role: "admin", status: "canceled" },
        { id: "inv4", email: "d@e.com", role: "member", status: "rejected" },
      ],
      error: null,
    });
    const res = await listInvitations();
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(res.data![0].id).toBe("inv1");
  });
});

describe("cancelInvitation", () => {
  it("calls the client with the invitation id and returns it", async () => {
    mockOrg.cancelInvitation.mockResolvedValue({
      data: { id: "inv1", status: "cancelled" },
      error: null,
    });
    const res = await cancelInvitation("inv1");
    expect(mockOrg.cancelInvitation).toHaveBeenCalledWith({
      invitationId: "inv1",
    });
    expect(res.data).toEqual({ invitationId: "inv1" });
  });

  it("surfaces errors", async () => {
    mockOrg.cancelInvitation.mockResolvedValue({
      data: null,
      error: { code: "NOT_FOUND", message: "gone" },
    });
    const res = await cancelInvitation("inv1");
    expect(res.error?.code).toBe("NOT_FOUND");
  });
});

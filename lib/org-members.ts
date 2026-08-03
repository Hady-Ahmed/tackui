import { authClient } from "@/lib/auth/auth-client";

/**
 * Typed wrappers around better-auth's organization client methods for
 * workspace member management. These are pure API-mapping helpers —
 * they call the better-auth client and return a structured `{ data,
 * error }` result. UI side-effects (cache refresh, toast messages) live
 * in the page that calls these.
 *
 * The better-auth organization plugin enforces permissions server-side:
 * only owners/admins can remove members or change roles; the sole owner
 * can't leave (`YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER`);
 * non-admins get `YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER`. No new
 * API routes are needed — these call `/api/auth/organization/*`
 * directly via the mounted better-auth handler.
 *
 * Removing a member needs no plan-enforcement check — it only ever
 * increases seatsRemaining; better-auth's `membershipLimit` (wired in
 * lib/auth/auth.ts) is the live invite gate and decrements automatically
 * on removal.
 */

export interface OrgMember {
  id: string;
  userId: string;
  role: string;
  email: string;
  name: string;
  createdAt?: string;
}

export interface SentInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId?: string;
  createdAt?: string;
}

export interface OrgMemberError {
  code: string;
  message: string;
}

export interface OrgMemberResult<T> {
  data: T | null;
  error: OrgMemberError | null;
}

function toError(err: unknown): OrgMemberError {
  if (err && typeof err === "object") {
    const e = err as { code?: string; message?: string; status?: number };
    return {
      code: e.code ?? "UNKNOWN",
      message: e.message ?? "Request failed",
    };
  }
  return { code: "UNKNOWN", message: "Request failed" };
}

/** List members of the active org. */
export async function listMembers(): Promise<OrgMemberResult<OrgMember[]>> {
  const { data, error } = await authClient.organization.listMembers({});
  if (error) return { data: null, error: toError(error) };
  // better-auth returns { members: [...], total } (see crud-members.mjs),
  // not a bare array.
  const raw = (data as { members?: unknown[] } | null)?.members ?? [];
  const members = (raw as Array<Record<string, unknown>>).map((m) => ({
    id: String(m.id ?? ""),
    userId: String(m.userId ?? ""),
    role: String(m.role ?? "member"),
    email: String(
      (m.user as { email?: string } | undefined)?.email ??
        (m as { email?: string }).email ??
        "",
    ),
    name: String(
      (m.user as { name?: string } | undefined)?.name ??
        (m as { name?: string }).name ??
        "",
    ),
    createdAt: m.createdAt ? String(m.createdAt) : undefined,
  }));
  return { data: members, error: null };
}

/**
 * Remove a member by id or email. The underlying handler branches on the
 * `@` character: emails resolve via `findMemberByEmail`, ids via
 * `findMemberById`. Self-removal is permitted (leaving the workspace)
 * unless the caller is the only owner.
 */
export async function removeMember(
  memberIdOrEmail: string,
): Promise<OrgMemberResult<{ memberId: string }>> {
  const { data, error } = await authClient.organization.removeMember({
    memberIdOrEmail,
  });
  if (error) return { data: null, error: toError(error) };
  const memberId = String(
    (data as { member?: { id?: string } } | null)?.member?.id ?? "",
  );
  return { data: { memberId }, error: null };
}

/** Change a member's role within the active org (member <-> admin). */
export async function updateMemberRole(
  memberId: string,
  role: "member" | "admin",
): Promise<OrgMemberResult<{ memberId: string }>> {
  const { data, error } = await authClient.organization.updateMemberRole({
    memberId,
    role,
  });
  if (error) return { data: null, error: toError(error) };
  // better-auth returns the updated member object directly (no wrapper).
  const id = String((data as { id?: string } | null)?.id ?? memberId);
  return { data: { memberId: id }, error: null };
}

/**
 * List sent invitations for the active org. Better-auth returns ALL
 * invitations (pending, accepted, rejected, cancelled) without deleting
 * rows — it only flips `status`. This wrapper filters to `pending` only,
 * matching the page's "Pending invitations" section (accepted/rejected/
 * cancelled invites are no longer actionable and shouldn't render).
 */
export async function listInvitations(): Promise<
  OrgMemberResult<SentInvitation[]>
> {
  const { data, error } = await authClient.organization.listInvitations({});
  if (error) return { data: null, error: toError(error) };
  const list = ((data ?? []) as unknown as Array<Record<string, unknown>>)
    .map((inv) => ({
      id: String(inv.id ?? ""),
      email: String(inv.email ?? ""),
      role: String(inv.role ?? "member"),
      status: String(inv.status ?? "pending"),
      organizationId: inv.organizationId
        ? String(inv.organizationId)
        : undefined,
      createdAt: inv.createdAt ? String(inv.createdAt) : undefined,
    }))
    .filter((inv) => inv.status === "pending");
  return { data: list, error: null };
}

/** Cancel a sent invitation before it's accepted. */
export async function cancelInvitation(
  invitationId: string,
): Promise<OrgMemberResult<{ invitationId: string }>> {
  const { data, error } = await authClient.organization.cancelInvitation({
    invitationId,
  });
  if (error) return { data: null, error: toError(error) };
  // better-auth returns the cancelled invitation object directly.
  const id = String((data as { id?: string } | null)?.id ?? invitationId);
  return { data: { invitationId: id }, error: null };
}

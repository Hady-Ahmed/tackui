import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkCanCreateOrg } from "@/lib/plans/enforcement";
import { getMembershipLimit } from "@/lib/billing/subscription-store";
import { query } from "@/lib/db/pg";

/**
 * GET /api/org — the current user's orgs + active org + seat info.
 *
 * Read-only aggregate used by the org switcher + invite dialog to render
 * seat availability and the "create workspace" affordance. Creation +
 * invites themselves go through the better-auth client
 * (authClient.organization.create / inviteMember) — the plan gates
 * (allowUserToCreateOrganization, membershipLimit) are enforced
 * server-side in lib/auth/auth.ts, so direct API calls can't bypass them.
 *
 * Returns the user's memberships across all orgs with their role, the
 * active org id, whether org creation is allowed (plan), the active org's
 * seat cap, and its current member count.
 */

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  role: string;
}

async function countMembers(orgId: string): Promise<number> {
  const r = await query<{ count: number }>(
    `SELECT count(*)::int as count FROM member WHERE "organizationId" = $1`,
    [orgId],
  );
  return r.rows[0]?.count ?? 0;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await query<OrgRow>(
    `SELECT o.id, o.name, o.slug, m.role
     FROM member m
     JOIN organization o ON o.id = m."organizationId"
     WHERE m."userId" = $1
     ORDER BY o."createdAt" ASC`,
    [user.id],
  );

  // null = unlimited (self-host). A finite number = seat cap.
  const limit = await getMembershipLimit(user.orgId);
  const seats = Number.isFinite(limit) ? limit : null;
  const memberCount = await countMembers(user.orgId);
  const canCreateOrg = (await checkCanCreateOrg(user.orgId)) === null;

  return NextResponse.json({
    orgs: result.rows,
    activeOrgId: user.orgId,
    canCreateOrg,
    seats,
    memberCount,
  });
}

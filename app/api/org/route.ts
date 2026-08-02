import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/context";
import { checkCanCreateOrg } from "@/lib/plans/enforcement";
import { query } from "@/lib/db/pg";

/**
 * GET /api/org — the current user's orgs + active org + per-org plan info.
 *
 * Read-only aggregate used by the org switcher + invite dialog to render
 * plan badges, seat counts, and the "create workspace" affordance. Creation
 * + invites themselves go through the better-auth client
 * (authClient.organization.create / inviteMember) — the plan gates
 * (membershipLimit) are enforced server-side in lib/auth/auth.ts, so
 * direct API calls can't bypass them.
 *
 * Returns the user's memberships across all orgs with their role + each
 * org's plan (free/pro/team) + seat cap + current member count, the active
 * org id, and whether org creation is allowed (always true — Free
 * workspaces are harmless).
 */

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  role: string;
  plan: string;
  seats: number | null;
}

interface MemberCountRow {
  organizationId: string;
  count: number;
}

async function countMembersByOrg(orgIds: string[]): Promise<Map<string, number>> {
  if (orgIds.length === 0) return new Map();
  const r = await query<MemberCountRow>(
    `SELECT "organizationId", count(*)::int as count
     FROM member
     WHERE "organizationId" = ANY($1::text[])
     GROUP BY "organizationId"`,
    [orgIds],
  );
  return new Map(r.rows.map((row) => [row.organizationId, row.count]));
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Join member → organization → subscriptions (LEFT JOIN so Free orgs
  // with no subscription row still appear with plan='free').
  const result = await query<OrgRow>(
    `SELECT o.id, o.name, o.slug, m.role,
            COALESCE(s.plan, 'free') AS plan,
            s.seats
     FROM member m
     JOIN organization o ON o.id = m."organizationId"
     LEFT JOIN subscriptions s ON s.org_id = o.id
     WHERE m."userId" = $1
     ORDER BY o."createdAt" ASC`,
    [user.id],
  );

  const orgIds = result.rows.map((r) => r.id);
  const memberCounts = await countMembersByOrg(orgIds);

  const orgs = result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    role: r.role,
    plan: r.plan,
    seats: r.seats,
    memberCount: memberCounts.get(r.id) ?? 0,
  }));

  // canCreateOrg is always true — workspace creation is free and
  // unrestricted (Free workspaces: 3 agents, 1 member, no invites).
  const canCreateOrg = (await checkCanCreateOrg(user.orgId)) === null;

  // Top-level seats/memberCount for the active org (the invite dialog +
  // switcher header read these without scanning the orgs array).
  const activeOrgInfo = orgs.find((o) => o.id === user.orgId);

  return NextResponse.json({
    orgs,
    activeOrgId: user.orgId,
    canCreateOrg,
    seats: activeOrgInfo?.seats ?? null,
    memberCount: activeOrgInfo?.memberCount ?? 0,
  });
}

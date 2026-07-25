import { headers } from "next/headers";
import { auth, isAuthDisabled } from "./auth";
import { ensureAuthTables } from "./migrate";
import {
  runWithUserAsync,
  type RequestUser,
} from "./request-context";
import { getSoloOrgId } from "./solo-org";
import { query } from "@/lib/db/pg";

const SYNTHETIC_ID = "local";
const SYNTHETIC_NAME = "Local user";

/**
 * Resolve the synthetic admin user for solo mode (AUTH_DISABLED=true).
 * The orgId is resolved lazily from the solo org row created on boot
 * (see lib/auth/solo-org.ts). This is async because the org id may
 * need a DB query on first call.
 */
export async function getSyntheticAdmin(): Promise<RequestUser> {
  const orgId = await getSoloOrgId();
  return {
    id: SYNTHETIC_ID,
    role: "admin",
    name: SYNTHETIC_NAME,
    email: null,
    orgId,
  };
}

function sessionToUser(session: {
  user: { id: string; name: string; email?: string | null; role?: string };
  session: Record<string, unknown>;
}): RequestUser {
  return {
    id: session.user.id,
    role: session.user.role ?? "user",
    name: session.user.name,
    email: session.user.email ?? null,
    orgId: (session.session.activeOrganizationId as string | null | undefined) ?? "",
  };
}

export async function getRequestUser(
  request: Request,
): Promise<RequestUser | null> {
  if (isAuthDisabled()) return getSyntheticAdmin();
  await ensureAuthTables();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  return sessionToUser(session);
}

export async function getCurrentUser(): Promise<RequestUser | null> {
  if (isAuthDisabled()) return getSyntheticAdmin();
  await ensureAuthTables();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) return null;
  return sessionToUser(session);
}

export async function wrapHandlerWithUser<T>(
  request: Request,
  handler: () => Promise<T>,
): Promise<{ user: RequestUser | null; result: T } | { user: null; result: null }> {
  const user = await getRequestUser(request);
  if (!user) return { user: null, result: null };
  const result = await runWithUserAsync(user, handler);
  return { user, result };
}

export { SYNTHETIC_ID };
export type { RequestUser };

/**
 * Check whether a user can manage agents (create/edit/delete) in their
 * active org. Platform admins (role === "admin") can manage agents in
 * any org they're switched to. Org owners/admins (from the organization
 * plugin's member table) can manage agents in their own org. Org members
 * and non-members cannot.
 */
export async function canManageAgents(user: RequestUser): Promise<boolean> {
  if (user.role === "admin") return true;
  const member = await query<{ role: string }>(
    `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2`,
    [user.id, user.orgId],
  );
  const orgRole = member.rows[0]?.role;
  return orgRole === "owner" || orgRole === "admin";
}

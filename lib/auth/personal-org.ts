import {
  getCurrentAdapter,
  type BetterAuthOptions,
  type DBAdapter,
  type DBTransactionAdapter,
} from "better-auth";

type SessionHookFn = NonNullable<
  NonNullable<
    NonNullable<BetterAuthOptions["databaseHooks"]>["session"]
  >["create"]
>["before"];

export type SessionHookSession = Parameters<NonNullable<SessionHookFn>>[0];

/**
 * Creates the personal org + owner membership for a user that has none,
 * and returns the `activeOrganizationId` the session row should carry.
 * Returns the existing org untouched when the user already owns one
 * (every login after signup lands here).
 *
 * The adapter MUST be the one Better Auth is currently executing on —
 * `getCurrentAdapter(ctx.context.adapter)` — not the app pool. During
 * email sign-up Better Auth wraps user + account + session in ONE
 * transaction on a dedicated connection; this hook runs inside it, so a
 * `member.userId` FK insert has to see the still-uncommitted user row.
 * Only a write on the transaction's own connection does.
 */
export async function ensurePersonalOrg<Options extends BetterAuthOptions>(
  adapter: DBTransactionAdapter<Options>,
  session: SessionHookSession,
): Promise<{
  data: SessionHookSession & { activeOrganizationId: string };
}> {
  const owned = await adapter.findMany<{ organizationId: string }>({
    model: "member",
    where: [
      { field: "userId", value: session.userId },
      { field: "role", value: "owner" },
    ],
    sortBy: { field: "createdAt", direction: "asc" },
    limit: 1,
  });
  const existingOrgId = owned[0]?.organizationId;
  if (existingOrgId) {
    return { data: { ...session, activeOrganizationId: existingOrgId } };
  }

  const user = await adapter.findOne<{ name: string | null; email: string | null }>({
    model: "user",
    where: [{ field: "id", value: session.userId }],
  });
  const userName = user?.name ?? user?.email ?? "My";
  const org = await adapter.create<{ id: string }>({
    model: "organization",
    data: {
      name: `${userName}'s workspace`,
      slug: `personal-${session.userId.slice(0, 8)}`,
      createdAt: new Date(),
    },
  });
  await adapter.create({
    model: "member",
    data: {
      organizationId: org.id,
      userId: session.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });

  return { data: { ...session, activeOrganizationId: org.id } };
}

/**
 * The `session.create.before` hook: resolves the adapter Better Auth is
 * executing on (the transaction-scoped one inside the sign-up
 * transaction) and delegates to ensurePersonalOrg.
 *
 * The ctx parameter is a structural subset of better-auth's
 * GenericEndpointContext — the hook reads nothing but `context.adapter`
 * (the base adapter whose transaction it must join).
 *
 * Fails closed when the endpoint context is missing: without it the
 * transaction-scoped adapter cannot be resolved, and guessing a
 * connection is what made first signups FK-fail and roll back
 * (#208). Every session-creation path goes through a dispatched
 * endpoint, so the context is always present in practice.
 */
export async function sessionCreateBeforeHook<
  Options extends BetterAuthOptions,
>(
  session: SessionHookSession,
  ctx: { context: { adapter: DBAdapter<Options> } } | null,
): Promise<{ data: SessionHookSession & { activeOrganizationId: string } }> {
  if (!ctx) {
    throw new Error(
      "sessionCreateBeforeHook requires the Better Auth endpoint context " +
        "to resolve the transaction-scoped adapter",
    );
  }
  const adapter = await getCurrentAdapter(ctx.context.adapter);
  return ensurePersonalOrg(adapter, session);
}

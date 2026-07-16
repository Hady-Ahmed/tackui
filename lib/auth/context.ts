import { headers } from "next/headers";
import { auth, isAuthDisabled } from "./auth";
import { ensureAuthTables } from "./migrate";
import {
  runWithUserAsync,
  type RequestUser,
} from "./request-context";

const SYNTHETIC_ADMIN: RequestUser = {
  id: "local",
  role: "admin",
  name: "Local user",
  email: null,
};

function sessionToUser(session: {
  user: { id: string; name: string; email?: string | null; role?: string };
}): RequestUser {
  return {
    id: session.user.id,
    role: session.user.role ?? "user",
    name: session.user.name,
    email: session.user.email ?? null,
  };
}

export async function getRequestUser(
  request: Request,
): Promise<RequestUser | null> {
  if (isAuthDisabled()) return SYNTHETIC_ADMIN;
  await ensureAuthTables();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  return sessionToUser(session);
}

export async function getCurrentUser(): Promise<RequestUser | null> {
  if (isAuthDisabled()) return SYNTHETIC_ADMIN;
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

export { SYNTHETIC_ADMIN };
export type { RequestUser };

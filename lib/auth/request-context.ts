import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestUser {
  id: string;
  role: string;
  name: string;
  email: string | null;
}

const requestUserStorage = new AsyncLocalStorage<RequestUser>();

export function runWithUser<T>(user: RequestUser, fn: () => T): T {
  return requestUserStorage.run(user, fn);
}

export async function runWithUserAsync<T>(
  user: RequestUser,
  fn: () => Promise<T>,
): Promise<T> {
  return requestUserStorage.run(user, fn);
}

export function getRunnerUser(): RequestUser | null {
  return requestUserStorage.getStore() ?? null;
}

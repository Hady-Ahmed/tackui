import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestUser {
  id: string;
  role: string;
  name: string;
  email: string | null;
  orgId: string;
}

/**
 * One AG-UI context item the run route resolved for this run — the
 * per-run dependencies a builder agent needs (runner BYOK keys, org MCP
 * connectors). Shape matches the AG-UI `Context` wire type:
 * `description` is the dependency key (e.g. "tavily_api_key") the AgentOS
 * dispatcher reads; `value` is the secret or JSON payload. Both strings.
 */
export interface RunContextItem {
  description: string;
  value: string;
}

const requestUserStorage = new AsyncLocalStorage<RequestUser>();

/**
 * Separate ALS for run dependencies — kept apart from the user storage so
 * `getRunnerUser()` callers never see a different store shape and the two
 * concerns (who is running vs. what to inject) stay orthogonal.
 */
const runContextStorage = new AsyncLocalStorage<RunContextItem[]>();

export function runWithUser<T>(user: RequestUser, fn: () => T): T {
  return requestUserStorage.run(user, fn);
}

export async function runWithUserAsync<T>(
  user: RequestUser,
  fn: () => Promise<T>,
): Promise<T> {
  return requestUserStorage.run(user, fn);
}

/**
 * Run `fn` inside a scope carrying BOTH the runner identity and the
 * resolved run dependencies. Used by the copilotkit route for builder
 * runs: the route resolves credentials/connectors up front (it must —
 * they gate the run), stashes them here, and the registry middleware
 * reads them back synchronously at run time to inject into
 * `RunAgentInput.context`. Registry middleware is synchronous, so the
 * resolution cannot happen inside it — hence this pre-resolved stash.
 */
export async function runWithRunnerContext<T>(
  user: RequestUser,
  contextItems: RunContextItem[],
  fn: () => Promise<T>,
): Promise<T> {
  return runContextStorage.run(contextItems, () =>
    runWithUserAsync(user, fn),
  );
}

/**
 * The run dependencies stashed for the current ALS scope. Returns an
 * empty array outside a run scope — callers treat that as "nothing to
 * inject" (every run that matters goes through `runWithRunnerContext`).
 */
export function getRunContextItems(): RunContextItem[] {
  return runContextStorage.getStore() ?? [];
}

export function getRunnerUser(): RequestUser | null {
  return requestUserStorage.getStore() ?? null;
}

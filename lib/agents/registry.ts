import { HttpAgent } from "@ag-ui/client";
import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import jwt from "jsonwebtoken";
import type { AgentEntry } from "./agents.config";
import { listAgents } from "./agent-store";
import { getTemplatesByIds } from "@/lib/catalog/template-store";
import { getRequestUser } from "@/lib/auth/context";
import type { RequestUser } from "@/lib/auth/request-context";

export type AgentsMap = Record<string, AbstractAgent>;

export async function getAgents(request?: Request): Promise<AgentsMap> {
  const user = await getRequestUser(request ?? new Request("http://localhost"));
  if (!user) throw new Error("No agents available — not authenticated.");
  const entries = await listAgents(user.orgId);
  if (entries.length === 0) {
    throw new Error(
      "No agents configured. Add agents via the /agents admin page.",
    );
  }

  // Live-resolve catalog agents (managed-plugin model): the template is
  // the source of truth for endpoint/auth — a template edit propagates
  // to every installed org on the next request, with no user action.
  // Tombstones (template deleted) and inactive templates still resolve
  // (tombstones fall back to the row's last-synced config) so history
  // replay keeps working — new RUNS on them are 410'd/402'd at the
  // route (checkCatalogRunGates), before anything reaches a backend.
  const templateIds = [
    ...new Set(
      entries
        .map((e) => e.sourceTemplateId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const templates = await getTemplatesByIds(templateIds);
  const templateById = new Map(templates.map((t) => [t.id, t]));

  const map: AgentsMap = {};
  for (const entry of entries) {
    const template = entry.sourceTemplateId
      ? templateById.get(entry.sourceTemplateId)
      : undefined;
    const resolved: AgentEntry = template
      ? {
          ...entry,
          endpoint: template.endpoint,
          authMode: template.authMode,
          jwtSecret: template.jwtSecret,
          jwtScopes: template.jwtScopes,
        }
      : entry;
    map[entry.id] = createAgent(resolved, user);
  }
  return map;
}

function createAgent(entry: AgentEntry, user: RequestUser): AbstractAgent {
  const headers: Record<string, string> = {};

  // Per-agent JWT auth (HS256). When enabled, mint a short-lived
  // token per run with `sub` = the authenticated user's id, signed
  // with the agent's shared secret. The backend verifies the
  // signature (proving tackui minted it) and uses `sub` to identify
  // the caller. Authorization (what the user can do) stays the
  // backend's job — tackui only vouches for *who* the user is.
  // When `jwtScopes` is configured, the `scopes` claim is included
  // so backends with `authorization=True` (e.g. Agno's AuthMiddleware)
  // can check RBAC permissions. Omitted entirely when no scopes are
  // set (works fine when the backend's authorization is off).
  if (entry.authMode === "jwt" && entry.jwtSecret) {
    const now = Math.floor(Date.now() / 1000);
    const payload: {
      sub: string;
      iat: number;
      exp: number;
      scopes?: string[];
    } = { sub: user.id, iat: now, exp: now + 3600 };
    if (entry.jwtScopes?.length) payload.scopes = entry.jwtScopes;
    const token = jwt.sign(payload, entry.jwtSecret, {
      algorithm: "HS256",
    });
    headers.Authorization = `Bearer ${token}`;
  }

  const agent = new HttpAgent({ url: entry.endpoint, headers });

  // Forward the authenticated user's id via `forwardedProps.user_id`
  // (Agno's documented convention for anonymous-caller attribution).
  // Sent in BOTH auth modes — additive, not either/or. When a valid
  // JWT is present, Agno pins to `sub` and ignores this; when no JWT
  // (authMode "none"), Agno uses it. Other AG-UI backends pick
  // whichever they prefer. The value is the server-resolved auth
  // principal (Better Auth user UUID, or "local" in solo mode),
  // never trusting client-supplied identity.
  agent.use((input: RunAgentInput, next) =>
    next.run({
      ...input,
      forwardedProps: {
        ...input.forwardedProps,
        user_id: user.id,
      },
    }),
  );
  return agent;
}

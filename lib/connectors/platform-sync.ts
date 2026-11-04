/**
 * Push-first sync of the org's MCP connectors into the platform's connector
 * registry.
 *
 * WHY A REGISTRY: the platform resolves MCP attach URLs from its own
 * registry (keyed by connector id, written only by this server) — never
 * from the run wire. A wire-supplied URL would be an SSRF primitive: the
 * platform connects to attacker-chosen addresses from inside the
 * deployment, with org tokens attached. Tokens are NEVER registered —
 * they stay per-run deliveries from this server.
 *
 * WHY IDS: connector names are org-scoped (two orgs can both have
 * "github" pointing at different servers) and the platform has no org
 * concept; the connector row's server-generated id is globally unique.
 *
 * ORDERING (push-first-then-commit): connector create/edit pushes to the
 * registry BEFORE the local row is written, and deletes the registry
 * entry BEFORE the local delete. So the two stores can only ever disagree
 * in the harmless direction — platform momentarily ahead — and a failed
 * push means NOTHING changed locally: the admin sees the error and
 * retries, never a half-updated connector.
 */
import { AgentosError, agentosRequest } from "@/lib/agents/builder";

/** Register/refresh one connector endpoint on the platform. Idempotent. */
export async function upsertPlatformConnector(connector: {
  id: string;
  url: string;
  /** Org-facing name — cosmetic only (admin/debug surfaces). */
  name: string;
}): Promise<void> {
  await agentosRequest(
    "PUT",
    `/platform/connectors/${encodeURIComponent(connector.id)}`,
    { url: connector.url, label: connector.name },
  );
}

/**
 * Remove one connector endpoint from the platform registry. A 404 is
 * success (the delete IS the state — e.g. the entry never synced or was
 * already removed).
 */
export async function deletePlatformConnector(connectorId: string): Promise<void> {
  try {
    await agentosRequest(
      "DELETE",
      `/platform/connectors/${encodeURIComponent(connectorId)}`,
    );
  } catch (err) {
    if (err instanceof AgentosError && err.status === 404) return;
    throw err;
  }
}

/**
 * Belt-and-braces registration for agent saves: connector edits already
 * push-first, so the registry normally holds every referenced connector —
 * re-upserting at agent save additionally covers a restored/wiped platform
 * database (the agent's saved config would otherwise reference ids the
 * registry lost, and runs would silently skip those connectors).
 * Idempotent and cheap (connectors per agent are capped at 10).
 */
export async function ensurePlatformConnectors(
  connectors: Array<{ id: string; url: string; name: string }>,
): Promise<void> {
  for (const connector of connectors) {
    await upsertPlatformConnector(connector);
  }
}

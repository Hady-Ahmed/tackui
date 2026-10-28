/**
 * REST routes for the org's MCP connectors (lib/connectors store).
 *
 * GET  /api/connectors         — list (org-scoped; tokens never returned)
 * PUT  /api/connectors         — upsert one {name, url, token?}
 * DELETE /api/connectors/:name — remove one
 *
 * Writes are org-admin-gated (canManageAgents — owners/admins/platform
 * admins); reads are member-accessible so the builder's connector palette
 * can render. Tokens are write-only: GET responses carry `hasToken`
 * booleans, never plaintext. `token` semantics on PUT: omitted → preserve
 * the stored token, "" → clear it, string → encrypt + store.
 *
 * The connector URL is a user-supplied endpoint the AgentOS fetches at run
 * time with the org's token attached — the SSRF guard applies (docs/security.md):
 * private/internal addresses are refused unless ALLOW_PRIVATE_ENDPOINTS=true
 * (hard-locked off in SaaS mode).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, canManageAgents } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import {
  listConnectors,
  upsertConnector,
  toPublicConnector,
} from "@/lib/connectors/connector-store";

const upsertConnectorBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().url(),
  /** Omitted → preserve stored token; "" → clear; string → encrypt+store. */
  token: z.string().max(2000).optional(),
});

/** GET /api/connectors — the org's connectors (secrets never returned). */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;
  const connectors = await listConnectors(user.orgId);
  return NextResponse.json({
    connectors: connectors.map(toPublicConnector),
  });
}

/** PUT /api/connectors — upsert one connector (org-admin only). */
export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await canManageAgents(user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = checkUserLimit(user.id, "connectorMutate");
  if (limited) return limited;

  const body = await request.json().catch(() => null);
  const parsed = upsertConnectorBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // The URL is user-supplied and the AgentOS fetches it at run time with the
  // org's token attached — the SSRF guard applies (same as agent endpoints).
  // Zod's http(s)-only check governs the scheme; this governs the address.
  try {
    await assertSafeUrl(parsed.data.url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json(
        { error: "Connector URLs must not point to a private or internal address." },
        { status: 400 },
      );
    }
    throw err;
  }

  try {
    const stored = await upsertConnector({
      orgId: user.orgId,
      name: parsed.data.name,
      url: parsed.data.url,
      token: parsed.data.token,
    });
    return NextResponse.json(toPublicConnector(stored));
  } catch (err) {
    // The store's zod schemas (name pattern, http(s)-only url) reject
    // invalid input — surface those as 400s, anything else as a 500.
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: err.flatten() },
        { status: 400 },
      );
    }
    console.error("[connectors] failed to store connector", {
      orgId: user.orgId,
      name: parsed.data.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to store connector. Check server logs." },
      { status: 500 },
    );
  }
}

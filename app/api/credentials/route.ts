/**
 * REST routes for the runner's BYOK credentials.
 *
 * GET    /api/credentials            — saved rows + the live catalog
 * PUT    /api/credentials            — upsert one key {provider, secret}
 * DELETE /api/credentials/:provider  — remove one key
 *
 * Keys are write-only: GET responses carry booleans, never plaintext.
 *
 * The catalog is DERIVED from the AgentOS platform (lib/credentials/
 * catalog.ts) — never hardcoded. GET degrades gracefully: saved rows always
 * render from the local DB; when the platform is unreachable the catalog
 * comes back null with `catalogError`, and new keys can't be added (PUT is
 * fail-closed — it validates against the live catalog) until it's back.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/context";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import {
  fetchCredentialsCatalog,
  type CredentialCatalogEntry,
} from "@/lib/credentials/catalog";
import { listCredentials, setCredential } from "@/lib/credentials/credential-store";

const setCredentialBodySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  secret: z.string().trim().min(1, "Key must not be empty").max(500),
});

/** The catalog wire shape: provider → metadata (Record keeps UI lookups O(1)). */
function catalogToWire(catalog: Record<string, CredentialCatalogEntry>) {
  return Object.fromEntries(
    Object.entries(catalog).map(([provider, entry]) => [
      provider,
      { kind: entry.kind, keyName: entry.keyName, label: entry.label },
    ]),
  );
}

/** GET /api/credentials — saved keys (existence only) + the live catalog. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Saved rows and the catalog are independent: a catalog failure must not
  // blank the saved list (the store is local DB — always available).
  const [creds, catalogResult] = await Promise.all([
    listCredentials(user.id),
    fetchCredentialsCatalog(),
  ]);
  return NextResponse.json({
    credentials: creds.map((c) => ({
      provider: c.provider,
      kind: c.kind,
      hasKey: true,
      updatedAt: c.updatedAt,
    })),
    catalog: catalogResult.catalog ? catalogToWire(catalogResult.catalog) : null,
    ...(catalogResult.catalogError ? { catalogError: catalogResult.catalogError } : {}),
  });
}

/** PUT /api/credentials — fail-closed against the LIVE catalog. */
export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = checkUserLimit(user.id, "credentialMutate");
  if (limited) return limited;

  const body = await request.json().catch(() => null);
  const parsed = setCredentialBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // The platform is the single source of truth: a provider it doesn't know
  // (or can't be asked about right now) gets no key saved.
  const { catalog, catalogError } = await fetchCredentialsCatalog();
  if (!catalog) {
    return NextResponse.json(
      { error: catalogError ?? "Can't reach the platform — try again shortly." },
      { status: 503 },
    );
  }
  const entry = catalog[parsed.data.provider];
  if (!entry) {
    return NextResponse.json(
      { error: `Unknown provider "${parsed.data.provider}"` },
      { status: 400 },
    );
  }

  try {
    const stored = await setCredential({
      userId: user.id,
      provider: parsed.data.provider,
      kind: entry.kind,
      secret: parsed.data.secret,
    });
    return NextResponse.json({
      provider: stored.provider,
      kind: stored.kind,
      hasKey: true,
      updatedAt: stored.updatedAt,
    });
  } catch (err) {
    console.error("[credentials] failed to store credential", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to store credential. Check server logs." },
      { status: 500 },
    );
  }
}

/**
 * REST routes for the runner's BYOK credentials.
 *
 * GET    /api/credentials            — saved rows + the live catalog
 * PUT    /api/credentials            — upsert one provider's fields
 *                                      {provider, fields: {name: value}}
 * DELETE /api/credentials/:provider  — remove one provider's credentials
 *
 * Credentials are write-only: GET responses carry field NAMES, never
 * plaintext values.
 *
 * The catalog is DERIVED from the AgentOS platform (lib/credentials/
 * catalog.ts) — never hardcoded. GET degrades gracefully: saved rows always
 * render from the local DB; when the platform is unreachable the catalog
 * comes back null with `catalogError`, and new keys can't be added (PUT is
 * fail-closed — it validates against the live catalog) until it's back.
 *
 * PUT validates the field set against the provider's derived contract: the
 * exact fields the contract declares, every one non-empty. A partial
 * contract would pass the run gate and fail mid-run, so it can't be saved.
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
  fields: z
    .record(z.string(), z.string().trim().min(1, "Must not be empty").max(500))
    .refine((fields) => Object.keys(fields).length > 0, {
      message: "At least one field is required",
    }),
});

/** The catalog wire shape: provider → metadata (Record keeps UI lookups O(1)). */
function catalogToWire(catalog: Record<string, CredentialCatalogEntry>) {
  return Object.fromEntries(
    Object.entries(catalog).map(([provider, entry]) => [
      provider,
      {
        kind: entry.kind,
        keyName: entry.keyName,
        label: entry.label,
        fields: entry.fields,
      },
    ]),
  );
}

/** GET /api/credentials — saved keys (field names only) + the live catalog. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Same limit as the models/tools reads: the GET also probes the live
  // catalog on the platform side, so it's not a free local-only read.
  const limited = checkUserLimit(user.id, "agentRead");
  if (limited) return limited;

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
      hasKey: c.fields.length > 0,
      fields: c.fields,
      updatedAt: c.updatedAt,
    })),
    catalog: catalogResult.catalog ? catalogToWire(catalogResult.catalog) : null,
    ...(catalogResult.catalogError ? { catalogError: catalogResult.catalogError } : {}),
  });
}

/** PUT /api/credentials — fail-closed against the LIVE catalog + contract. */
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
      { error: catalogError ?? "Can't reach the agent builder — try again shortly." },
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

  // Exact contract match: unknown field names are rejected (a typo would
  // silently never deliver), missing ones too (fail-closed mid-run guard).
  const contractKeys = entry.fields.map((f) => f.key).sort();
  const submittedKeys = Object.keys(parsed.data.fields).sort();
  const unknown = submittedKeys.filter((k) => !contractKeys.includes(k));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown field${unknown.length === 1 ? "" : "s"} for ${entry.label}: ${unknown.join(", ")}` },
      { status: 400 },
    );
  }
  const absent = contractKeys.filter((k) => !submittedKeys.includes(k));
  if (absent.length > 0) {
    const labels = entry.fields
      .filter((f) => absent.includes(f.key))
      .map((f) => f.label)
      .join(", ");
    return NextResponse.json(
      { error: `${entry.label} needs all of its fields: ${labels}` },
      { status: 400 },
    );
  }

  try {
    const stored = await setCredential({
      userId: user.id,
      provider: parsed.data.provider,
      kind: entry.kind,
      fields: parsed.data.fields,
    });
    return NextResponse.json({
      provider: stored.provider,
      kind: stored.kind,
      hasKey: true,
      fields: stored.fields,
      updatedAt: stored.updatedAt,
    });
  } catch (err) {
    console.error("[credentials] failed to store credential", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't save the credential — please try again." },
      { status: 500 },
    );
  }
}

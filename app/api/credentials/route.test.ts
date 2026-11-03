import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the auth context so tests can vary the caller (isolation tests
// need two distinct users; solo-mode defaults would collapse them).
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

// Mock the rate limiter — defaults to "always allow".
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock the catalog fetch — the derived catalog is a live AgentOS call,
// so tests control it explicitly (present / degraded / unreachable)
// instead of depending on the network.
const mockFetchCredentialsCatalog = vi.fn();
vi.mock("@/lib/credentials/catalog", () => ({
  fetchCredentialsCatalog: (...a: unknown[]) => mockFetchCredentialsCatalog(...a),
  CATALOG_UNREACHABLE_MESSAGE:
    "Can't reach the agent builder — your saved keys are unaffected. New keys can't be added until it's back.",
}));

import { GET, PUT } from "./route";
import { DELETE as DELETE_PROVIDER } from "./[provider]/route";
import { runMigrations } from "@/lib/db/migrate";
import { query } from "@/lib/db/pg";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { setCredential, getCredentialSecrets } from "@/lib/credentials/credential-store";
import type { NextRequest } from "next/server";

const USER_ID = "cred-route-user";
const OTHER_USER_ID = "cred-route-other";

const ENCRYPTION_TEST_KEY = "cd".repeat(32);

/** The derived catalog shape the route would see from the live platform. */
const CATALOG = {
  openai: {
    kind: "llm",
    keyName: "openai_api_key",
    label: "Openai",
    fields: [{ key: "api_key", label: "Api key" }],
  },
  openrouter: {
    kind: "llm",
    keyName: "openrouter_api_key",
    label: "Openrouter",
    fields: [{ key: "api_key", label: "Api key" }],
  },
  tavily: {
    kind: "tool",
    keyName: "tavily_api_key",
    label: "Tavily",
    fields: [{ key: "api_key", label: "Tavily api key" }],
  },
  // Multi-credential toolkit — the X toolkit's four-field contract.
  x: {
    kind: "tool",
    keyName: "x_consumer_key",
    label: "X",
    fields: [
      { key: "consumer_key", label: "X consumer key" },
      { key: "consumer_secret", label: "X consumer secret" },
      { key: "access_token", label: "X access token" },
      { key: "access_token_secret", label: "X access token secret" },
    ],
  },
};

function user(id: string) {
  return { id, email: null, name: id, role: "user", orgId: `org-${id}` };
}

function put(body: unknown) {
  return PUT(
    new Request("http://localhost:3000/api/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as NextRequest,
  );
}

async function putAs(caller: string, body: unknown) {
  mockGetCurrentUser.mockImplementation(async () => user(caller));
  return PUT(
    new Request("http://localhost:3000/api/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as NextRequest,
  );
}

/** Read primitive for assertions — the decrypted stored value. */
function storedApiKey(userId: string) {
  return getCredentialSecrets(userId).then((secrets) => secrets.openai?.api_key ?? null);
}

async function del(provider: string, caller?: string) {
  if (caller) mockGetCurrentUser.mockImplementation(async () => user(caller));
  return DELETE_PROVIDER(
    new Request(`http://localhost:3000/api/credentials/${provider}`) as NextRequest,
    { params: Promise.resolve({ provider }) },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("DB_ENCRYPTION_KEY", ENCRYPTION_TEST_KEY);
  await runMigrations();
  await query(`DELETE FROM credentials WHERE user_id = ANY($1)`, [
    [USER_ID, OTHER_USER_ID],
  ]);
  mockGetCurrentUser.mockImplementation(async () => user(USER_ID));
  mockFetchCredentialsCatalog.mockResolvedValue({ catalog: CATALOG });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/credentials", () => {
  it("returns an empty list when nothing is stored", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials).toEqual([]);
    // The catalog drives the "connect a key" UI rows — field lists included.
    expect(body.catalog.openai.kind).toBe("llm");
    expect(body.catalog.tavily.keyName).toBe("tavily_api_key");
    expect(body.catalog.x.fields).toHaveLength(4);
    expect(body.catalogError).toBeUndefined();
  });

  it("lists stored providers with field NAMES only (no values)", async () => {
    await put({
      provider: "x",
      fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at", access_token_secret: "ats" },
    });
    const res = await GET();
    const body = await res.json();
    expect(body.credentials).toEqual([
      expect.objectContaining({
        provider: "x",
        kind: "tool",
        hasKey: true,
        fields: expect.arrayContaining(["consumer_key", "consumer_secret", "access_token", "access_token_secret"]),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("ck");
    expect(JSON.stringify(body)).not.toContain('"at"');
  });

  it("degrades gracefully: saved rows still render when the platform is unreachable (catalog null + catalogError)", async () => {
    await put({ provider: "openai", fields: { api_key: "sk-test-123" } });
    mockFetchCredentialsCatalog.mockResolvedValue({
      catalog: null,
      catalogError:
        "Can't reach the agent builder — your saved keys are unaffected. New keys can't be added until it's back.",
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // The saved rows come from the local DB — a catalog failure must not
    // blank them.
    expect(body.credentials).toEqual([
      expect.objectContaining({ provider: "openai", hasKey: true }),
    ]);
    expect(body.catalog).toBeNull();
    expect(body.catalogError).toMatch(/your saved keys are unaffected/);
  });

  it("returns 401 without a user", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/credentials", () => {
  it("stores a single-field provider and returns the existence record", async () => {
    const res = await put({ provider: "openai", fields: { api_key: "  sk-test-123  " } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      provider: "openai",
      kind: "llm",
      hasKey: true,
      fields: ["api_key"],
    });
    expect(body).not.toHaveProperty("secret");
  });

  it("stores a multi-credential toolkit's full field map", async () => {
    const res = await put({
      provider: "x",
      fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at", access_token_secret: "ats" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fields.sort()).toEqual([
      "access_token",
      "access_token_secret",
      "consumer_key",
      "consumer_secret",
    ]);
    const stored = await query<{ fields: Record<string, string> }>(
      `SELECT fields FROM credentials WHERE user_id = $1 AND provider = 'x'`,
      [USER_ID],
    );
    // Encrypted at rest per field.
    expect(stored.rows[0].fields.consumer_key).toMatch(/^enc:v1:/);
    expect(JSON.stringify(stored.rows[0])).not.toContain("ck");
  });

  it("rejects an unknown field name (a typo would silently never deliver)", async () => {
    const res = await put({ provider: "openai", fields: { api_key: "sk", apy_kye: "x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("apy_kye");
  });

  it("rejects an incomplete contract (a partial map would pass the run gate and fail mid-run)", async () => {
    const res = await put({ provider: "x", fields: { consumer_key: "ck" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("all of its fields");
    const rows = await query(`SELECT provider FROM credentials WHERE user_id = $1`, [USER_ID]);
    expect(rows.rows).toHaveLength(0);
  });

  it("upserts: a second PUT for the same provider replaces the fields", async () => {
    await put({ provider: "openai", fields: { api_key: "sk-first" } });
    await put({ provider: "openai", fields: { api_key: "sk-second" } });
    const res = await GET();
    const body = await res.json();
    expect(body.credentials).toHaveLength(1);
    const stored = await query<{ fields: Record<string, string> }>(
      `SELECT fields FROM credentials WHERE user_id = $1 AND provider = 'openai'`,
      [USER_ID],
    );
    // Encryption at rest + latest value wins.
    expect(stored.rows[0].fields.api_key).toMatch(/^enc:v1:/);
    expect(stored.rows[0].fields.api_key).not.toContain("sk-first");
    expect(stored.rows[0].fields.api_key).not.toContain("sk-second");
  });

  it("update: a blank field keeps the stored value (single-field rotation still needs a value)", async () => {
    await put({ provider: "x", fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at", access_token_secret: "ats" } });
    const res = await put({ provider: "x", fields: { consumer_key: "  ", consumer_secret: "", access_token: "at-new", access_token_secret: "" } });
    expect(res.status).toBe(200);
    expect((await getCredentialSecrets(USER_ID)).x).toEqual({
      consumer_key: "ck",
      consumer_secret: "cs",
      access_token: "at-new",
      access_token_secret: "ats",
    });
  });

  it("update: omitted fields keep the stored values too", async () => {
    await put({ provider: "x", fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at", access_token_secret: "ats" } });
    const res = await put({ provider: "x", fields: { access_token_secret: "ats-new" } });
    expect(res.status).toBe(200);
    expect((await getCredentialSecrets(USER_ID)).x).toEqual({
      consumer_key: "ck",
      consumer_secret: "cs",
      access_token: "at",
      access_token_secret: "ats-new",
    });
  });

  it("update: merges over a partial stored row (completing a contract the platform extended)", async () => {
    // Stored directly (the store is catalog-agnostic): three of x's four
    // fields — e.g. the shape saved before the platform added a field.
    await setCredential({
      userId: USER_ID,
      provider: "x",
      kind: "tool",
      fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at" },
    });
    const res = await put({ provider: "x", fields: { access_token_secret: "ats-new" } });
    expect(res.status).toBe(200);
    expect((await getCredentialSecrets(USER_ID)).x).toEqual({
      consumer_key: "ck",
      consumer_secret: "cs",
      access_token: "at",
      access_token_secret: "ats-new",
    });
  });

  it("update: a wholly-blank submission is rejected (no silent no-op writes)", async () => {
    await put({ provider: "openai", fields: { api_key: "sk-first" } });
    const res = await put({ provider: "openai", fields: { api_key: "   " } });
    expect(res.status).toBe(400);
    expect(await storedApiKey(USER_ID)).toBe("sk-first");
  });

  it("update on a row-less provider still requires the full contract", async () => {
    const res = await put({ provider: "x", fields: { consumer_key: "ck" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("all of its fields");
  });

  it("rejects an unknown BLANK field name too (the typo guard runs before blanks drop)", async () => {
    const res = await put({ provider: "openai", fields: { api_key: "", apy_kye: "x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("apy_kye");
  });

  it("rejects a missing fields map (400)", async () => {
    const res = await put({ provider: "openai" });
    expect(res.status).toBe(400);
  });

  it("rejects a blank field value (400)", async () => {
    const res = await put({ provider: "openai", fields: { api_key: "   " } });
    expect(res.status).toBe(400);
  });

  it("rejects an empty fields map (400)", async () => {
    const res = await put({ provider: "openai", fields: {} });
    expect(res.status).toBe(400);
  });

  it("rejects a provider the live catalog doesn't declare (400)", async () => {
    const res = await put({ provider: "not-a-provider", fields: { api_key: "x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not-a-provider");
  });

  it("is fail-closed when the platform is unreachable (503 — no key is saved)", async () => {
    mockFetchCredentialsCatalog.mockResolvedValue({
      catalog: null,
      catalogError:
        "Can't reach the agent builder — your saved keys are unaffected. New keys can't be added until it's back.",
    });
    const res = await put({ provider: "openai", fields: { api_key: "sk-x" } });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/your saved keys are unaffected/);
    const rows = await query(
      `SELECT provider FROM credentials WHERE user_id = $1`,
      [USER_ID],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("rejects a malformed body (400)", async () => {
    const res = await PUT(
      new Request("http://localhost:3000/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }) as NextRequest,
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 without a user", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await put({ provider: "openai", fields: { api_key: "sk-x" } });
    expect(res.status).toBe(401);
  });

  it("enforces the credentialMutate rate limit", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await put({ provider: "openai", fields: { api_key: "sk-x" } });
    expect(res.status).toBe(429);
  });
});

describe("DELETE /api/credentials/[provider]", () => {
  it("deletes an existing key (200) and it stays deleted", async () => {
    await put({ provider: "openai", fields: { api_key: "sk-x" } });
    const res = await del("openai");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    const get = await GET();
    expect((await get.json()).credentials).toEqual([]);
  });

  it("accepts ANY saved provider string — a provider removed from the catalog is still deletable", async () => {
    // The catalog is the live platform's; a provider it no longer knows
    // must never lock a key in. Stored directly (the route's PUT would
    // 400 it), but DELETE must still work.
    await setCredential({
      userId: USER_ID,
      provider: "removed-provider",
      kind: "tool",
      fields: { api_key: "sk-x" },
    });
    const res = await del("removed-provider");
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
  });

  it("returns 404 when nothing was stored", async () => {
    const res = await del("openai");
    expect(res.status).toBe(404);
  });

  it("never touches another user's key", async () => {
    await putAs(OTHER_USER_ID, { provider: "openai", fields: { api_key: "sk-theirs" } });
    const res = await del("openai", USER_ID);
    expect(res.status).toBe(404);
    const theirs = await query(
      `SELECT provider FROM credentials WHERE user_id = $1 AND provider = 'openai'`,
      [OTHER_USER_ID],
    );
    expect(theirs.rows).toHaveLength(1);
  });

  it("returns 401 without a user", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await del("openai");
    expect(res.status).toBe(401);
  });

  it("enforces the credentialMutate rate limit", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      new Response("Rate limited", { status: 429 }) as never,
    );
    const res = await del("openai");
    expect(res.status).toBe(429);
  });
});

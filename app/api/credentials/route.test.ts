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

// Passthrough wrapper around @/lib/db/pg that COUNTS withTransaction
// calls — proof that the PUT merge runs inside one transaction (the
// issue-#70 serialization boundary) without reimplementing the runner.
// Everything else forwards to the real module untouched.
const pgCounters = vi.hoisted(() => ({ withTransaction: 0 }));
vi.mock("@/lib/db/pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg")>();
  return {
    ...actual,
    withTransaction: (fn: Parameters<typeof actual.withTransaction>[0]) => {
      pgCounters.withTransaction += 1;
      return actual.withTransaction(fn);
    },
  };
});

import { GET, PUT } from "./route";
import { DELETE as DELETE_PROVIDER } from "./[provider]/route";
import { runMigrations } from "@/lib/db/migrate";
import { query, withTransaction } from "@/lib/db/pg";
import { useRealPostgres } from "@/lib/db/test-postgres";
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

/** PUT with a RAW body string — for malformed-JSON and size probes. */
function putRaw(body: string) {
  return PUT(
    new Request("http://localhost:3000/api/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
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
  // Inline test env (never env files): shrink the REAL-Postgres harness
  // pool below the PUT count of the hot-row pool-exhaustion test so the
  // no-pinned-connections invariant is proven deterministically. afterEach's
  // unstubAllEnvs keeps a reused vitest worker from leaking them into
  // other files.
  vi.stubEnv("PG_POOL_MAX", "2");
  vi.stubEnv("PG_CONNECT_TIMEOUT", "750");
  await runMigrations();
  // Reset AFTER migrations: runMigrations itself wraps its run in
  // withTransaction, and the counter must count the ROUTE's calls only.
  pgCounters.withTransaction = 0;
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
    // Encrypted at rest per field — every value must be a v1 ciphertext,
    // never the plaintext. (A substring scan can't express this check:
    // the plaintext "ck" is 2 chars inside the base64 alphabet, so a
    // random IV occasionally spells it inside the ciphertext — it burned
    // run 42442614816.)
    for (const value of Object.values(stored.rows[0].fields)) {
      expect(value).toMatch(/^enc:v1:/);
    }
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

  it("update: stored fields OUTSIDE the current contract are dropped, not carried along", async () => {
    // Stored directly: a field the catalog no longer declares (catalog
    // changed / stale row). The merge base is intersected with the
    // contract, so the junk field must not ride along into the new write.
    await setCredential({
      userId: USER_ID,
      provider: "openai",
      kind: "llm",
      fields: { api_key: "sk-good", legacy_field: "junk" },
    });
    const res = await put({ provider: "openai", fields: { api_key: "sk-rotated" } });
    expect(res.status).toBe(200);
    expect((await getCredentialSecrets(USER_ID)).openai).toEqual({
      api_key: "sk-rotated",
    });
  });

  it("update: dropping out-of-contract stored fields can expose a missing contract field (400)", async () => {
    // Stored row has junk + one contract field; user submits a DIFFERENT
    // contract field. After intersecting the stored base with the
    // contract, the merged map is incomplete → rejected, not saved half.
    await setCredential({
      userId: USER_ID,
      provider: "x",
      kind: "tool",
      fields: { legacy_field: "junk", consumer_key: "ck" },
    });
    const res = await put({ provider: "x", fields: { consumer_secret: "cs" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("all of its fields");
  });

  it("update: a wholly-blank submission is rejected (no silent no-op writes)", async () => {
    await put({ provider: "openai", fields: { api_key: "sk-first" } });
    const res = await put({ provider: "openai", fields: { api_key: "   " } });
    expect(res.status).toBe(400);
    expect(await storedApiKey(USER_ID)).toBe("sk-first");
  });

  it("update: an UNDECRYPTABLE stored row is treated as absent — a partial submission is rejected (forces full re-entry)", async () => {
    // Key rotation / backup mismatch: the stored ciphertext no longer
    // decrypts. The route must NOT merge the submission over garbage (a
    // half-valid row that partially works) — the row reads as absent, so
    // a single-field submission fails the completeness check and the user
    // must re-enter the full contract.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setCredential({ userId: USER_ID, provider: "x", kind: "tool", fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at", access_token_secret: "ats" } });
    await query(
      `UPDATE credentials SET fields = '{"consumer_key": "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==", "consumer_secret": "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==", "access_token": "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA==", "access_token_secret": "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA=="}' WHERE user_id = $1 AND provider = 'x'`,
      [USER_ID],
    );
    const res = await put({ provider: "x", fields: { consumer_key: "ck-new" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("all of its fields");

    // Re-entering the FULL contract still works (the undecryptable row is
    // upserted, not stuck) and the new values are the only ones stored.
    const full = await put({
      provider: "x",
      fields: { consumer_key: "ck-new", consumer_secret: "cs-new", access_token: "at-new", access_token_secret: "ats-new" },
    });
    expect(full.status).toBe(200);
    expect((await getCredentialSecrets(USER_ID)).x).toEqual({
      consumer_key: "ck-new",
      consumer_secret: "cs-new",
      access_token: "at-new",
      access_token_secret: "ats-new",
    });
    errSpy.mockRestore();
  });

  it("runs the read-merge-write inside ONE transaction (withTransaction per PUT)", async () => {
    const res = await put({ provider: "openai", fields: { api_key: "sk-tx" } });
    expect(res.status).toBe(200);
    expect(pgCounters.withTransaction).toBe(1);
  });

  it("takes the transaction even when the merge is REJECTED (the lock is held before the completeness decision)", async () => {
    // Seed a PARTIAL row directly (the store is catalog-agnostic); the
    // completeness check then fails INSIDE the tx, after the row lock —
    // no check-then-write gap for a concurrent writer to slip through.
    await setCredential({ userId: USER_ID, provider: "x", kind: "tool", fields: { consumer_key: "ck" } });
    pgCounters.withTransaction = 0;
    const res = await put({ provider: "x", fields: { consumer_secret: "cs" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("all of its fields");
    expect(pgCounters.withTransaction).toBe(1);
  });

  it("serializes concurrent PUTs for the same provider — every rotation survives (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      await query(`DELETE FROM credentials WHERE user_id = ANY($1)`, [
        [USER_ID, OTHER_USER_ID],
      ]);
      await setCredential({
        userId: USER_ID,
        provider: "x",
        kind: "tool",
        fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at", access_token_secret: "ats" },
      });

      // Hold the row's lock from OUTSIDE the routes so every PUT's
      // read-merge-write QUEUES behind it before any of them runs. Under
      // the fix each PUT blocks at its SELECT ... FOR UPDATE and reads
      // the store only after the previous writer committed. (Unserialized,
      // all four merges would read the ORIGINAL map before any write —
      // the last whole-map write would stomp the other three rotations.)
      let pending!: Promise<number[]>;
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT fields FROM credentials WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
          [USER_ID, "x"],
        );
        pending = Promise.all(
          [
            { consumer_key: "ck-1", consumer_secret: "", access_token: "", access_token_secret: "" },
            { consumer_key: "", consumer_secret: "cs-2", access_token: "", access_token_secret: "" },
            { consumer_key: "", consumer_secret: "", access_token: "at-3", access_token_secret: "" },
            { consumer_key: "", consumer_secret: "", access_token: "", access_token_secret: "ats-4" },
          ].map((fields) => put({ provider: "x", fields }).then((r) => r.status)),
        );
        // Give every PUT time to reach its lock wait, then release the
        // holder (COMMIT) — from here the PUTs proceed one at a time.
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      expect(await pending).toEqual([200, 200, 200, 200]);
      // THE assertion: four concurrent single-field rotations, one per
      // field, and ALL FOUR landed.
      expect((await getCredentialSecrets(USER_ID)).x).toEqual({
        consumer_key: "ck-1",
        consumer_secret: "cs-2",
        access_token: "at-3",
        access_token_secret: "ats-4",
      });
    } finally {
      restore();
    }
  });

  it("the row lock is a real serialization point: a competing FOR UPDATE waits, then times out (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip();
      return;
    }
    try {
      await query(`DELETE FROM credentials WHERE user_id = ANY($1)`, [
        [USER_ID, OTHER_USER_ID],
      ]);
      await setCredential({
        userId: USER_ID,
        provider: "x",
        kind: "tool",
        fields: { consumer_key: "ck", consumer_secret: "cs", access_token: "at", access_token_secret: "ats" },
      });
      // tx1 takes the route's lock and holds it; tx2 — the same shape of
      // statement the route runs — must block on that row. Proves
      // FOR UPDATE genuinely conflicts across connections (pg-mem has no
      // locking, so only real Postgres can answer this).
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT fields FROM credentials WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
          [USER_ID, "x"],
        );
        await expect(
          withTransaction(async (competing) => {
            // Transaction-local so nothing outlives this tx.
            await competing.query(`SET LOCAL lock_timeout = '250ms'`);
            await competing.query(
              `SELECT fields FROM credentials WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
              [USER_ID, "x"],
            );
          }),
        ).rejects.toMatchObject({ code: "55P03" }); // lock_not_available
      });
    } finally {
      restore();
    }
  });

  it("more concurrent same-row PUTs than PG_POOL_MAX all complete — blocked writers queue in-process, never pinning a pool connection (real Postgres)", async (ctx) => {
    const restore = await useRealPostgres();
    if (!restore) {
      ctx.skip(); // Docker-less local environment only; CI must never skip
      return;
    }
    try {
      await query(`DELETE FROM credentials WHERE user_id = ANY($1)`, [
        [USER_ID, OTHER_USER_ID],
      ]);
      await setCredential({
        userId: USER_ID,
        provider: "openai",
        kind: "llm",
        fields: { api_key: "sk-seed" },
      });
      // 4x the shrunken harness pool (PG_POOL_MAX=2, stubbed in beforeEach).
      const WRITERS = 8;

      let pending!: Promise<number[]>;
      await withTransaction(async (holder) => {
        await holder.query(
          `SELECT fields FROM credentials WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
          [USER_ID, "openai"],
        );
        pending = Promise.all(
          Array.from({ length: WRITERS }, (_, i) =>
            put({ provider: "openai", fields: { api_key: `sk-${i}` } }).then((r) => r.status),
          ),
        );
        // Hold the row lock LONGER than PG_CONNECT_TIMEOUT (750ms, also
        // stubbed in beforeEach). Without the per-key semaphore, every PUT
        // opens its transaction up front: 2 connections get granted and
        // block on the row lock, so the other 6 time out waiting for a
        // connection before the holder commits at 1.5s. With the
        // semaphore (acquired BEFORE the transaction), a PUT only touches
        // the pool once admitted — all 8 complete.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      });

      // THE assertion: no PUT timed out waiting for a connection — all 8
      // (pool max 2) came back 200.
      expect(await pending).toEqual(Array(WRITERS).fill(200));
      const stored = (await getCredentialSecrets(USER_ID)).openai;
      expect(stored?.api_key).toMatch(/^sk-\d$/);
    } finally {
      restore();
    }
  }, 30_000);

  it("rejects a field value over the 500-char body bound (400, nothing stored)", async () => {
    const res = await put({ provider: "openai", fields: { api_key: "k".repeat(501) } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
    const rows = await query(`SELECT provider FROM credentials WHERE user_id = $1`, [USER_ID]);
    expect(rows.rows).toHaveLength(0);
  });

  it("accepts a field value of exactly 500 chars (the boundary itself is legal)", async () => {
    const res = await put({ provider: "openai", fields: { api_key: "k".repeat(500) } });
    expect(res.status).toBe(200);
    expect((await getCredentialSecrets(USER_ID)).openai).toEqual({
      api_key: "k".repeat(500),
    });
  });

  it("rejects a provider over the 64-char bound (400)", async () => {
    const res = await put({ provider: "x".repeat(65), fields: { api_key: "k" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
  });

  it("survives a multi-MB MALFORMED JSON body with 400, never an unhandled 500", async () => {
    const big = "x".repeat(2_000_000);
    const res = await putRaw(`{"provider":"openai","fields":{"api_key":"${big}`);
    expect(res.status).toBe(400);
  });

  it("survives a multi-MB VALID JSON body that fails validation with 400, never an unhandled 500", async () => {
    const res = await putRaw(
      JSON.stringify({ provider: "openai", fields: { api_key: "x".repeat(2_000_000) } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
  });

  it("GET still lists an undecryptable row (field NAMES) so the user can re-enter it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setCredential({ userId: USER_ID, provider: "openai", kind: "llm", fields: { api_key: "sk-good" } });
    await query(
      `UPDATE credentials SET fields = '{"api_key": "enc:v1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA=="}' WHERE user_id = $1 AND provider = 'openai'`,
      [USER_ID],
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.credentials.find((c: { provider: string }) => c.provider === "openai");
    expect(row).toBeDefined();
    expect(row.fields).toContain("api_key"); // names only — never values
    errSpy.mockRestore();
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

  it("handles a pathological provider path cleanly (404, never an unhandled 500)", async () => {
    const res = await del("x".repeat(5000));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No credential stored for this provider");
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

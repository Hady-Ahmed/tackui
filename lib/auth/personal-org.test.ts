import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { admin, organization } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { query, getPoolOrTestClient } from "@/lib/db/pg";
import { useRealPostgres } from "@/lib/db/test-postgres";
import { auth } from "./auth";
import {
  ensurePersonalOrg,
  sessionCreateBeforeHook,
  type SessionHookSession,
} from "./personal-org";

// Two tiers, two very different jobs:
//
// - The pg-mem tier exercises ensurePersonalOrg's branching (create vs
//   reuse, org-name fallbacks) through the REAL Better Auth adapter.
// - The real-Postgres tier is the #208 regression test. pg-mem cannot
//   reproduce the bug: it does not emulate cross-connection transaction
//   visibility, so the hook's app-pool writes "saw" the uncommitted user
//   row there and never failed. Only real Postgres with real FK
//   constraints + two connections shows the failure — and the fix.

function fakeSession(userId: string): SessionHookSession {
  const now = new Date();
  return {
    id: randomUUID(),
    userId,
    token: `tok-${randomUUID()}`,
    expiresAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
    updatedAt: now,
    ipAddress: "",
    userAgent: "",
  };
}

describe("ensurePersonalOrg — via the real Better Auth adapter (pg-mem)", () => {
  async function ensureTables() {
    for (const [table, ddl] of [
      ["user", `CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT)`],
      ["organization", `CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, "createdAt" TIMESTAMPTZ)`],
      ["member", `CREATE TABLE member (id TEXT PRIMARY KEY, "organizationId" TEXT REFERENCES organization(id), "userId" TEXT REFERENCES "user"(id), role TEXT, "createdAt" TIMESTAMPTZ)`],
    ] as const) {
      const exists = await query<{ exists: number }>(
        `SELECT count(*)::int as exists FROM information_schema.tables WHERE table_name = $1`,
        [table],
      );
      if ((exists.rows[0]?.exists ?? 0) === 0) await query(ddl);
    }
  }

  beforeEach(async () => {
    await ensureTables();
    await query(`DELETE FROM member`);
    await query(`DELETE FROM organization`);
    await query(`DELETE FROM "user"`);
  });

  // The real auth instance's adapter, bound to this file's pg-mem emulator
  // (vitest.setup.ts injects it before the module graph loads).
  async function realAdapter() {
    const { adapter } = await auth.$context;
    return adapter;
  }

  it("creates a personal org + owner member when none exists (first signup)", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-1", "alice@test.com", "Alice", "user"],
    );

    const result = await ensurePersonalOrg(await realAdapter(), fakeSession("u-1"));

    expect(result.data.activeOrganizationId).toBeTruthy();

    const orgs = await query<{ name: string; slug: string }>(
      `SELECT name, slug FROM organization WHERE id = $1`,
      [result.data.activeOrganizationId],
    );
    expect(orgs.rows[0].name).toBe("Alice's workspace");
    expect(orgs.rows[0].slug).toBe("personal-u-1");

    const members = await query<{ role: string; userId: string }>(
      `SELECT role, "userId" FROM member WHERE "organizationId" = $1`,
      [result.data.activeOrganizationId],
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].role).toBe("owner");
    expect(members.rows[0].userId).toBe("u-1");
  });

  it("reuses the existing owner membership instead of creating a duplicate", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-1", "alice@test.com", "Alice", "user"],
    );
    const orgId = randomUUID();
    await query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
      [orgId, "Alice's workspace", "personal-u-1"],
    );
    await query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
      [randomUUID(), orgId, "u-1", "owner"],
    );

    const result = await ensurePersonalOrg(await realAdapter(), fakeSession("u-1"));

    expect(result.data.activeOrganizationId).toBe(orgId);
    const orgCount = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM organization WHERE slug = 'personal-u-1'`,
    );
    expect(orgCount.rows[0].count).toBe(1);
    const memberCount = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM member WHERE "userId" = 'u-1'`,
    );
    expect(memberCount.rows[0].count).toBe(1);
  });

  it("falls back to email for the org name when the user has no name", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-2", "bob@test.com", null, "user"],
    );

    const result = await ensurePersonalOrg(await realAdapter(), fakeSession("u-2"));

    const orgs = await query<{ name: string }>(
      `SELECT name FROM organization WHERE id = $1`,
      [result.data.activeOrganizationId],
    );
    expect(orgs.rows[0].name).toBe("bob@test.com's workspace");
  });

  it("falls back to 'My' when the user has no name or email", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-3", null, null, "user"],
    );

    const result = await ensurePersonalOrg(await realAdapter(), fakeSession("u-3"));

    const orgs = await query<{ name: string }>(
      `SELECT name FROM organization WHERE id = $1`,
      [result.data.activeOrganizationId],
    );
    expect(orgs.rows[0].name).toBe("My's workspace");
  });

  it("hook glue: resolves the base adapter outside a transaction and fails closed without a context", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-1", "alice@test.com", "Alice", "user"],
    );

    const { adapter } = await auth.$context;
    const result = await sessionCreateBeforeHook(fakeSession("u-1"), {
      context: { adapter },
    });
    expect(result.data.activeOrganizationId).toBeTruthy();

    await expect(
      sessionCreateBeforeHook(fakeSession("u-1"), null),
    ).rejects.toThrow(/endpoint context/);
  });
});

describe("personal org on signup — real-Postgres regression (#208)", () => {
  // The bug: Better Auth wraps email signup (user + account + session) in
  // ONE transaction on a dedicated connection, and the session hook's
  // app-pool writes ran on a DIFFERENT connection — the member.userId FK
  // check could not see the uncommitted user row, the insert failed, and
  // the whole signup rolled back (500) while the autocommitted org row
  // stayed behind as an orphan. Email-verification-enabled deployments
  // never hit it (no session is created at signup there), which is why
  // the E2E suite stayed green. These tests need real Postgres.
  let pgStarted = false;
  let restorePg: (() => void) | null = null;

  beforeAll(async () => {
    restorePg = await useRealPostgres();
    pgStarted = restorePg !== null;
  });

  afterAll(() => {
    restorePg?.();
    restorePg = null;
  });

  // Builds a throwaway Better Auth instance over the swapped-in real pool,
  // mirroring the production instance's shape (org plugin + the session
  // hook under test) minus env-dependent extras (SMTP, social, rate limits).
  // Tables are created by Better Auth's OWN migration machinery — the same
  // DDL production boots with, FK constraints included.
  async function buildTestAuth(
    hook: typeof sessionCreateBeforeHook | ((session: SessionHookSession) => Promise<{ data: SessionHookSession & { activeOrganizationId: string } }>),
  ) {
    const instance = betterAuth({
      database: getPoolOrTestClient(),
      secret: "test-secret",
      baseURL: "http://localhost:3000",
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: false },
      advanced: { database: { validateSchema: false } },
      plugins: [
        admin({ defaultRole: "user", adminRoles: ["admin"] }),
        organization(),
      ],
      databaseHooks: {
        session: { create: { before: hook } },
      },
    });
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
      instance.options,
    );
    if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
    return instance;
  }

  beforeEach(async (ctx) => {
    ctx.skip(!pgStarted, "Real Postgres (Docker) unavailable");
    // Better Auth's tables may not exist yet on the first test (they are
    // created by buildTestAuth's migrations), so clean only what's there.
    // Children before parents — the FKs are real.
    const existing = await query<{ tableName: string }>(
      `SELECT table_name AS "tableName" FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('member', 'organization', 'invitation', 'team',
                            'teamMember', 'session', 'account', 'verification', 'user')`,
    );
    const present = new Set(existing.rows.map((r) => r.tableName));
    for (const table of [
      "member", "session", "account", "verification", "invitation",
      "teamMember", "team", "organization", "user",
    ]) {
      if (present.has(table)) await query(`DELETE FROM "${table}"`);
    }
  });

  it("signs up the first user on a fresh DB without SMTP and commits everything atomically", async () => {
    const instance = await buildTestAuth(sessionCreateBeforeHook);

    await instance.api.signUpEmail({
      body: { email: "alice-208@test.example", password: "password123", name: "Alice 208" },
    });

    const users = await query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      ["alice-208@test.example"],
    );
    expect(users.rows).toHaveLength(1);
    const userId = users.rows[0].id;

    const orgs = await query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM organization`,
    );
    expect(orgs.rows).toHaveLength(1);
    // The org name comes from the user row created INSIDE the same
    // transaction — a hook that wrote on the wrong connection could not
    // even read it (it would have fallen back to "My's workspace").
    expect(orgs.rows[0].name).toBe("Alice 208's workspace");
    expect(orgs.rows[0].slug).toBe(`personal-${userId.slice(0, 8)}`);

    const members = await query<{
      role: string;
      userId: string;
      organizationId: string;
    }>(`SELECT role, "userId", "organizationId" FROM member`);
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]).toEqual({
      role: "owner",
      userId,
      organizationId: orgs.rows[0].id,
    });

    const sessions = await query<{ activeOrganizationId: string | null }>(
      `SELECT "activeOrganizationId" FROM session WHERE "userId" = $1`,
      [userId],
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0].activeOrganizationId).toBe(orgs.rows[0].id);
  });

  it("reuses the personal org on a subsequent sign-in (no duplicate)", async () => {
    const instance = await buildTestAuth(sessionCreateBeforeHook);
    const body = { email: "bob-208@test.example", password: "password123", name: "Bob 208" };

    await instance.api.signUpEmail({ body });
    await instance.api.signInEmail({ body });

    const users = await query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      [body.email],
    );
    expect(users.rows).toHaveLength(1);

    const orgs = await query<{ id: string }>(`SELECT id FROM organization`);
    expect(orgs.rows).toHaveLength(1);

    const members = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM member WHERE "userId" = $1`,
      [users.rows[0].id],
    );
    expect(members.rows[0].count).toBe(1);

    const sessions = await query<{ activeOrganizationId: string | null }>(
      `SELECT "activeOrganizationId" FROM session WHERE "userId" = $1`,
      [users.rows[0].id],
    );
    expect(sessions.rows).toHaveLength(2);
    for (const row of sessions.rows) {
      expect(row.activeOrganizationId).toBe(orgs.rows[0].id);
    }
  });

  it("the old app-pool hook fails the signup and strands an orphan org (negative control)", async () => {
    // The pre-fix hook, verbatim: reads/writes via the shared pool instead
    // of the transaction's connection. Against real Postgres the member
    // insert must FK-fail and roll the whole signup back — this is the
    // test that would have caught #208, and the guard against a
    // regression back to pool-based writes inside the hook.
    let orphanOrgId: string | null = null;
    const legacyPoolHook = async (
      session: SessionHookSession,
    ): Promise<{ data: SessionHookSession & { activeOrganizationId: string } }> => {
      const memberRow = await query<{ organizationId: string }>(
        `SELECT "organizationId" FROM member
         WHERE "userId" = $1 AND role = 'owner'
         ORDER BY "createdAt" ASC LIMIT 1`,
        [session.userId],
      );
      let orgId = memberRow.rows[0]?.organizationId ?? null;
      if (!orgId) {
        orgId = randomUUID();
        orphanOrgId = orgId;
        const userRow = await query<{ name: string | null; email: string | null }>(
          `SELECT name, email FROM "user" WHERE id = $1`,
          [session.userId],
        );
        const userName = userRow.rows[0]?.name ?? userRow.rows[0]?.email ?? "My";
        await query(
          `INSERT INTO organization (id, name, slug, "createdAt")
           VALUES ($1, $2, $3, now())`,
          [orgId, `${userName}'s workspace`, `personal-${session.userId.slice(0, 8)}`],
        );
        await query(
          `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
           VALUES ($1, $2, $3, $4, now())`,
          [randomUUID(), orgId, session.userId, "owner"],
        );
      }
      return { data: { ...session, activeOrganizationId: orgId } };
    };

    const instance = await buildTestAuth(legacyPoolHook);

    let signupFailed = false;
    try {
      await instance.api.signUpEmail({
        body: { email: "carol-208@test.example", password: "password123", name: "Carol 208" },
      });
    } catch {
      signupFailed = true;
    }
    expect(signupFailed).toBe(true);

    // The user (and its account + session) rolled back...
    const users = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM "user" WHERE email = $1`,
      ["carol-208@test.example"],
    );
    expect(users.rows[0].count).toBe(0);

    // ...while the autocommitted org row from the failed attempt stayed
    // behind with no member pointing at it — the orphan the issue
    // reported. The fix makes this impossible: the org insert joins the
    // transaction and dies with it.
    expect(orphanOrgId).toBeTruthy();
    const orphans = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM organization WHERE id = $1`,
      [orphanOrgId],
    );
    expect(orphans.rows[0].count).toBe(1);
    const orphanMembers = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`,
      [orphanOrgId],
    );
    expect(orphanMembers.rows[0].count).toBe(0);
  });
});

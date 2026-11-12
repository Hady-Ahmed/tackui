import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { query } from "@/lib/db/pg";
import { getEnabledProviders } from "./auth";

// The databaseHooks tests below re-extract hook logic and exercise it against
// pg-mem rather than driving the Better Auth instance: the hooks are small and
// the tests serve as regression guards on the SQL + branching. A few tests
// (the rate-limit override, the validateSchema flag) DO import `auth` itself
// because reading `auth.options` is a static object read — no DB touched.
//
// The re-declaration trade-off: it couples the hook tests to the hook's shape.
// If `auth.ts` changes a hook, the corresponding test must be updated. That
// coupling is acceptable — the hooks are small and the tests serve as
// regression guards.

async function runCreateAfterHook(user: { id: string }): Promise<void> {
  const row = await query<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM "user"`,
  );
  if ((row.rows[0]?.count ?? 0) === 1) {
    await query(
      `UPDATE "user" SET role = $1 WHERE id = $2`,
      ["admin", user.id],
    );
  }
}

async function runSessionCreateBeforeHook(session: {
  userId: string;
}): Promise<{ activeOrganizationId: string | null }> {
  const memberRow = await query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member
     WHERE "userId" = $1 AND role = 'owner'
     ORDER BY "createdAt" ASC LIMIT 1`,
    [session.userId],
  );

  let orgId = memberRow.rows[0]?.organizationId ?? null;

  if (!orgId) {
    orgId = randomUUID();

    const userRow = await query<{ name: string | null; email: string | null }>(
      `SELECT name, email FROM "user" WHERE id = $1`,
      [session.userId],
    );
    const userName =
      userRow.rows[0]?.name ?? userRow.rows[0]?.email ?? "My";
    const orgName = `${userName}'s workspace`;
    const slug = `personal-${session.userId.slice(0, 8)}`;

    await query(
      `INSERT INTO organization (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, now())`,
      [orgId, orgName, slug],
    );
    await query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, $4, now())`,
      [randomUUID(), orgId, session.userId, "owner"],
    );
  }

  return { activeOrganizationId: orgId };
}

async function ensureTables() {
  // pg-mem's `CREATE TABLE IF NOT EXISTS` parser doesn't handle the
  // IF NOT EXISTS branch on an existing table (see lib/db/migrate.ts).
  for (const [table, ddl] of [
    ["user", `CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT)`],
    ["organization", `CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, "createdAt" TIMESTAMPTZ)`],
    ["member", `CREATE TABLE member (id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT, role TEXT, "createdAt" TIMESTAMPTZ)`],
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

describe("databaseHooks.user.create.after — first-user-is-admin", () => {
  it("promotes the first user to admin", async () => {
    await query(
      `INSERT INTO "user" (id, email, role) VALUES ($1, $2, $3)`,
      ["u-1", "first@test.com", "user"],
    );
    await runCreateAfterHook({ id: "u-1" });

    const result = await query<{ role: string }>(
      `SELECT role FROM "user" WHERE id = $1`,
      ["u-1"],
    );
    expect(result.rows[0].role).toBe("admin");
  });

  it("does NOT promote the second user (stays 'user')", async () => {
    await query(
      `INSERT INTO "user" (id, email, role) VALUES ($1, $2, $3)`,
      ["u-1", "first@test.com", "admin"],
    );
    await query(
      `INSERT INTO "user" (id, email, role) VALUES ($1, $2, $3)`,
      ["u-2", "second@test.com", "user"],
    );
    await runCreateAfterHook({ id: "u-2" });

    const r1 = await query<{ role: string }>(
      `SELECT role FROM "user" WHERE id = $1`,
      ["u-1"],
    );
    const r2 = await query<{ role: string }>(
      `SELECT role FROM "user" WHERE id = $1`,
      ["u-2"],
    );
    expect(r1.rows[0].role).toBe("admin");
    expect(r2.rows[0].role).toBe("user");
  });

  it("does nothing when there are zero users (defensive)", async () => {
    await runCreateAfterHook({ id: "u-never" });

    const result = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM "user"`,
    );
    expect(result.rows[0].count).toBe(0);
  });

  it("promotes when count is exactly 1 (the bootstrap case)", async () => {
    await query(
      `INSERT INTO "user" (id, email, role) VALUES ($1, $2, $3)`,
      ["only", "only@test.com", "user"],
    );
    await runCreateAfterHook({ id: "only" });

    const result = await query<{ role: string }>(
      `SELECT role FROM "user" WHERE id = $1`,
      ["only"],
    );
    expect(result.rows[0].role).toBe("admin");
  });
});

describe("databaseHooks.session.create.before — personal org creation", () => {
  it("creates a personal org + owner member when none exists (first signup)", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-1", "alice@test.com", "Alice", "user"],
    );

    const result = await runSessionCreateBeforeHook({ userId: "u-1" });

    expect(result.activeOrganizationId).toBeTruthy();

    // Org was created with Alice's name
    const orgs = await query<{ name: string; slug: string }>(
      `SELECT name, slug FROM organization WHERE id = $1`,
      [result.activeOrganizationId],
    );
    expect(orgs.rows[0].name).toBe("Alice's workspace");
    expect(orgs.rows[0].slug).toBe("personal-u-1");

    // Member was created with owner role
    const members = await query<{ role: string; "userId": string }>(
      `SELECT role, "userId" FROM member WHERE "organizationId" = $1`,
      [result.activeOrganizationId],
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].role).toBe("owner");
    expect(members.rows[0].userId).toBe("u-1");
  });

  it("reuses existing org on subsequent login (does not create a duplicate)", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-1", "alice@test.com", "Alice", "user"],
    );
    // Simulate a prior signup that already created the org + member
    const orgId = randomUUID();
    await query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
      [orgId, "Alice's workspace", "personal-u-1"],
    );
    await query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
      [randomUUID(), orgId, "u-1", "owner"],
    );

    const result = await runSessionCreateBeforeHook({ userId: "u-1" });

    expect(result.activeOrganizationId).toBe(orgId);

    // No duplicate org or member created
    const orgCount = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM organization WHERE slug = 'personal-u-1'`,
    );
    expect(orgCount.rows[0].count).toBe(1);

    const memberCount = await query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM member WHERE "userId" = 'u-1'`,
    );
    expect(memberCount.rows[0].count).toBe(1);
  });

  it("falls back to email for org name when user has no name", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-2", "bob@test.com", null, "user"],
    );

    const result = await runSessionCreateBeforeHook({ userId: "u-2" });

    const orgs = await query<{ name: string }>(
      `SELECT name FROM organization WHERE id = $1`,
      [result.activeOrganizationId],
    );
    expect(orgs.rows[0].name).toBe("bob@test.com's workspace");
  });

  it("falls back to 'My' when user has no name or email", async () => {
    await query(
      `INSERT INTO "user" (id, email, name, role) VALUES ($1, $2, $3, $4)`,
      ["u-3", null, null, "user"],
    );

    const result = await runSessionCreateBeforeHook({ userId: "u-3" });

    const orgs = await query<{ name: string }>(
      `SELECT name FROM organization WHERE id = $1`,
      [result.activeOrganizationId],
    );
    expect(orgs.rows[0].name).toBe("My's workspace");
  });
});

describe("getEnabledProviders — synthetic admin in solo mode", () => {
  const originalAuthDisabled = process.env.AUTH_DISABLED;

  afterEach(() => {
    if (originalAuthDisabled === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalAuthDisabled;
    }
    vi.resetModules();
  });

  it("returns the synthetic admin when AUTH_DISABLED=true", () => {
    process.env.AUTH_DISABLED = "true";
    const config = getEnabledProviders();
    expect(config.authDisabled).toBe(true);
    expect(config.user).toEqual({
      id: "local",
      name: "Local user",
      role: "admin",
    });
  });

  it("returns user: null when AUTH_DISABLED is not true", async () => {
    process.env.AUTH_DISABLED = "false";
    vi.resetModules();
    const { getEnabledProviders: freshGetEnabledProviders } = await import("./auth");
    const config = freshGetEnabledProviders();
    expect(config.authDisabled).toBe(false);
    expect(config.user).toBeNull();
  });
});

describe("rateLimit.customRules — the AUTH_SIGNIN_RATE_MAX override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The sign-in rule the freshly constructed Better Auth instance carries.
  // customRules is evaluated at module load (maxFromEnv reads the env once
  // at boot), so each case re-imports ./auth after stubbing the env — the
  // same boot-time contract the limits tests exercise, one layer up: this
  // pins the WIRING (the env read actually feeds better-auth's rule),
  // not just the parser.
  async function signInRule() {
    const { auth: fresh } = await import("./auth");
    const rule = fresh.options.rateLimit?.customRules?.["/sign-in/email"];
    if (!rule) throw new Error("/sign-in/email rule missing from auth.options");
    return rule;
  }

  it("keeps 10/min when AUTH_SIGNIN_RATE_MAX is unset", async () => {
    // Guard against a leaked env from the invoking shell — the preset
    // only holds when the override is genuinely absent.
    delete process.env.AUTH_SIGNIN_RATE_MAX;
    expect(await signInRule()).toEqual({ window: 60, max: 10 });
  });

  it("reads AUTH_SIGNIN_RATE_MAX when it is a positive integer", async () => {
    vi.stubEnv("AUTH_SIGNIN_RATE_MAX", "30");
    expect(await signInRule()).toEqual({ window: 60, max: 30 });
  });

  it("ignores junk, zero, negative, fractional, and empty overrides — a typo can't disable the cap", async () => {
    for (const junk of ["banana", "0", "-5", "60.5", ""]) {
      vi.stubEnv("AUTH_SIGNIN_RATE_MAX", junk);
      vi.resetModules();
      expect(await signInRule(), `AUTH_SIGNIN_RATE_MAX=${junk}`).toEqual({
        window: 60,
        max: 10,
      });
    }
  });
});

describe("advanced.database.validateSchema — boot-time advisory off", () => {
  // better-auth 1.7's runtime schema check logs a misleading "Database schema
  // mismatch … Run npx auth migrate" ERROR on every boot against a DB without
  // auth tables (fresh deploys, E2E, CI). auth.ts disables it and documents
  // why (chicken-and-egg with ensureAuthTables; real failures still fail at
  // query time). This pins the flag so an accidental removal — or a "cleanup"
  // by someone who didn't read the comment — surfaces here instead of
  // re-adding the noise.
  it("is explicitly disabled", async () => {
    const { auth: fresh } = await import("./auth");
    expect(fresh.options.advanced?.database?.validateSchema).toBe(false);
  });
});

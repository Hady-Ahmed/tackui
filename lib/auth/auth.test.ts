import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { query } from "@/lib/db/pg";
import { auth, getEnabledProviders } from "./auth";
import { sessionCreateBeforeHook } from "./personal-org";

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
//
// The session.create.before hook (personal-org) lives in its own module with
// its own test file: its regression tests need a real Postgres (pg-mem cannot
// emulate cross-connection transaction visibility — see
// lib/auth/personal-org.test.ts).

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

async function ensureTables() {
  // pg-mem's `CREATE TABLE IF NOT EXISTS` parser doesn't handle the
  // IF NOT EXISTS branch on an existing table (see lib/db/migrate.ts).
  const exists = await query<{ exists: number }>(
    `SELECT count(*)::int as exists FROM information_schema.tables WHERE table_name = 'user'`,
  );
  if ((exists.rows[0]?.exists ?? 0) === 0) {
    await query(
      `CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT)`,
    );
  }
}

beforeEach(async () => {
  await ensureTables();
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

describe("databaseHooks.session.create.before — wiring", () => {
  // The hook's body lives in lib/auth/personal-org.ts (its behavior tests
  // are there). This pins the WIRING: the Better Auth instance must use the
  // transaction-adapter-aware hook, not an inline re-implementation — an
  // inline pool-based hook is exactly the #208 bug shape, and the
  // behavior tests below wouldn't see a swap back because they call the
  // module's own export.
  it("wires the personal-org hook into the Better Auth instance", () => {
    const hooks = auth.options.databaseHooks as {
      session?: { create?: { before?: unknown } };
    };
    expect(hooks?.session?.create?.before).toBe(sessionCreateBeforeHook);
  });
});

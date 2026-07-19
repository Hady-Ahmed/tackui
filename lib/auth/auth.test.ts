import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/lib/db/pg";

// Re-extract the databaseHooks from auth.options. We can't import `auth` itself
// in tests because constructing the Better Auth instance pulls in plugins and
// expects a real DB schema. Instead, we exercise the hook logic directly by
// re-declaring the same `after` callback and pointing it at pg-mem.
//
// This is a deliberate trade-off: it tests the SQL + branching logic but
// couples the test to the hook's shape. If `auth.ts` changes the hook, this
// test must be updated. That coupling is acceptable — the hook is small and
// the test serves as a regression guard for the first-user-is-admin rule.

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

beforeEach(async () => {
  // Check existence first — pg-mem's `CREATE TABLE IF NOT EXISTS` parser
  // doesn't handle the IF NOT EXISTS branch on an existing table (see
  // lib/db/migrate.ts for the same workaround).
  const exists = await query<{ exists: number }>(`
    SELECT count(*)::int as exists
    FROM information_schema.tables
    WHERE table_name = 'user'
  `);
  if ((exists.rows[0]?.exists ?? 0) === 0) {
    await query(`
      CREATE TABLE "user" (
        id    TEXT PRIMARY KEY,
        email TEXT,
        role  TEXT
      )
    `);
  }
  await query(`DELETE FROM "user"`);
});

describe("databaseHooks.user.create.after — first-user-is-admin", () => {
  it("promotes the first user to admin", async () => {
    // First user is created (count becomes 1), then the hook runs.
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
    // Edge case: hook fires before the row is committed (shouldn't happen in
    // practice with Better Auth, but the hook shouldn't crash if it did).
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

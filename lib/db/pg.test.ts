import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { newDb, type IMemoryDb } from "pg-mem";
import {
  query,
  withTransaction,
  setTestDb,
  closePool,
  getPool,
  type PgClient,
} from "./pg";

let db: IMemoryDb;

function installTestDb() {
  db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const client = Object.assign(pool, { release: () => {} }) as unknown as PgClient;
  setTestDb(client);
}

beforeEach(() => installTestDb());
afterEach(async () => {
  setTestDb(null);
  await closePool();
});

describe("query", () => {
  it("runs a simple SELECT", async () => {
    const result = await query<{ ok: boolean }>("SELECT true as ok");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].ok).toBe(true);
  });

  it("interpolates positional $1, $2 params", async () => {
    const result = await query<{ sum: number }>(
      "SELECT $1::int + $2::int as sum",
      [2, 3],
    );
    expect(result.rows[0].sum).toBe(5);
  });

  it("persists data across queries within the same test client", async () => {
    await query("CREATE TABLE t (id int)");
    await query("INSERT INTO t (id) VALUES ($1), ($2)", [10, 20]);
    const result = await query<{ id: number }>("SELECT id FROM t ORDER BY id");
    expect(result.rows.map((r) => r.id)).toEqual([10, 20]);
  });
});

describe("withTransaction", () => {
  beforeEach(async () => {
    await query("CREATE TABLE accounts (id int, balance int)");
    await query("INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 0)");
  });

  it("commits when fn returns successfully", async () => {
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE accounts SET balance = balance - $1 WHERE id = 2",
        [50],
      );
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = 1",
        [50],
      );
    });

    const a1 = await query<{ balance: number }>(
      "SELECT balance FROM accounts WHERE id = 1",
    );
    const a2 = await query<{ balance: number }>(
      "SELECT balance FROM accounts WHERE id = 2",
    );
    expect(a1.rows[0].balance).toBe(150);
    expect(a2.rows[0].balance).toBe(50);
  });

  // ROLLBACK across multiple pg.query() calls is not honored by pg-mem
  // (each statement auto-commits in its own implicit transaction).
  // The COMMIT path above verifies that statements do execute within
  // a withTransaction block; rollback behavior must be verified against
  // real Postgres (see testcontainers-based integration suite, planned
  // alongside PR4 when the PostgresAgentRunner lands).
  it.skip("rolls back when fn throws", async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query(
          "UPDATE accounts SET balance = balance - $1 WHERE id = 1",
          [100],
        );
        await client.query(
          "UPDATE accounts SET balance = balance + $1 WHERE id = 2",
          [100],
        );
        throw new Error("simulated failure mid-transfer");
      }),
    ).rejects.toThrow("simulated failure mid-transfer");

    const a1 = await query<{ balance: number }>(
      "SELECT balance FROM accounts WHERE id = 1",
    );
    const a2 = await query<{ balance: number }>(
      "SELECT balance FROM accounts WHERE id = 2",
    );
    expect(a1.rows[0].balance).toBe(100);
    expect(a2.rows[0].balance).toBe(0);
  });
});

describe("getPool / DATABASE_URL", () => {
  it("throws a helpful error when DATABASE_URL is unset and no test client is injected", async () => {
    setTestDb(null);
    await closePool();
    delete process.env.DATABASE_URL;

    expect(() => getPool()).toThrow(/DATABASE_URL is not set/);
  });
});

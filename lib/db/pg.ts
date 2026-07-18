import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
  type QueryConfig,
  type QueryConfigValues,
} from "pg";

export interface PgQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: QueryConfigValues<unknown[]>,
  ): Promise<QueryResult<T>>;
  query<T extends QueryResultRow = QueryResultRow>(
    config: QueryConfig<unknown[]>,
  ): Promise<QueryResult<T>>;
}

export interface PgClient extends PgQueryable {
  release(): void;
}

let pool: Pool | null = null;
let testClient: PgClient | null = null;

export function getPool(): Pool {
  if (testClient) {
    throw new Error(
      "getPool() called while a test client is injected; use query() in tests",
    );
  }
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Set it to a Postgres connection string " +
          "(e.g. postgres://user:pass@localhost:5432/dbname) or run the app " +
          "with docker-compose, which provides one automatically.",
      );
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT ?? 5_000),
    });
    pool.on("error", (err) => {
      console.error("[pg] idle client error", err);
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  if (testClient) return testClient.query<T>(text, values);
  return getPool().query<T>(text, values);
}

export async function withTransaction<T>(
  fn: (client: PgQueryable) => Promise<T>,
): Promise<T> {
  if (testClient) {
    await testClient.query("BEGIN");
    try {
      const result = await fn(testClient);
      await testClient.query("COMMIT");
      return result;
    } catch (err) {
      await testClient.query("ROLLBACK");
      throw err;
    }
  }
  const p = getPool();
  const client = (await p.connect()) as unknown as PoolClient & PgClient;
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

export function setTestDb(client: PgClient | null): void {
  testClient = client;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the DB layer — the deep probe's contract is "one round-trip, count
// the applied migrations, never leak error detail".
const mockQuery = vi.fn();
vi.mock("@/lib/db/pg", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import { GET } from "./route";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("GET /api/health", () => {
  it("plain probe: 200 + ok without touching the database", async () => {
    const res = await GET(new Request("http://localhost:3000/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("deep probe: 200 with the applied migration count when the DB answers", async () => {
    mockQuery.mockResolvedValue({ rows: [{ applied: 13 }] });
    const res = await GET(new Request("http://localhost:3000/api/health?deep=true"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true, migrations: 13 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toContain("schema_migrations");
  });

  it("deep probe: 503 with a GENERIC error when the DB is unreachable (no driver detail leaks)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQuery.mockRejectedValue(
      new Error('connection refused: postgres://user:secret@db.internal:5432/app'),
    );
    const res = await GET(new Request("http://localhost:3000/api/health?deep=true"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.db).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("db.internal");
    expect(JSON.stringify(body)).not.toContain("connection refused");
    errSpy.mockRestore();
  });

  it("deep probe: anything-but-true does not enable the DB round-trip", async () => {
    const res = await GET(new Request("http://localhost:3000/api/health?deep=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

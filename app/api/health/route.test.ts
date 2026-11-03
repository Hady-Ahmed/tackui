import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the DB layer — the deep probe's contract is "one round-trip, count
// the applied migrations, never leak error detail".
const mockQuery = vi.fn();
vi.mock("@/lib/db/pg", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import { GET } from "./route";
import { _resetForTests } from "@/lib/ratelimit/store";

beforeEach(() => {
  mockQuery.mockReset();
  // The deep probe's per-IP limiter is module state — fresh window per
  // test so the 429 pins below start from an empty counter.
  _resetForTests();
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
    // `ok` is false too — a body reading ok:true on a failure status would
    // confuse boolean-keyed smoke scripts.
    expect(body.ok).toBe(false);
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

  it("deep probe: floods of the unauthenticated DB roundtrip 429 per client IP", async () => {
    // The route is exempt from the proxy's per-IP flood limiter (orchestrator
    // probes carry no session), so the deep branch limits itself — otherwise
    // an anonymous flood of ?deep=true is an unauthenticated DB-load vector.
    mockQuery.mockResolvedValue({ rows: [{ applied: 13 }] });
    for (let i = 0; i < 30; i++) {
      const res = await GET(
        new Request("http://localhost:3000/api/health?deep=true", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
      );
      expect(res.status).toBe(200);
    }
    const flooded = await GET(
      new Request("http://localhost:3000/api/health?deep=true", {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
    );
    expect(flooded.status).toBe(429);
    // The 429 never reaches the DB.
    expect(mockQuery).toHaveBeenCalledTimes(30);
  });

  it("deep probe: the per-IP limit isolates clients — another IP still passes", async () => {
    mockQuery.mockResolvedValue({ rows: [{ applied: 13 }] });
    for (let i = 0; i < 30; i++) {
      await GET(
        new Request("http://localhost:3000/api/health?deep=true", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
      );
    }
    // A different client IP (e.g. the real orchestrator) is unaffected.
    // CF-Connecting-IP is NOT trusted outside SaaS mode / an explicit flag
    // (client-suppliable there), so the distinct client is keyed by XFF.
    const res = await GET(
      new Request("http://localhost:3000/api/health?deep=true", {
        headers: { "x-forwarded-for": "198.51.100.9" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("deep probe: a spoofed CF-Connecting-IP does not open a fresh bucket", async () => {
    // Same defense the proxy flood limiter pins: without CF trust, a
    // rotating/spoofed CF-Connecting-IP must not reset the counter — the
    // request with the same XFF still lands in the exhausted bucket.
    mockQuery.mockResolvedValue({ rows: [{ applied: 13 }] });
    for (let i = 0; i < 30; i++) {
      await GET(
        new Request("http://localhost:3000/api/health?deep=true", {
          headers: { "x-forwarded-for": "203.0.113.42" },
        }),
      );
    }
    const spoofed = await GET(
      new Request("http://localhost:3000/api/health?deep=true", {
        headers: {
          "x-forwarded-for": "203.0.113.42",
          "cf-connecting-ip": "10.9.9.1",
        },
      }),
    );
    expect(spoofed.status).toBe(429);
    // The spoofed probe never reached the DB.
    expect(mockQuery).toHaveBeenCalledTimes(30);
  });

  it("plain liveness stays unlimited — the flood cap only guards the deep branch", async () => {
    // Even with the same IP exhausted on deep probes, the plain probe
    // (no I/O) keeps answering.
    for (let i = 0; i < 35; i++) {
      const res = await GET(
        new Request("http://localhost:3000/api/health", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
      );
      expect(res.status).toBe(200);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

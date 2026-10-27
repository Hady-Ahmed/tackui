import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock auth + rate limiter; connector-store is real (pg-mem) so the
// http(s)-only / name-pattern schemas and token semantics are exercised.
const mockGetCurrentUser = vi.fn();
const mockCanManageAgents = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
  canManageAgents: (...a: unknown[]) => mockCanManageAgents(...a),
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

import { GET, PUT } from "./route";
import { listConnectors, deleteConnector } from "@/lib/connectors/connector-store";
import { runMigrations } from "@/lib/db/migrate";
import type { NextRequest } from "next/server";

const ORG = "org-conn";
const OTHER_ORG = "org-other";
const ENCRYPTION_TEST_KEY = "cd".repeat(32);

function adminUser() {
  return { id: "admin-1", role: "admin", name: "Admin", email: null, orgId: ORG };
}
function memberUser() {
  return { id: "member-1", role: "user", name: "Member", email: null, orgId: ORG };
}

async function put(body: unknown) {
  return PUT(
    new Request("http://localhost:3000/api/connectors", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as NextRequest,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("DB_ENCRYPTION_KEY", ENCRYPTION_TEST_KEY);
  await runMigrations();
  for (const org of [ORG, OTHER_ORG]) {
    for (const c of await listConnectors(org)) await deleteConnector(org, c.name);
  }
  mockGetCurrentUser.mockImplementation(async () => adminUser());
  mockCanManageAgents.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/connectors", () => {
  it("returns 401 when not signed in", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the org's connectors without tokens, org-scoped", async () => {
    await put({ name: "github", url: "https://mcp.example.com/github", token: "tok-1" });
    await put({ name: "linear", url: "https://mcp.example.com/linear" });
    // A connector in another org must not leak into this org's list.
    await listConnectors(OTHER_ORG);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectors.map((c: { name: string }) => c.name)).toEqual([
      "github",
      "linear",
    ]);
    for (const c of body.connectors) {
      expect(c).not.toHaveProperty("token");
    }
    // Per-connector token existence (github got one, linear didn't).
    expect(body.connectors.find((c: { name: string }) => c.name === "github").hasToken).toBe(true);
    expect(body.connectors.find((c: { name: string }) => c.name === "linear").hasToken).toBe(false);
  });
});

describe("PUT /api/connectors", () => {
  it("returns 401 when not signed in", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await put({ name: "x", url: "https://mcp.example.com/x" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for members (org-admin only)", async () => {
    mockGetCurrentUser.mockImplementation(async () => memberUser());
    mockCanManageAgents.mockResolvedValue(false);
    const res = await put({ name: "x", url: "https://mcp.example.com/x" });
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await PUT(
      new Request("http://localhost:3000/api/connectors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }) as NextRequest,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 for a non-http(s) url (store schema)", async () => {
    const res = await put({ name: "x", url: "ftp://mcp.example.com/x" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("creates a connector without a token", async () => {
    const res = await put({ name: "notion", url: "https://mcp.example.com/notion" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("notion");
    expect(body.hasToken).toBe(false);
    expect(body).not.toHaveProperty("token");
  });

  it("creates a connector with a token", async () => {
    const res = await put({
      name: "github",
      url: "https://mcp.example.com/github",
      token: "tok-1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasToken).toBe(true);
  });

  it("preserves the stored token when token is omitted", async () => {
    await put({ name: "github", url: "https://mcp.example.com/github", token: "tok-1" });
    const res = await put({ name: "github", url: "https://mcp.example.com/github" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasToken).toBe(true);
  });

  it("clears the token when token is an empty string", async () => {
    await put({ name: "github", url: "https://mcp.example.com/github", token: "tok-1" });
    const res = await put({
      name: "github",
      url: "https://mcp.example.com/github",
      token: "",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasToken).toBe(false);
  });
});

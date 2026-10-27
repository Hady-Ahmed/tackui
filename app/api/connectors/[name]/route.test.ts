import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock auth + rate limiter; connector-store is real (pg-mem).
const mockGetCurrentUser = vi.fn();
const mockCanManageAgents = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
  canManageAgents: (...a: unknown[]) => mockCanManageAgents(...a),
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

import { DELETE } from "./route";
import { listConnectors, deleteConnector, upsertConnector } from "@/lib/connectors/connector-store";
import { runMigrations } from "@/lib/db/migrate";
import type { NextRequest } from "next/server";

const ORG = "org-conn-del";

function adminUser() {
  return { id: "admin-1", role: "admin", name: "Admin", email: null, orgId: ORG };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("DB_ENCRYPTION_KEY", "cd".repeat(32));
  await runMigrations();
  for (const c of await listConnectors(ORG)) await deleteConnector(ORG, c.name);
  mockGetCurrentUser.mockImplementation(async () => adminUser());
  mockCanManageAgents.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DELETE /api/connectors/[name]", () => {
  it("returns 401 when not signed in", async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await DELETE(new Request("http://localhost:3000/api/connectors/x") as NextRequest, {
      params: Promise.resolve({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for members", async () => {
    mockGetCurrentUser.mockImplementation(async () => ({
      id: "member-1", role: "user", name: "m", email: null, orgId: ORG,
    }));
    mockCanManageAgents.mockResolvedValue(false);
    const res = await DELETE(new Request("http://localhost:3000/api/connectors/x") as NextRequest, {
      params: Promise.resolve({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the org has no such connector", async () => {
    const res = await DELETE(new Request("http://localhost:3000/api/connectors/ghost") as NextRequest, {
      params: Promise.resolve({ name: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes the org's connector and returns ok", async () => {
    await upsertConnector({ orgId: ORG, name: "github", url: "https://mcp.example.com/github" });
    const res = await DELETE(new Request("http://localhost:3000/api/connectors/github") as NextRequest, {
      params: Promise.resolve({ name: "github" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(await listConnectors(ORG)).toEqual([]);
  });
});

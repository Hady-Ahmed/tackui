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

// The platform-registry delete is a network round trip — stubbed for the
// happy paths; the push-first ordering test rewires it.
const mockDeletePlatformConnector = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/connectors/platform-sync", () => ({
  deletePlatformConnector: (...a: unknown[]) => mockDeletePlatformConnector(...a),
}));

import { DELETE } from "./route";
import { listConnectors, deleteConnector, upsertConnector } from "@/lib/connectors/connector-store";
import { AgentosError } from "@/lib/agents/builder";
import { runMigrations } from "@/lib/db/migrate";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { NextResponse, type NextRequest } from "next/server";

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
    // Auth gates first — the per-user limiter is keyed on user.id and
    // must never be consulted for an anonymous request.
    expect(vi.mocked(checkUserLimit)).not.toHaveBeenCalled();
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
    // The platform registry entry is removed by the row's ID.
    const stored = await upsertConnector({ orgId: ORG, name: "linear", url: "https://mcp.example.com/linear" });
    await DELETE(new Request("http://localhost:3000/api/connectors/linear") as NextRequest, {
      params: Promise.resolve({ name: "linear" }),
    });
    expect(mockDeletePlatformConnector).toHaveBeenLastCalledWith(stored.id);
  });

  it("deletes FIRST: a failed platform delete changes nothing locally (row intact)", async () => {
    const stored = await upsertConnector({ orgId: ORG, name: "github", url: "https://mcp.example.com/github" });
    mockDeletePlatformConnector.mockRejectedValueOnce(new AgentosError(502, "agentos unavailable"));
    const res = await DELETE(new Request("http://localhost:3000/api/connectors/github") as NextRequest, {
      params: Promise.resolve({ name: "github" }),
    });
    // The upstream status propagates (agentosErrorResponse) — and nothing
    // was deleted locally: a failed delete leaves the two stores agreeing
    // (both with the connector), so a retry is safe.
    expect(res.status).toBe(502);
    // Nothing was deleted locally — the push-first contract: a failed
    // delete leaves the two stores agreeing (both with the connector).
    expect((await listConnectors(ORG)).map((c) => c.id)).toEqual([stored.id]);
  });
});

describe("DELETE /api/connectors/[name] rate limit", () => {
  it("charges the connectorMutate bucket and propagates its 429 (no delete happens)", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await DELETE(new Request("http://localhost:3000/api/connectors/github") as NextRequest, {
      params: Promise.resolve({ name: "github" }),
    });
    expect(res.status).toBe(429);
    expect(vi.mocked(checkUserLimit)).toHaveBeenCalledWith("admin-1", "connectorMutate");
    // The platform push never started — a 429 must not consume work.
    expect(mockDeletePlatformConnector).not.toHaveBeenCalled();
  });
});

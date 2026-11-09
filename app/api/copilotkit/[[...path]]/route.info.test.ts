import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AbstractAgent } from "@ag-ui/client";

// Unlike route.test.ts (which stubs the runtime to focus on the gating
// wrapper), this file drives the REAL CopilotKit runtime handler: the
// subject is what /info actually answers. Issue #74 was a contract break
// visible only end-to-end — the registry threw on a zero-agent org, the
// runtime wrapped that as a 500, and every page load of a fresh
// workspace logged `runtime_info_fetch_failed` in the browser console.
// Only app seams (auth, rate limiting, gates, DB-backed runner) are
// mocked here; the /info path itself is the genuine
// createCopilotRuntimeHandler → handleGetRuntimeInfo pipeline.
vi.mock("@/lib/agents/registry", () => ({
  getAgents: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/agents/runner-instance", () => ({ runner: {} }));
vi.mock("@/lib/auth/auth", () => ({ isAuthDisabled: vi.fn().mockReturnValue(false) }));
vi.mock("@/lib/auth/context", () => ({
  getRequestUser: vi.fn(),
  getSyntheticAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/request-context", () => ({
  runWithUserAsync: vi.fn(async (_u: unknown, fn: () => Promise<Response>) => fn()),
  runWithRunnerContext: vi.fn(
    async (_u: unknown, _c: unknown, _k: unknown, fn: () => Promise<Response>) => fn(),
  ),
}));
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
  acquireConcurrent: vi.fn(),
}));
vi.mock("@/lib/ratelimit/stream-wrap", () => ({
  wrapStreamWithRelease: vi.fn((res: Response) => res),
}));
vi.mock("@/lib/plans/enforcement", () => ({
  getEnforcementLimits: vi.fn().mockResolvedValue({ plan: "free", limits: {} }),
  checkCatalogRunGates: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/agents/run-gate", () => ({
  emptyBuilderRunResolution: vi.fn(() => ({
    response: null,
    contextItems: [],
    platformKeyRun: false,
    reservedDepKeys: [],
  })),
  checkBuilderRunGate: vi.fn().mockResolvedValue({
    response: null,
    contextItems: [],
    platformKeyRun: false,
    reservedDepKeys: [],
  }),
  consumeBuilderRunQuota: vi.fn().mockResolvedValue(null),
}));

import { GET } from "./route";
import { getAgents } from "@/lib/agents/registry";
import { getRequestUser } from "@/lib/auth/context";

const USER = {
  id: "user-1",
  role: "member",
  name: "Test User",
  email: "test@example.com",
  orgId: "org-1",
};

const INFO_URL = "http://localhost:3000/api/copilotkit/info";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAgents).mockResolvedValue({});
  vi.mocked(getRequestUser).mockResolvedValue(USER);
});

describe("copilotkit route — GET /info with an empty workspace (issue #74)", () => {
  it("returns 200 with an empty agent list for an org with zero agents", async () => {
    // The acceptance criterion: a fresh workspace is a NORMAL state. The
    // real runtime resolves the registry ({}) and answers 200 — the
    // client renders its "No agents yet" empty state with a clean
    // console, instead of logging `runtime_info_fetch_failed` against a
    // 500 on every page load.
    const res = await GET(new Request(INFO_URL));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual({});
    expect(typeof body.version).toBe("string");
    expect(getAgents).toHaveBeenCalledTimes(1);
  });

  it("lists agents normally once the workspace has one (positive control)", async () => {
    // Guards the empty-case test from passing vacuously: if the resolver
    // wiring broke (e.g. the factory stopped being consulted), BOTH tests
    // would see an empty list. A listed agent proves the resolver output
    // actually reaches /info.
    // A plain-object stand-in suffices: handleGetRuntimeInfo only reads
    // `description`, optional `getCapabilities()`, and `constructor.name`.
    vi.mocked(getAgents).mockResolvedValue({
      ag1: { description: "test agent" } as unknown as AbstractAgent,
    });

    const res = await GET(new Request(INFO_URL));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.agents)).toEqual(["ag1"]);
    expect(body.agents.ag1.description).toBe("test agent");
  });

  it("still errors for an unauthenticated caller (the empty case must not launder auth failures)", async () => {
    // Test the bypass, not just the happy path: the 200-for-empty
    // contract must not weaken the route's auth gate. With auth enabled
    // and no resolvable user, /info is refused by the route wrapper
    // BEFORE the inner handler — 401, not a 200 empty list.
    vi.mocked(getRequestUser).mockResolvedValue(null);

    const res = await GET(new Request(INFO_URL));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    // The runtime (and its registry resolver) was never reached.
    expect(getAgents).not.toHaveBeenCalled();
  });
});

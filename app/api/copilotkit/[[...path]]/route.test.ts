import { describe, it, expect, beforeEach, vi } from "vitest";

// The CopilotKit runtime is a third-party integration — stubbed so the
// route module boots without it. The inner handler never runs meaningfully
// in these tests: they exercise the gating wrapper AROUND it.
vi.mock("@copilotkit/runtime/v2", () => ({
  CopilotRuntime: class {
    constructor(_opts: unknown) {
      void _opts; // construction-only mock — the tests never drive the runtime
    }
  },
  createCopilotRuntimeHandler: vi.fn(() => () => new Response("ok")),
}));

// Third-party/auth seams the route touches at import or per request.
vi.mock("@/lib/agents/registry", () => ({ getAgents: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/agents/runner-instance", () => ({ runner: {} }));
vi.mock("@/lib/auth/auth", () => ({ isAuthDisabled: vi.fn().mockReturnValue(false) }));
vi.mock("@/lib/config/saas", () => ({ SAAS_MODE: true }));
vi.mock("@/lib/auth/context", () => ({
  getRequestUser: vi.fn(),
  getSyntheticAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/request-context", () => ({
  runWithUserAsync: vi.fn(async (_u: unknown, fn: () => Promise<Response>) => fn()),
  // Signature matches the route's call: (user, contextItems, reservedDepKeys, fn).
  // The reservedDepKeys param MUST stay in the list — the first test that
  // passes context items would otherwise invoke the array as a function.
  runWithRunnerContext: vi.fn(
    async (_u: unknown, _c: unknown, _k: unknown, fn: () => Promise<Response>) => fn(),
  ),
}));
vi.mock("@/lib/ratelimit/stream-wrap", () => ({
  wrapStreamWithRelease: vi.fn((res: Response) => res),
}));

// The rate limiter: checkUserLimit allows; acquireConcurrent hands out a
// tracked release per test. The limiter itself is tested in lib/ratelimit/.
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
  acquireConcurrent: vi.fn(),
}));

// Plan enforcement: default allow. Tested in lib/plans/enforcement.test.ts.
vi.mock("@/lib/plans/enforcement", () => ({
  getEnforcementLimits: vi
    .fn()
    .mockResolvedValue({ plan: "free", limits: { runsPerMinute: 10, concurrentRuns: 1 } }),
  checkCatalogRunGates: vi.fn().mockResolvedValue(null),
}));

// The builder gate is the subject under test here — configured per test.
vi.mock("@/lib/agents/run-gate", () => ({
  emptyBuilderRunResolution: vi.fn(() => ({
    response: null,
    contextItems: [],
    platformKeyRun: false,
    reservedDepKeys: [],
  })),
  checkBuilderRunGate: vi.fn(),
  consumeBuilderRunQuota: vi.fn(),
}));

import { POST } from "./route";
import { NextResponse } from "next/server";
import { getRequestUser, getSyntheticAdmin } from "@/lib/auth/context";
import { isAuthDisabled } from "@/lib/auth/auth";
import { acquireConcurrent, checkUserLimit } from "@/lib/ratelimit/middleware";
import { checkBuilderRunGate, consumeBuilderRunQuota } from "@/lib/agents/run-gate";
import {
  runWithRunnerContext,
  runWithUserAsync,
} from "@/lib/auth/request-context";
import type { BuilderRunResolution } from "@/lib/agents/run-gate";

const USER = {
  id: "user-1",
  role: "member",
  name: "Test User",
  email: "test@example.com",
  orgId: "org-1",
};
const RUN_URL = "http://localhost:3000/api/copilotkit/agent/test-agent/run";

function resolution(overrides: Partial<BuilderRunResolution> = {}): BuilderRunResolution {
  return {
    response: null,
    contextItems: [],
    platformKeyRun: false,
    reservedDepKeys: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRequestUser).mockResolvedValue(USER);
  vi.mocked(checkBuilderRunGate).mockResolvedValue(resolution());
  vi.mocked(consumeBuilderRunQuota).mockResolvedValue(null);
});

describe("copilotkit route — builder run gate wiring", () => {
  it("releases the concurrent slot when the platform-key quota refuses (402)", async () => {
    // The invariant this pins: a quota 402 comes AFTER the slot was
    // acquired, so the route must give the slot back — otherwise a user
    // at their concurrent cap who fires a platform-key run loses a daily
    // run without any run happening.
    const release = vi.fn();
    vi.mocked(acquireConcurrent).mockReturnValue(release);
    vi.mocked(checkBuilderRunGate).mockResolvedValue(resolution({ platformKeyRun: true }));
    vi.mocked(consumeBuilderRunQuota).mockResolvedValue(
      NextResponse.json({ error: "quota" }, { status: 402 }),
    );

    const res = await POST(new Request(RUN_URL, { method: "POST" }));

    expect(res.status).toBe(402);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("never acquires a concurrent slot for a gate-refused run", async () => {
    // Phase ordering: the gate phase (402s for unsatisfiable requirements)
    // runs BEFORE slot acquisition — a refused run must hold nothing.
    vi.mocked(checkBuilderRunGate).mockResolvedValue(
      resolution({ response: NextResponse.json({ error: "gated" }, { status: 402 }) }),
    );

    const res = await POST(new Request(RUN_URL, { method: "POST" }));

    expect(res.status).toBe(402);
    expect(acquireConcurrent).not.toHaveBeenCalled();
  });

  it("never pushes per-run dependencies for a gate-refused run (guard before push)", async () => {
    // Phase ordering, credential half: the per-run dependency stash is
    // created inside runWithRunnerContext — a gate-refused run must never
    // reach it, otherwise the registry middleware could deliver resolved
    // credentials for a run the gate already refused.
    vi.mocked(checkBuilderRunGate).mockResolvedValue(
      resolution({
        response: NextResponse.json({ error: "gated" }, { status: 402 }),
        contextItems: [{ description: "tavily_api_key", value: "tvly-secret" }],
        reservedDepKeys: ["tavily_api_key"],
      }),
    );

    const res = await POST(new Request(RUN_URL, { method: "POST" }));

    expect(res.status).toBe(402);
    expect(runWithRunnerContext).not.toHaveBeenCalled();
    expect(consumeBuilderRunQuota).not.toHaveBeenCalled();
  });

  it("leaves the slot to the stream wrapper on the happy path", async () => {
    // On success the slot is released when the SSE stream closes
    // (wrapStreamWithRelease), NOT synchronously — releasing here would
    // admit a concurrent run beyond the cap. The release simply must not
    // have been called by the time the response returns.
    const release = vi.fn();
    vi.mocked(acquireConcurrent).mockReturnValue(release);
    vi.mocked(checkBuilderRunGate).mockResolvedValue(resolution({ platformKeyRun: true }));
    vi.mocked(consumeBuilderRunQuota).mockResolvedValue(null);

    const res = await POST(new Request(RUN_URL, { method: "POST" }));

    expect(res.status).toBe(200);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases the slot when the quota check itself throws", async () => {
    // consumeBuilderRunQuota does a DB round-trip AFTER the slot was
    // acquired — a throw there must not leak the slot to the watchdog.
    const release = vi.fn();
    vi.mocked(acquireConcurrent).mockReturnValue(release);
    vi.mocked(checkBuilderRunGate).mockResolvedValue(resolution({ platformKeyRun: true }));
    vi.mocked(consumeBuilderRunQuota).mockRejectedValue(new Error("db down"));

    await expect(POST(new Request(RUN_URL, { method: "POST" }))).rejects.toThrow(
      "db down",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("routes a gated builder run with an EMPTY stash through the runner context (exact-set strip applies even with nothing delivered)", async () => {
    // Keyless model, no keyed tools → no contextItems, but the run is
    // still gated: the registry must strip any client-supplied reserved
    // dep keys (e.g. a forged ollama_api_key), which only the
    // runner-context path guarantees. Keying this selection on
    // contextItems.length would silently drop the strip.
    vi.mocked(checkBuilderRunGate).mockResolvedValue(
      resolution({ contextItems: [], reservedDepKeys: ["mcp_connectors", "ollama_api_key"] }),
    );

    await POST(new Request(RUN_URL, { method: "POST" }));

    expect(runWithRunnerContext).toHaveBeenCalledTimes(1);
    expect(runWithUserAsync).not.toHaveBeenCalled();
  });

  it("routes a non-builder run through the plain user context", async () => {
    // emptyBuilderRunResolution (no reservedDepKeys) — no gate, no stash,
    // no strip needed.
    vi.mocked(checkBuilderRunGate).mockResolvedValue(
      resolution({ reservedDepKeys: [] }),
    );

    await POST(new Request(RUN_URL, { method: "POST" }));

    expect(runWithUserAsync).toHaveBeenCalledTimes(1);
    expect(runWithRunnerContext).not.toHaveBeenCalled();
  });
});

describe("copilotkit route — solo mode (self-host)", () => {
  it("applies the builder gate and delivers deps WITHOUT any rate limiting or slot acquisition", async () => {
    vi.mocked(isAuthDisabled).mockReturnValue(true);
    const synthetic = { ...USER, id: "synthetic-admin", orgId: "solo-org" };
    vi.mocked(getSyntheticAdmin).mockResolvedValue(synthetic);
    vi.mocked(checkBuilderRunGate).mockResolvedValue(
      resolution({
        contextItems: [{ description: "openai_api_key", value: "sk-test" }],
        reservedDepKeys: ["mcp_connectors", "openai_api_key"],
      }),
    );

    const res = await POST(new Request(RUN_URL, { method: "POST" }));

    expect(res.status).toBe(200);
    // The member path is skipped entirely — no auth lookup, no limits.
    expect(getRequestUser).not.toHaveBeenCalled();
    expect(acquireConcurrent).not.toHaveBeenCalled();
    // But the builder gate and dependency delivery still run, keyed on
    // the synthetic user.
    expect(checkBuilderRunGate).toHaveBeenCalledWith(synthetic, "test-agent");
    expect(runWithRunnerContext).toHaveBeenCalledTimes(1);
  });

  it("returns a gate refusal for a tombstoned catalog agent", async () => {
    vi.mocked(isAuthDisabled).mockReturnValue(true);
    const synthetic = { ...USER, id: "synthetic-admin", orgId: "solo-org" };
    vi.mocked(getSyntheticAdmin).mockResolvedValue(synthetic);
    const { checkCatalogRunGates } = await import("@/lib/plans/enforcement");
    vi.mocked(checkCatalogRunGates).mockResolvedValue(
      NextResponse.json({ error: "gated" }, { status: 410 }),
    );

    const res = await POST(new Request(RUN_URL, { method: "POST" }));

    expect(res.status).toBe(410);
    expect(checkBuilderRunGate).not.toHaveBeenCalled();
  });
});

describe("copilotkit route — run-shaped path fails closed", () => {
  beforeEach(async () => {
    // An earlier test pins a 410 implementation on this mock — reset it
    // so these tests exercise the path-classification layer only.
    const { checkCatalogRunGates } = await import("@/lib/plans/enforcement");
    vi.mocked(checkCatalogRunGates).mockResolvedValue(null);
  });

  it("404s a POST to /agent/<id>/run/<extra> before the inner handler", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent/run/extra", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
    expect(checkBuilderRunGate).not.toHaveBeenCalled();
  });

  it("sends a stray-% run path through the gates (URL sanitizes %% to %25)", async () => {
    // The WHATWG URL class normalizes an invalid "%" to "%25" at parse
    // time, so a "malformed" agent id always decodes by the time it
    // reaches the handler — no URIError, no gate skip. The request must
    // flow through the normal gate path, not die in a 404.
    await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/%25%25/run", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(checkBuilderRunGate).toHaveBeenCalledTimes(1);
  });

  it("does not 404 a well-formed run path", async () => {
    const res = await POST(
      new Request(RUN_URL, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).not.toBe(404);
  });
});

describe("copilotkit route — suggest path is gated like a run", () => {
  beforeEach(async () => {
    // The solo describe above pins isAuthDisabled→true and a 410 on the
    // catalog gate — clearAllMocks keeps implementations, so both are
    // reset here for the member-path (SaaS-mode) behavior under test.
    vi.mocked(isAuthDisabled).mockReturnValue(false);
    const { checkCatalogRunGates } = await import("@/lib/plans/enforcement");
    vi.mocked(checkCatalogRunGates).mockResolvedValue(null);
  });

  // CopilotKit's runtime exposes POST /agent/:id/suggest as a stateless
  // suggestion run that executes the provider agent DIRECTLY. Before the
  // (run|suggest) attribution, a suggest request was classified as a run
  // for rate limiting but skipped every gate (runAgentIdFromPath only
  // matched /run) — a real agent execution with no plan gate, no builder
  // gate, no credential requirements.
  it("applies the builder gate to POST /agent/<id>/suggest", async () => {
    await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent/suggest", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(checkBuilderRunGate).toHaveBeenCalledTimes(1);
    expect(checkBuilderRunGate).toHaveBeenCalledWith(USER, "test-agent");
  });

  it("returns a gate refusal for a suggest path instead of running ungated", async () => {
    vi.mocked(checkBuilderRunGate).mockResolvedValue(
      resolution({ response: NextResponse.json({ error: "gated" }, { status: 402 }) }),
    );

    const res = await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent/suggest", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(402);
  });

  it("404s a suggest path with trailing segments before the inner handler", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent/suggest/extra", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
    expect(checkBuilderRunGate).not.toHaveBeenCalled();
  });
});

describe("copilotkit route — duplicate-slash run paths normalize into the gates", () => {
  beforeEach(async () => {
    // Same leak discipline as the suggest describe above.
    vi.mocked(isAuthDisabled).mockReturnValue(false);
    const { checkCatalogRunGates } = await import("@/lib/plans/enforcement");
    vi.mocked(checkCatalogRunGates).mockResolvedValue(null);
  });

  // A `//run` path slipped past the gate regex (`[^/]+` can't match the
  // empty segment between the double slashes) while still reaching the
  // inner handler — the agent ran with every gate skipped. The handler
  // now collapses duplicate slashes before attribution.
  it("gates POST /agent/<id>//run instead of skipping attribution", async () => {
    await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent//run", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(checkBuilderRunGate).toHaveBeenCalledTimes(1);
    expect(checkBuilderRunGate).toHaveBeenCalledWith(USER, "test-agent");
  });

  it("404s a //run path with trailing segments (still fail-closed)", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent//run/extra", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
    expect(checkBuilderRunGate).not.toHaveBeenCalled();
  });
});

describe("copilotkit route — /threads/clear refusal + run-classification exemptions", () => {
  beforeEach(async () => {
    // Same leak discipline as the suggest describe above.
    vi.mocked(isAuthDisabled).mockReturnValue(false);
    const { checkCatalogRunGates } = await import("@/lib/plans/enforcement");
    vi.mocked(checkCatalogRunGates).mockResolvedValue(null);
  });

  // POST /threads/clear reaches the runner's clearThreads() — which
  // deletes EVERY tenant's runs/messages/state with no user filter. The
  // proxy route refuses it unconditionally, before auth and before any
  // rate-limit accounting. The inner handler only ever returns "ok" (200),
  // so a 403 body proves the short-circuit happened before dispatch.
  it("refuses POST /threads/clear with 403 before the inner handler", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/copilotkit/threads/clear", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not available" });
  });

  it("refuses the double-slash variant too (normalization happens before the guard)", async () => {
    // `/threads//clear` normalizes to `/threads/clear` — the guard must
    // still fire on the collapsed path, not be bypassed by the raw path
    // (the same normalization the run gates rely on).
    const res = await POST(
      new Request("http://localhost:3000/api/copilotkit/threads//clear", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not available" });
  });

  // Stopping a run at the concurrent cap must not 429: stop/connect are
  // classified as control requests, not runs — no per-minute limit, no
  // concurrent slot. (If they were misclassified, an at-cap user's stop
  // would try to acquire a 4th slot and the run would become unstoppable.)
  it("stop and connect paths skip the rate limit and the concurrent slot", async () => {
    vi.mocked(acquireConcurrent).mockReturnValue(() => {});

    const stopRes = await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent/stop/t-1", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    const connectRes = await POST(
      new Request("http://localhost:3000/api/copilotkit/agent/test-agent/connect", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );

    expect(stopRes.status).toBe(200);
    expect(connectRes.status).toBe(200);
    expect(checkUserLimit).not.toHaveBeenCalled();
    expect(acquireConcurrent).not.toHaveBeenCalled();
  });

  it("a plain run on the same URL shape still consumes the limit + slot (contrast pin)", async () => {
    vi.mocked(acquireConcurrent).mockReturnValue(() => {});

    await POST(new Request(RUN_URL, { method: "POST", body: JSON.stringify({}) }));

    expect(checkUserLimit).toHaveBeenCalledTimes(1);
    expect(acquireConcurrent).toHaveBeenCalledTimes(1);
  });
});

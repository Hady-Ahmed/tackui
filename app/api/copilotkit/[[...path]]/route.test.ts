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
  runWithRunnerContext: vi.fn(async (_u: unknown, _c: unknown, fn: () => Promise<Response>) => fn()),
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
  emptyBuilderRunResolution: vi.fn(() => ({ response: null, contextItems: [], platformKeyRun: false })),
  checkBuilderRunGate: vi.fn(),
  consumeBuilderRunQuota: vi.fn(),
}));

import { POST } from "./route";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/auth/context";
import { acquireConcurrent } from "@/lib/ratelimit/middleware";
import { checkBuilderRunGate, consumeBuilderRunQuota } from "@/lib/agents/run-gate";
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
});

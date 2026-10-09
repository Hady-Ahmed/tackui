import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the auth context — the install route gates on canManageAgents.
const mockGetCurrentUser = vi.fn();
const mockCanManageAgents = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
  canManageAgents: (...a: unknown[]) => mockCanManageAgents(...a),
}));

// Mock the rate limiter — defaults to "always allow".
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

// Mock the plan gates — defaults to "allow". The gate logic itself is
// tested in lib/plans/enforcement.test.ts.
vi.mock("@/lib/plans/enforcement", () => ({
  checkTemplateInstall: vi.fn().mockResolvedValue(null),
  checkAgentCountLimit: vi.fn().mockResolvedValue(null),
}));

import { POST } from "./route";
import {
  createTemplate,
  updateTemplate,
  getTemplate,
  listTemplates,
  deleteTemplate,
} from "@/lib/catalog/template-store";
import { listAgents, deleteAgent, getAgent } from "@/lib/agents/agent-store";
import { runMigrations } from "@/lib/db/migrate";
import { checkTemplateInstall, checkAgentCountLimit } from "@/lib/plans/enforcement";
import { NextResponse } from "next/server";

function managerUser() {
  return { id: "owner-1", role: "user", orgId: "org-1", name: "Owner", email: null };
}
function memberUser() {
  return { id: "member-1", role: "user", orgId: "org-1", name: "Member", email: null };
}

const validInput = {
  name: "Flight Finder",
  slug: "flight-finder",
  tagline: "Find cheap flights",
  description: "Searches live fares",
  endpoint: "http://localhost:8000/agent",
  authMode: "none" as const,
  sortOrder: 0,
  isActive: true,
};

async function cleanup() {
  for (const a of await listAgents("org-1", { bypassOrgScope: true })) {
    await deleteAgent(a.id, "org-1", { bypassOrgScope: true });
  }
  for (const t of await listTemplates({ activeOnly: false })) await deleteTemplate(t.id);
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations();
  await cleanup();
  mockGetCurrentUser.mockImplementation(async () => managerUser());
  mockCanManageAgents.mockResolvedValue(true);
  vi.mocked(checkTemplateInstall).mockResolvedValue(null);
  vi.mocked(checkAgentCountLimit).mockResolvedValue(null);
});

describe("POST /api/catalog/[id]/install", () => {
  it("installs a template into the caller's org (201)", async () => {
    const tpl = await createTemplate(validInput);
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.installed).toBe(true);
    expect(data.agent.sourceTemplateId).toBe(tpl.id);
    expect(data.agent.name).toBe("Flight Finder");
    expect("jwtSecret" in data.agent).toBe(false);
    expect(data.template.slug).toBe("flight-finder");
    // The installed agent is a real org agent — the runtime picks it up.
    const agents = await listAgents("org-1");
    expect(agents).toHaveLength(1);
    expect(agents[0].sourceTemplateId).toBe(tpl.id);
  });

  it("copies the jwt secret (encrypted at rest) + scopes", async () => {
    const tpl = await createTemplate({
      ...validInput,
      authMode: "jwt",
      jwtSecret: "s".repeat(32),
      jwtScopes: ["agents:run"],
    });
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    const data = await res.json();
    expect(data.agent.authMode).toBe("jwt");
    expect(data.agent.hasJwtSecret).toBe(true);
    const stored = await getAgent(data.agent.id, "org-1");
    expect(stored?.jwtSecret).toBe("s".repeat(32));
    expect(stored?.jwtScopes).toEqual(["agents:run"]);
  });

  it("is idempotent: re-install re-syncs the SAME agent (200, id preserved)", async () => {
    const tpl = await createTemplate(validInput);
    const first = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    const originalId = (await first.json()).agent.id;

    await updateTemplate(tpl.id, { endpoint: "http://localhost:9000/agent" });
    const updated = await getTemplate(tpl.id);

    const second = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    expect(second.status).toBe(200);
    const data = await second.json();
    expect(data.installed).toBe(false);
    expect(data.updated).toBe(true);
    expect(data.agent.id).toBe(originalId);
    // The public shape strips endpoint for managed agents — verify the
    // live config through the store instead.
    const { getAgent } = await import("@/lib/agents/agent-store");
    const stored = await getAgent(originalId, "org-1");
    expect(stored?.endpoint).toBe("http://localhost:9000/agent");
    expect(await listAgents("org-1")).toHaveLength(1);
    void updated;
  });

  it("returns 404 for a missing template", async () => {
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for a deactivated template", async () => {
    const tpl = await createTemplate({ ...validInput, isActive: false });
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    expect(res.status).toBe(400);
  });

  it("returns 403 for members without agent-management rights", async () => {
    mockGetCurrentUser.mockImplementation(async () => memberUser());
    mockCanManageAgents.mockResolvedValue(false);
    const tpl = await createTemplate(validInput);
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    expect(res.status).toBe(403);
    expect(await listAgents("org-1")).toHaveLength(0);
  });

  it("passes through the plan gate 402 (PLAN_AGENT_LOCKED)", async () => {
    vi.mocked(checkTemplateInstall).mockResolvedValueOnce(
      NextResponse.json(
        { error: "Requires pro", code: "PLAN_AGENT_LOCKED" },
        { status: 402 },
      ),
    );
    const tpl = await createTemplate(validInput);
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("PLAN_AGENT_LOCKED");
    expect(await listAgents("org-1")).toHaveLength(0);
  });

  it("passes through the agent-count cap 402 (PLAN_AGENT_LIMIT) on new installs", async () => {
    vi.mocked(checkAgentCountLimit).mockResolvedValueOnce(
      NextResponse.json(
        { error: "Agent cap reached", code: "PLAN_AGENT_LIMIT" },
        { status: 402 },
      ),
    );
    const tpl = await createTemplate(validInput);
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    expect(res.status).toBe(402);
    expect(await listAgents("org-1")).toHaveLength(0);
  });

  it("skips the agent-count cap on the re-sync path (no new row)", async () => {
    const tpl = await createTemplate(validInput);
    await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    vi.mocked(checkAgentCountLimit).mockResolvedValueOnce(
      NextResponse.json({ error: "cap", code: "PLAN_AGENT_LIMIT" }, { status: 402 }),
    );
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    // Re-sync succeeds even though the mocked cap "would" reject.
    expect(res.status).toBe(200);
    // The cap fired exactly once — on the FIRST (new-install) POST — and
    // was skipped on this re-sync (no new agent row).
    expect(vi.mocked(checkAgentCountLimit)).toHaveBeenCalledTimes(1);
  });

  it("still applies the plan gate on the re-sync path (downgraded org)", async () => {
    const tpl = await createTemplate(validInput);
    await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    vi.mocked(checkTemplateInstall).mockResolvedValueOnce(
      NextResponse.json({ error: "locked", code: "PLAN_AGENT_LOCKED" }, { status: 402 }),
    );
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), ctx(tpl.id));
    expect(res.status).toBe(402);
  });
});

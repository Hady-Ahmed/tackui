import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the auth context (platform-admin gate + rate limiter bypass).
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

vi.mock("@/lib/net/safe-fetch", () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  UnsafeUrlError: class UnsafeUrlError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
      this.name = "UnsafeUrlError";
    }
  },
}));

vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

import { GET, PATCH, DELETE } from "./route";
import {
  createTemplate,
  updateTemplate,
  getTemplate,
  listTemplates,
  deleteTemplate,
  installTemplate,
} from "@/lib/catalog/template-store";
import { runMigrations } from "@/lib/db/migrate";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";

function adminUser() {
  return { id: "admin-1", role: "admin", orgId: "org-1", name: "Admin", email: null };
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
  for (const t of await listTemplates({ activeOnly: false })) await deleteTemplate(t.id);
  await query(`DELETE FROM agents`);
}

// Small subset of pg access for cleanup (template-store owns the rest).
import { query } from "@/lib/db/pg";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations();
  await cleanup();
  mockGetCurrentUser.mockImplementation(async () => adminUser());
  vi.mocked(assertSafeUrl).mockResolvedValue(undefined);
});

describe("GET /api/catalog/[id]", () => {
  it("returns the template + installCount for platform admins", async () => {
    const tpl = await createTemplate(validInput);
    await installTemplate(tpl, "org-1");
    await installTemplate(tpl, "org-2");
    const res = await GET(new Request("http://localhost/api/catalog/x"), ctx(tpl.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.slug).toBe("flight-finder");
    expect(data.installCount).toBe(2);
    expect("jwtSecret" in data).toBe(false);
  });

  it("returns 404 for a missing template", async () => {
    const res = await GET(new Request("http://localhost/api/catalog/x"), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-platform-admins", async () => {
    mockGetCurrentUser.mockImplementation(async () => memberUser());
    const tpl = await createTemplate(validInput);
    const res = await GET(new Request("http://localhost/api/catalog/x"), ctx(tpl.id));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/catalog/[id]", () => {
  it("updates fields and returns the public shape", async () => {
    const tpl = await createTemplate(validInput);
    const res = await PATCH(
      new Request("http://localhost/api/catalog/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed", isActive: false }),
      }),
      ctx(tpl.id),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Renamed");
    expect(data.isActive).toBe(false);
  });

  it("returns 404 for a missing template", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/catalog/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      ctx("missing"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-platform-admins", async () => {
    mockGetCurrentUser.mockImplementation(async () => memberUser());
    const tpl = await createTemplate(validInput);
    const res = await PATCH(
      new Request("http://localhost/api/catalog/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      ctx(tpl.id),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for validation failures", async () => {
    const tpl = await createTemplate(validInput);
    const res = await PATCH(
      new Request("http://localhost/api/catalog/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "Invalid Slug!" }),
      }),
      ctx(tpl.id),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when SSRF guard rejects a changed endpoint", async () => {
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new UnsafeUrlError("private address"),
    );
    const tpl = await createTemplate(validInput);
    const res = await PATCH(
      new Request("http://localhost/api/catalog/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://169.254.169.254/" }),
      }),
      ctx(tpl.id),
    );
    expect(res.status).toBe(400);
  });

  it("does not trigger the SSRF guard when the endpoint is not in the body", async () => {
    const tpl = await createTemplate(validInput);
    await PATCH(
      new Request("http://localhost/api/catalog/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
      ctx(tpl.id),
    );
    expect(assertSafeUrl).not.toHaveBeenCalled();
  });

  it("returns 409 when the slug collides", async () => {
    await createTemplate(validInput);
    const other = await createTemplate({ ...validInput, slug: "other-one" });
    const res = await PATCH(
      new Request("http://localhost/api/catalog/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "flight-finder" }),
      }),
      ctx(other.id),
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/catalog/[id]", () => {
  it("deletes the template (204) and tombstones installed copies", async () => {
    const tpl = await createTemplate(validInput);
    const { agent } = await installTemplate(tpl, "org-1");
    const res = await DELETE(new Request("http://localhost/api/catalog/x", { method: "DELETE" }), ctx(tpl.id));
    expect(res.status).toBe(204);
    expect(await getTemplate(tpl.id)).toBeNull();
    // The installed copy survives as a tombstone — listed for history
    // browsing, never runnable again.
    const installed = await query<{ id: string; template_deleted_at: Date | string | null }>(
      `SELECT id, template_deleted_at FROM agents WHERE source_template_id = $1`,
      [tpl.id],
    );
    expect(installed.rows).toHaveLength(1);
    expect(installed.rows[0].id).toBe(agent.id);
    expect(installed.rows[0].template_deleted_at).toBeTruthy();
  });

  it("returns 404 for a missing template", async () => {
    const res = await DELETE(new Request("http://localhost/api/catalog/x", { method: "DELETE" }), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-platform-admins", async () => {
    mockGetCurrentUser.mockImplementation(async () => memberUser());
    const tpl = await createTemplate(validInput);
    const res = await DELETE(new Request("http://localhost/api/catalog/x", { method: "DELETE" }), ctx(tpl.id));
    expect(res.status).toBe(403);
    expect(await getTemplate(tpl.id)).not.toBeNull();
  });
});

// updateTemplate is exercised above indirectly; direct import keeps the
// linter honest about the store surface used.
void updateTemplate;

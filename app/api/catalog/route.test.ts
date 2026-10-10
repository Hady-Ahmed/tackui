import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the auth context so tests can vary the caller (platform admin vs
// regular member). Solo-mode defaults would make every caller an admin.
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/context", () => ({
  getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

// Mock the SSRF guard so route tests focus on route logic.
vi.mock("@/lib/net/safe-fetch", () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  UnsafeUrlError: class UnsafeUrlError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
      this.name = "UnsafeUrlError";
    }
  },
}));

// Mock the rate limiter — defaults to "always allow".
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

import { GET, POST } from "./route";
import { listTemplates, deleteTemplate } from "@/lib/catalog/template-store";
import { runMigrations } from "@/lib/db/migrate";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/net/safe-fetch";
import { checkUserLimit } from "@/lib/ratelimit/middleware";
import { NextResponse } from "next/server";

function adminUser() {
  return { id: "admin-1", role: "admin", orgId: "org-1", name: "Admin", email: null };
}
function memberUser() {
  return { id: "member-1", role: "user", orgId: "org-1", name: "Member", email: null };
}

const validBody = {
  name: "Flight Finder",
  slug: "flight-finder",
  tagline: "Find cheap flights",
  description: "Searches live fares",
  endpoint: "http://localhost:8000/agent",
};

async function cleanup() {
  for (const t of await listTemplates({ activeOnly: false })) await deleteTemplate(t.id);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations();
  await cleanup();
  mockGetCurrentUser.mockImplementation(async () => adminUser());
  vi.mocked(assertSafeUrl).mockResolvedValue(undefined);
});

function post(body: unknown, ok = true) {
  return new Request("http://localhost/api/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(ok ? {} : {}),
  });
}

describe("GET /api/catalog", () => {
  it("returns 200 with active templates for signed-in users", async () => {
    const res = await GET(new Request("http://localhost/api/catalog"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("hides deactivated templates by default; ?all=1 includes them for admins", async () => {
    await POST(post({ ...validBody, slug: "active-one" }));
    await POST(post({ ...validBody, slug: "inactive-one", isActive: false }));
    const pub = await GET(new Request("http://localhost/api/catalog"));
    expect((await pub.json())).toHaveLength(1);
    const all = await GET(new Request("http://localhost/api/catalog?all=1"));
    expect(await all.json()).toHaveLength(2);
  });

  it("?all=1 behaves like the default for non-admins", async () => {
    await POST(post({ ...validBody, slug: "active-one" }));
    await POST(post({ ...validBody, slug: "inactive-one", isActive: false }));
    // Only the GET runs as a non-admin — POSTs above ran as the admin.
    mockGetCurrentUser.mockImplementation(async () => memberUser());
    const res = await GET(new Request("http://localhost/api/catalog?all=1"));
    expect(await res.json()).toHaveLength(1);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await GET(new Request("http://localhost/api/catalog"));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/catalog", () => {
  it("creates a template (201) with a server-generated id", async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toMatch(/^[0-9a-f]{12}$/);
    expect(data.slug).toBe("flight-finder");
    expect("jwtSecret" in data).toBe(false);
  });

  it("returns 403 for non-platform-admins", async () => {
    mockGetCurrentUser.mockImplementation(async () => memberUser());
    const res = await POST(post(validBody));
    expect(res.status).toBe(403);
  });

  it("returns 400 for validation failures (bad slug)", async () => {
    const res = await POST(post({ ...validBody, slug: "Bad Slug!" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Validation");
  });

  it("returns 400 for a missing/empty tagline or description", async () => {
    const res = await POST(post({ ...validBody, tagline: "", description: "" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Validation");
    expect(data.details.fieldErrors).toHaveProperty("tagline");
    expect(data.details.fieldErrors).toHaveProperty("description");
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when SSRF guard rejects the endpoint", async () => {
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new UnsafeUrlError("hostname resolves to a private address"),
    );
    const res = await POST(post({ ...validBody, endpoint: "http://169.254.169.254/" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("private or internal address");
    const list = await GET(new Request("http://localhost/api/catalog?all=1"));
    expect(await list.json()).toHaveLength(0);
  });

  it("returns 409 when the slug already exists", async () => {
    await POST(post(validBody));
    const res = await POST(post(validBody));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("flight-finder");
  });

  it("returns 402-shaped rejection surface only via plan gates (no plan gate here)", async () => {
    // This route has no plan logic — a sanity check that POST of a
    // pro-gated template succeeds (the gate applies at INSTALL time).
    const res = await POST(post({ ...validBody, requiredPlan: "pro" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.requiredPlan).toBe("pro");
  });
});

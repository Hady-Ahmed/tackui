import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";

// Mock the rate limiter — defaults to "always allow".
vi.mock("@/lib/ratelimit/middleware", () => ({
  checkUserLimit: vi.fn().mockReturnValue(null),
}));

import { GET } from "./route";
import { checkUserLimit } from "@/lib/ratelimit/middleware";

describe("GET /api/auth/can-manage-agents", () => {
  it("returns canManage: true in solo mode (synthetic admin is platform admin)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.canManage).toBe(true);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkUserLimit).mockReturnValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
    );
    const res = await GET();
    expect(res.status).toBe(429);
  });
});

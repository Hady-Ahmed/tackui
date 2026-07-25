import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/auth/can-manage-agents", () => {
  it("returns canManage: true in solo mode (synthetic admin is platform admin)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.canManage).toBe(true);
  });
});

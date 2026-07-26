import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the runner singleton so we don't need real PG state.
vi.mock("@/lib/agents/runner-instance", () => ({
  runner: {
    renameThread: vi.fn(),
    deleteThread: vi.fn(),
  },
}));

import { PATCH, DELETE } from "./route";
import { runner } from "@/lib/agents/runner-instance";

const mockedRename = vi.mocked(runner.renameThread);
const mockedDelete = vi.mocked(runner.deleteThread);

function makePatchRequest(id: string, body: unknown) {
  return [
    new Request(`http://localhost/api/threads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

function makeDeleteRequest(id: string) {
  return [
    new Request(`http://localhost/api/threads/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/threads/[id]", () => {
  it("returns 200 when rename succeeds", async () => {
    mockedRename.mockResolvedValue(true);
    const [req, ctx] = makePatchRequest("t1", { title: "New title" });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockedRename).toHaveBeenCalledWith("t1", "New title", expect.any(String), expect.any(String));
  });

  it("returns 404 when thread does not exist", async () => {
    mockedRename.mockResolvedValue(false);
    const [req, ctx] = makePatchRequest("missing", { title: "New" });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("returns 400 for empty title", async () => {
    const [req, ctx] = makePatchRequest("t1", { title: "" });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(400);
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it("returns 400 for title exceeding 200 chars", async () => {
    const [req, ctx] = makePatchRequest("t1", { title: "x".repeat(201) });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(400);
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const [req, ctx] = [
      new Request("http://localhost/api/threads/t1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    ] as const;
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when title is missing from body", async () => {
    const [req, ctx] = makePatchRequest("t1", { notTitle: "foo" });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(400);
    expect(mockedRename).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/threads/[id]", () => {
  it("returns 204 when delete succeeds", async () => {
    mockedDelete.mockResolvedValue(true);
    const [req, ctx] = makeDeleteRequest("t1");
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(204);
    expect(mockedDelete).toHaveBeenCalledWith("t1", expect.any(String), expect.any(String));
  });

  it("returns 404 when thread does not exist", async () => {
    mockedDelete.mockResolvedValue(false);
    const [req, ctx] = makeDeleteRequest("missing");
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });
});

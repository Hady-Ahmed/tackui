import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the transport only — AgentosError stays real so the 404-swallowing
// contract is tested against the actual error class, not a stand-in.
const mockAgentosRequest = vi.fn();
vi.mock("@/lib/agents/builder", () => ({
  AgentosError: class AgentosError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  agentosRequest: (...a: unknown[]) => mockAgentosRequest(...a),
}));

import {
  upsertPlatformConnector,
  deletePlatformConnector,
  ensurePlatformConnectors,
} from "./platform-sync";
import { AgentosError } from "@/lib/agents/builder";

beforeEach(() => {
  mockAgentosRequest.mockReset();
  mockAgentosRequest.mockResolvedValue(undefined);
});

describe("upsertPlatformConnector", () => {
  it("PUTs the endpoint under the connector's ID with url + label", async () => {
    await upsertPlatformConnector({ id: "abc123", url: "https://mcp.example.com/sse", name: "GitHub" });
    expect(mockAgentosRequest).toHaveBeenCalledTimes(1);
    const [method, path, body] = mockAgentosRequest.mock.calls[0];
    expect(method).toBe("PUT");
    expect(path).toBe("/platform/connectors/abc123");
    expect(body).toEqual({ url: "https://mcp.example.com/sse", label: "GitHub" });
  });

  it("URL-encodes the id path segment (ids are server-generated hex, but the encoding is load-bearing)", async () => {
    await upsertPlatformConnector({ id: "a/b c", url: "https://x.example.com", name: "X" });
    expect(mockAgentosRequest.mock.calls[0][1]).toBe("/platform/connectors/a%2Fb%20c");
  });

  it("propagates transport failures (push-first-then-commit: a failed push must change nothing locally)", async () => {
    mockAgentosRequest.mockRejectedValue(new AgentosError(503, "platform unreachable"));
    await expect(
      upsertPlatformConnector({ id: "abc", url: "https://x", name: "X" }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("deletePlatformConnector", () => {
  it("DELETEs the connector's registry entry", async () => {
    await deletePlatformConnector("abc123");
    expect(mockAgentosRequest).toHaveBeenCalledWith("DELETE", "/platform/connectors/abc123");
  });

  it("treats a 404 as success (the delete IS the state — never-synced or already-removed entries are done)", async () => {
    mockAgentosRequest.mockRejectedValue(new AgentosError(404, "not found"));
    await expect(deletePlatformConnector("abc123")).resolves.toBeUndefined();
  });

  it("rethrows every other AgentosError (a failed registry delete must block the local delete)", async () => {
    mockAgentosRequest.mockRejectedValue(new AgentosError(502, "bad gateway"));
    await expect(deletePlatformConnector("abc123")).rejects.toMatchObject({ status: 502 });
  });

  it("rethrows non-Agentos errors", async () => {
    mockAgentosRequest.mockRejectedValue(new TypeError("network died"));
    await expect(deletePlatformConnector("abc123")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("ensurePlatformConnectors", () => {
  it("registers every connector of an agent save (belt-and-braces over push-first edits)", async () => {
    await ensurePlatformConnectors([
      { id: "c1", url: "https://one.example.com", name: "One" },
      { id: "c2", url: "https://two.example.com", name: "Two" },
    ]);
    expect(mockAgentosRequest).toHaveBeenCalledTimes(2);
    expect(mockAgentosRequest.mock.calls.map((c) => c[1])).toEqual([
      "/platform/connectors/c1",
      "/platform/connectors/c2",
    ]);
  });

  it("accepts an empty list (no connectors → no platform calls)", async () => {
    await ensurePlatformConnectors([]);
    expect(mockAgentosRequest).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import type { AgentEntry } from "./agents.config";
import type { RequestUser, RunContextItem } from "@/lib/auth/request-context";

// vi.mock factories are hoisted above all other code, so any values
// they close over must be declared via vi.hoisted (also hoisted).
const { testUser } = vi.hoisted(() => ({
  testUser: {
    id: "u-123",
    role: "user",
    name: "Test User",
    email: "test@example.com",
    orgId: "org-1",
  } as RequestUser,
}));

// Mock getRequestUser so we don't depend on the session/DB layer.
vi.mock("@/lib/auth/context", () => ({
  getRequestUser: vi.fn().mockResolvedValue(testUser),
}));

// Mock the run stash so context-injection tests can control what the
// copilotkit route stashed. Empty by default (no run scope).
const { getRunContextItems, getReservedDepKeys } = vi.hoisted(() => ({
  getRunContextItems: vi.fn(() => [] as RunContextItem[]),
  getReservedDepKeys: vi.fn(() => [] as string[]),
}));
vi.mock("@/lib/auth/request-context", () => ({
  getRunContextItems: () => getRunContextItems(),
  getReservedDepKeys: () => getReservedDepKeys(),
}));

// Mock listAgents so we don't touch the DB. We control entries per-test
// via the mock's return value.
vi.mock("./agent-store", () => ({
  listAgents: vi.fn(),
}));

// The SSRF guard does real DNS lookups; test endpoints are fake hostnames
// that would fail the fail-closed resolver. The guard has its own
// dedicated suite (lib/net/safe-fetch.test.ts) — here it's a no-op by
// default (so listing tests don't depend on DNS) and the redirect-guarded
// fetch passes through to global fetch. The listing test below overrides
// assertSafeUrl to simulate a guard failure.
vi.mock("@/lib/net/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/net/safe-fetch")>();
  return {
    ...actual,
    assertSafeUrl: vi.fn().mockResolvedValue(undefined),
    fetchGuardedRedirects: vi.fn((url: string, init: RequestInit) => fetch(url, init)),
  };
});

import { getAgents } from "./registry";
import { listAgents } from "./agent-store";
import { getRequestUser } from "@/lib/auth/context";
import { assertSafeUrl } from "@/lib/net/safe-fetch";

const aguiEntry = (overrides: Partial<AgentEntry> = {}): AgentEntry => ({
  id: "ag1",
  name: "Agno Agent",
  description: "test agui agent",
  endpoint: "http://localhost:8001/agent",
  orgId: "org-1",
  authMode: "none",
  ...overrides,
});

beforeEach(() => {
  vi.mocked(listAgents).mockReset();
  vi.mocked(getRequestUser).mockReset();
  vi.mocked(getRequestUser).mockResolvedValue(testUser);
  getRunContextItems.mockReset();
  getRunContextItems.mockReturnValue([]);
  getReservedDepKeys.mockReset();
  getReservedDepKeys.mockReturnValue([]);
});

// Drive the injected middleware (the last entry in the agent's private
// middlewares array) with a stub `next` that captures the input.
function injectedMiddleware(agent: unknown) {
  const middlewares = (agent as unknown as {
    middlewares: {
      run: (
        input: unknown,
        next: { run: (i: unknown) => unknown },
      ) => unknown;
    }[];
  }).middlewares;
  expect(middlewares.length).toBeGreaterThan(0);
  return middlewares[middlewares.length - 1];
}

function runMiddleware(
  middleware: ReturnType<typeof injectedMiddleware>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const captured: Record<string, unknown> = {};
  middleware.run(input, {
    run: (i: unknown) => {
      Object.assign(captured, i);
      return { subscribe: () => {} }; // minimal fake observable
    },
  } as never);
  return captured;
}

describe("getAgents", () => {
  it("builds a map keyed by agent id for agui entries", async () => {
    vi.mocked(listAgents).mockResolvedValue([
      aguiEntry({ id: "a1" }),
      aguiEntry({ id: "a2" }),
    ]);
    const map = await getAgents(new Request("http://localhost"));
    expect(Object.keys(map).sort()).toEqual(["a1", "a2"]);
  });

  it("lists an agent whose endpoint fails the SSRF guard (enforcement is at fetch time, not listing)", async () => {
    // The registry deliberately does NOT re-run the guard at listing. A
    // dead endpoint (expired tunnel, transient DNS failure) must fail THAT
    // run — via the guarded fetch, which re-runs the guard per hop — not
    // vanish from the runtime's agent list. The old per-listing check
    // removed the agent from /info, and CopilotKit's useAgent crashed the
    // whole chat page with "Agent not found after runtime sync".
    vi.mocked(assertSafeUrl).mockRejectedValue(
      new Error("hostname could not be resolved"),
    );
    vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "dead-dns" })]);
    const map = await getAgents(new Request("http://localhost"));
    expect(Object.keys(map)).toEqual(["dead-dns"]);
  });

  it("throws the no-agents copy when the org has zero agents", async () => {
    vi.mocked(listAgents).mockResolvedValue([]);
    await expect(getAgents(new Request("http://localhost"))).rejects.toThrow(
      /No agents are set up in this workspace yet/,
    );
  });

  it("throws 'not authenticated' when getRequestUser returns null", async () => {
    vi.mocked(getRequestUser).mockResolvedValue(null);
    vi.mocked(listAgents).mockResolvedValue([aguiEntry()]);
    await expect(getAgents(new Request("http://localhost"))).rejects.toThrow(
      /not authenticated/,
    );
  });

  it("injects forwardedProps.user_id for agui agents", async () => {
    vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
    const map = await getAgents(new Request("http://localhost"));
    const agent = map["ag1"];

    // The injected FunctionMiddleware is the last entry in the agent's
    // private middlewares array (after the SDK's backward-compat
    // middlewares). Drive it with a stub `next` that captures the input.
    const middlewares = (agent as unknown as {
      middlewares: { run: (input: unknown, next: { run: (i: unknown) => unknown }) => unknown }[];
    }).middlewares;
    expect(middlewares.length).toBeGreaterThan(0);
    const injected = middlewares[middlewares.length - 1];

    const captured: { forwardedProps?: Record<string, unknown> } = {};
    const stubNext = {
      run: (input: typeof captured) => {
        Object.assign(captured, input);
        return { subscribe: () => {} }; // minimal fake observable
      },
    };

    injected.run(
      {
        threadId: "t1",
        runId: "r1",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { existing: "keep" },
      },
      stubNext as never,
    );

    expect(captured.forwardedProps).toBeDefined();
    expect(captured.forwardedProps?.user_id).toBe("u-123");
    // Existing client-supplied forwardedProps are preserved, not overwritten.
    expect(captured.forwardedProps?.existing).toBe("keep");
  });

  it("each agui agent gets its own middleware with the resolved user id", async () => {
    vi.mocked(listAgents).mockResolvedValue([
      aguiEntry({ id: "a1" }),
      aguiEntry({ id: "a2" }),
    ]);
    const map = await getAgents(new Request("http://localhost"));

    for (const id of ["a1", "a2"]) {
      const agent = map[id];
      const middlewares = (agent as unknown as {
        middlewares: { run: (input: unknown, next: { run: (i: unknown) => unknown }) => unknown }[];
      }).middlewares;
      const injected = middlewares[middlewares.length - 1];
      const captured: { forwardedProps?: Record<string, unknown> } = {};
      injected.run(
        {
          threadId: "t1",
          runId: "r1",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        {
          run: (input: typeof captured) => {
            Object.assign(captured, input);
            return { subscribe: () => {} };
          },
        } as never,
      );
      expect(captured.forwardedProps?.user_id).toBe("u-123");
    }
  });

  describe("JWT auth (authMode: 'jwt')", () => {
    const TEST_SECRET = "test-secret-at-least-32-chars-long!!";

    it("sets Authorization: Bearer header on the HttpAgent when authMode is jwt", async () => {
      vi.mocked(listAgents).mockResolvedValue([
        aguiEntry({ id: "ag1", authMode: "jwt", jwtSecret: TEST_SECRET }),
      ]);
      const map = await getAgents(new Request("http://localhost"));
      const agent = map["ag1"];

      // HttpAgent stores headers passed to its constructor.
      const headers = (agent as unknown as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toMatch(/^Bearer .+\..+\..+$/);
    });

    it("mints a JWT with sub = user.id and ~1h exp", async () => {
      vi.mocked(listAgents).mockResolvedValue([
        aguiEntry({ id: "ag1", authMode: "jwt", jwtSecret: TEST_SECRET }),
      ]);
      const map = await getAgents(new Request("http://localhost"));
      const agent = map["ag1"];

      const headers = (agent as unknown as { headers: Record<string, string> }).headers;
      const token = headers.Authorization.replace("Bearer ", "");
      const decoded = jwt.verify(token, TEST_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;

      expect(decoded.sub).toBe("u-123");
      expect(decoded.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // exp should be ~1h (3600s) after iat
      expect(decoded.exp! - decoded.iat!).toBe(3600);
      // No scopes or aud claim when jwtScopes is not configured
      expect(decoded.scopes).toBeUndefined();
      expect(decoded.aud).toBeUndefined();
    });

    it("includes scopes claim in the JWT when jwtScopes is configured", async () => {
      vi.mocked(listAgents).mockResolvedValue([
        aguiEntry({
          id: "ag1",
          authMode: "jwt",
          jwtSecret: TEST_SECRET,
          jwtScopes: ["agents:run", "app:superadmin"],
        }),
      ]);
      const map = await getAgents(new Request("http://localhost"));
      const agent = map["ag1"];

      const headers = (agent as unknown as { headers: Record<string, string> }).headers;
      const token = headers.Authorization.replace("Bearer ", "");
      const decoded = jwt.verify(token, TEST_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;

      expect(decoded.sub).toBe("u-123");
      expect(decoded.scopes).toEqual(["agents:run", "app:superadmin"]);
    });

    it("does NOT set Authorization header when authMode is none", async () => {
      vi.mocked(listAgents).mockResolvedValue([
        aguiEntry({ id: "ag1", authMode: "none" }),
      ]);
      const map = await getAgents(new Request("http://localhost"));
      const agent = map["ag1"];
      const headers = (agent as unknown as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBeUndefined();
    });

    it("still injects forwardedProps.user_id even when JWT auth is enabled", async () => {
      vi.mocked(listAgents).mockResolvedValue([
        aguiEntry({ id: "ag1", authMode: "jwt", jwtSecret: TEST_SECRET }),
      ]);
      const map = await getAgents(new Request("http://localhost"));
      const agent = map["ag1"];

      const middlewares = (agent as unknown as {
        middlewares: { run: (input: unknown, next: { run: (i: unknown) => unknown }) => unknown }[];
      }).middlewares;
      const injected = middlewares[middlewares.length - 1];

      const captured: { forwardedProps?: Record<string, unknown> } = {};
      injected.run(
        {
          threadId: "t1",
          runId: "r1",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        {
          run: (input: typeof captured) => {
            Object.assign(captured, input);
            return { subscribe: () => {} };
          },
        } as never,
      );
      expect(captured.forwardedProps?.user_id).toBe("u-123");
    });
  });

  describe("context credential namespace (server-authoritative)", () => {
    const baseInput = {
      threadId: "t1",
      runId: "r1",
      messages: [],
      tools: [],
      state: {},
      forwardedProps: {},
    };

    it("strips client-sent reserved dep keys (mcp_connectors, *_api_key) but keeps non-reserved context", async () => {
      vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
      const map = await getAgents(new Request("http://localhost"));
      const captured = runMiddleware(
        injectedMiddleware(map["ag1"]),
        {
          ...baseInput,
          context: [
            { description: "mcp_connectors", value: '{"probe":{"url":"http://169.254.169.254/"}}' },
            { description: "openai_api_key", value: "sk-forged" },
            { description: "tavily_api_key", value: "tvly-forged" },
            { description: "user_notes", value: "arbitrary display context" },
          ],
        },
      );
      const context = captured.context as Array<{ description: string }>;
      expect(context.map((c) => c.description)).toEqual(["user_notes"]);
    });

    it("strips reserved keys even when there is no stash (empty run scope)", async () => {
      vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
      const map = await getAgents(new Request("http://localhost"));
      const captured = runMiddleware(
        injectedMiddleware(map["ag1"]),
        {
          ...baseInput,
          context: [
            { description: "mcp_connectors", value: '{"x":{"url":"http://internal:8080"}}' },
          ],
        },
      );
      expect(captured.context).toEqual([]);
    });

    it("appends stashed run dependencies after filtered client context", async () => {
      getRunContextItems.mockReturnValue([
        { description: "tavily_api_key", value: "tvly-real" },
        { description: "mcp_connectors", value: '{"github":{"url":"https://mcp.github.com","token":"t"}}' },
      ]);
      vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
      const map = await getAgents(new Request("http://localhost"));
      const captured = runMiddleware(
        injectedMiddleware(map["ag1"]),
        {
          ...baseInput,
          context: [
            { description: "user_notes", value: "keep me" },
            { description: "mcp_connectors", value: '{"attacker":{"url":"http://169.254.169.254"}}' },
          ],
        },
      );
      const context = captured.context as Array<{ description: string; value: string }>;
      // Client item stripped; stash items appended (stash wins collisions).
      expect(context.map((c) => c.description)).toEqual([
        "user_notes",
        "tavily_api_key",
        "mcp_connectors",
      ]);
      expect(context[2].value).toBe(
        '{"github":{"url":"https://mcp.github.com","token":"t"}}',
      );
    });

    it("stash wins on a dep-key collision with a client item of a non-reserved shape", async () => {
      // An unfiltered client item and a stash item share a description:
      // the server-resolved stash must come last (dispatcher uses last-wins).
      getRunContextItems.mockReturnValue([
        { description: "custom_dep", value: "server-resolved" },
      ]);
      vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
      const map = await getAgents(new Request("http://localhost"));
      const captured = runMiddleware(
        injectedMiddleware(map["ag1"]),
        {
          ...baseInput,
          context: [{ description: "custom_dep", value: "client-supplied" }],
        },
      );
      const context = captured.context as Array<{ description: string; value: string }>;
      expect(context).toEqual([
        { description: "custom_dep", value: "client-supplied" },
        { description: "custom_dep", value: "server-resolved" },
      ]);
    });

    it("strips multi-field contract dep keys from the gate's reserved set (stash-scoped)", async () => {
      // Multi-field credential contracts (x_consumer_key, x_access_token…)
      // don't match the mechanical `_api_key` regex — inside a builder-run
      // scope the registry must strip exactly what the gate reserved, so a
      // client can't forge a server-owned dependency.
      getReservedDepKeys.mockReturnValue(["x_consumer_key", "x_access_token"]);
      vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
      const map = await getAgents(new Request("http://localhost"));
      const captured = runMiddleware(
        injectedMiddleware(map["ag1"]),
        {
          ...baseInput,
          context: [
            { description: "x_consumer_key", value: "forged" },
            { description: "X_ACCESS_TOKEN", value: "forged" },
            { description: "user_notes", value: "keep me" },
          ],
        },
      );
      const context = captured.context as Array<{ description: string }>;
      expect(context.map((c) => c.description)).toEqual(["user_notes"]);
    });

    it("does NOT strip multi-field contract dep keys outside a run scope (regex-only)", async () => {
      // Outside a gated run there is no reserved set — only the mechanical
      // `_api_key` regex applies, and arbitrary context still flows.
      vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
      const map = await getAgents(new Request("http://localhost"));
      const captured = runMiddleware(
        injectedMiddleware(map["ag1"]),
        {
          ...baseInput,
          context: [{ description: "x_consumer_key", value: "client-supplied" }],
        },
      );
      expect(captured.context).toEqual([
        { description: "x_consumer_key", value: "client-supplied" },
      ]);
    });

    it("handles a null client context (AG-UI optional field)", async () => {
      vi.mocked(listAgents).mockResolvedValue([aguiEntry({ id: "ag1" })]);
      const map = await getAgents(new Request("http://localhost"));
      const captured = runMiddleware(injectedMiddleware(map["ag1"]), {
        ...baseInput,
        context: null,
      });
      expect(captured.context).toEqual([]);
    });
  });
});

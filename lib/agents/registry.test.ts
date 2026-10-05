import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import type { AgentEntry } from "./agents.config";
import type { RequestUser } from "@/lib/auth/request-context";

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

// Mock listAgents so we don't touch the DB. We control entries per-test
// via the mock's return value.
vi.mock("./agent-store", () => ({
  listAgents: vi.fn(),
}));

import { getAgents } from "./registry";
import { listAgents } from "./agent-store";
import { getRequestUser } from "@/lib/auth/context";

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
});

describe("getAgents", () => {
  it("builds a map keyed by agent id for agui entries", async () => {
    vi.mocked(listAgents).mockResolvedValue([
      aguiEntry({ id: "a1" }),
      aguiEntry({ id: "a2" }),
    ]);
    const map = await getAgents(new Request("http://localhost"));
    expect(Object.keys(map).sort()).toEqual(["a1", "a2"]);
  });

  it("throws 'No agents configured' when the org has zero agents", async () => {
    vi.mocked(listAgents).mockResolvedValue([]);
    await expect(getAgents(new Request("http://localhost"))).rejects.toThrow(
      /No agents configured/,
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
});

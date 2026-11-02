/**
 * agentosRequest error-discipline tests — the boundary that keeps internal
 * platform framing out of user-facing copy.
 *
 * The contract: AgentosError.message is always end-user-safe (no
 * "AgentOS", no method/path/status framing, no raw bodies — every route
 * may render it verbatim). The upstream validation text rides in `detail`,
 * which only admin-gated surfaces opt into. These tests fetch-mock the
 * transport and pin both halves, because nothing else in the suite mocks
 * at this layer (route tests mock the exported wrappers, so the message
 * strings themselves would go unpinned).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/agentos", () => ({
  AGENTOS_ENABLED: true,
  AGENTOS_BASE_URL: "http://agent-os.test",
  AGENTOS_JWT_SECRET: "test-secret",
  AGENTOS_MISCONFIGURED: false,
}));

import { AgentosError, agentosRequest, buildRequirements, BuilderValidationError, fetchAgentosModels, testPlatformModel, type AgentosModel, type AgentosTool } from "@/lib/agents/builder";
import { requirementsSchema } from "@/lib/agents/agent-store";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rejection(promise: Promise<unknown>): Promise<AgentosError> {
  try {
    await promise;
    throw new Error("expected the promise to reject");
  } catch (err) {
    return err as AgentosError;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agentosRequest error discipline", () => {
  it("network failure → 502, user-safe message, no detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await rejection(fetchAgentosModels());
    expect(err).toBeInstanceOf(AgentosError);
    expect(err.status).toBe(502);
    expect(err.message).toBe("The agent builder is unavailable right now — please try again shortly.");
    expect(err.detail).toBeUndefined();
  });

  it("4xx → clean message + the upstream detail parsed out of the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { detail: "test failed: nope is not a valid model ID" },
          400,
        ),
      ),
    );
    const err = await rejection(testPlatformModel("openrouter:nope"));
    expect(err.status).toBe(400);
    expect(err.message).toBe("The agent builder couldn't process that request. Refresh and try again.");
    expect(err.message).not.toContain("AgentOS");
    expect(err.message).not.toContain("/platform/test/model");
    expect(err.detail).toBe("test failed: nope is not a valid model ID");
  });

  it("non-JSON 4xx body → detail falls back to the raw slice, message stays clean", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("plain text boom", { status: 422 })),
    );
    const err = await rejection(testPlatformModel("openrouter:nope"));
    expect(err.status).toBe(422);
    expect(err.detail).toBe("plain text boom");
    expect(err.message).not.toContain("boom");
  });

  it("5xx → unavailable message; detail still parsed (admin surfaces only)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "db exploded" }, 500)),
    );
    const err = await rejection(fetchAgentosModels());
    expect(err.status).toBe(500);
    expect(err.message).toBe("The agent builder is unavailable right now — please try again shortly.");
    expect(err.detail).toBe("db exploded");
  });

  it("upstream 401/403 (service-token failure) maps to 502 with the unavailable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "bad token" }, 401)),
    );
    const err = await rejection(fetchAgentosModels());
    expect(err.status).toBe(502);
    expect(err.message).toBe("The agent builder is unavailable right now — please try again shortly.");
    expect(err.detail).toBe("bad token");
  });

  it("refuses a path with injection-prone characters (a forgotten encodeURIComponent)", async () => {
    // Defense-in-depth: the request path carries the app:superadmin
    // service token, so a tenant-supplied string reaching agentosRequest
    // raw must fail loudly, never reach fetch.
    for (const bad of [
      "/components/x?next=evil",
      "/components/x#frag",
      "/components/a b",
      "components/x",
    ]) {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const err = await rejection(agentosRequest("GET", bad));
      expect(err).toBeInstanceOf(AgentosError);
      expect(err.status).toBe(500);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });
});

describe("buildRequirements write-boundary validation", () => {
  const model: AgentosModel = {
    provider: "openai",
    id: "gpt-5",
    platform_tier: true,
    requires_key: true,
    dep_key: "openai_api_key",
    name: "OpenAIChat",
  };
  const tool = (over: Partial<AgentosTool> = {}): AgentosTool => ({
    name: "tavily_search",
    label: "Web search (Tavily)",
    requires_key: "tavily_api_key",
    fallback_env: "TAVILY_API_KEY",
    platform_fallback: false,
    toolkit: "tavily",
    credentials: [{ dep_key: "tavily_api_key", label: "Tavily API key" }],
    ...over,
  });
  const spec = { tools: [{ name: "tavily_search" }], connectors: [] };

  it("omits an empty catalog tool label instead of poisoning the snapshot", () => {
    const req = buildRequirements(spec, model, [tool({ label: "" })]);
    expect(req.tools[0].label).toBeUndefined();
  });

  it("falls back to the dep key when a credential label is empty", () => {
    const req = buildRequirements(spec, model, [
      tool({ credentials: [{ dep_key: "tavily_api_key", label: "" }] }),
    ]);
    expect(req.tools[0].credentials).toEqual([
      { depKey: "tavily_api_key", label: "tavily_api_key" },
    ]);
  });

  it("rejects a catalog row with an empty credential dep_key (fail loud at save)", () => {
    const bad = [tool({ credentials: [{ dep_key: "", label: "x" }] })];
    expect(() => buildRequirements(spec, model, bad)).toThrow(BuilderValidationError);
  });

  it("rejects a keyed model with no declared dep key (broken platform row)", () => {
    // The schema can't cross-check requiresKey against depKey — a row
    // with requires_key=true and dep_key=null used to save fine and then
    // 402 forever with "re-save in the agent builder" advice that could
    // never work (a re-save persists the same null).
    const broken: AgentosModel = { ...model, dep_key: null };
    expect(() => buildRequirements(spec, broken, [tool()])).toThrow(
      /requires an API key but declares no credential slot/,
    );
    // A keyless model legitimately carries dep_key null — must still save.
    const keyless: AgentosModel = { ...model, requires_key: false, dep_key: null };
    expect(() => buildRequirements(spec, keyless, [tool()])).not.toThrow();
  });

  it("output parses with the same schema every read applies", () => {
    const req = buildRequirements(spec, model, [tool()]);
    expect(requirementsSchema.safeParse(req).success).toBe(true);
  });

  it("persists the declared dep key and binding name for door providers", () => {
    // A responses-door model carries the platform's declared dep_key and
    // the agno registry binding name into the snapshot — the run gate uses
    // the dep key (vendor-shared credential), and the component config
    // sends the name so same-id doors bind exactly.
    const doorModel: AgentosModel = {
      provider: "openai-responses",
      id: "gpt-5.6-luna",
      platform_tier: false,
      requires_key: true,
      dep_key: "openai_api_key",
      name: "OpenAIResponses",
    };
    const req = buildRequirements(spec, doorModel, [tool()]);
    expect(req.model).toMatchObject({
      provider: "openai-responses",
      depKey: "openai_api_key",
      name: "OpenAIResponses",
    });
    // And the snapshot still parses with the read schema.
    expect(requirementsSchema.safeParse(req).success).toBe(true);
  });

});

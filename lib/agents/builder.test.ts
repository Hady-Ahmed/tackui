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

import {
  AgentosError,
  agentosRequest,
  buildComponentConfig,
  buildRequirements,
  builderCreateBodySchema,
  BuilderValidationError,
  deleteKnowledgeContent,
  deriveRequirementsFromConfig,
  fetchAgentosModels,
  fetchKnowledgeConfig,
  fetchKnowledgeList,
  knowledgeCorpusName,
  testPlatformModel,
  uploadKnowledgeContent,
  type AgentosModel,
  type AgentosTool,
} from "@/lib/agents/builder";
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

  it("a multipart body's 4xx never leaks its form values into detail or the log", async () => {
    // The multipart ingest (uploadKnowledgeContent) carries the creator's
    // embedding key in its body ONLY. A foreign/future service that echoes
    // form input in validation errors would otherwise copy the key into
    // the server log and admin-facing detail — so FormData bodies skip
    // detail extraction entirely (airtight beats scrub-shaped). Called
    // through the wrapper so the real ingest call site is exercised.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The mock echoes the REAL form the wrapper builds — the exported
    // ingest call site is what's pinned, not a hand-built stand-in (a
    // future refactor passing a non-FormData body would fail this loudly).
    let sentKey = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        sentKey =
          body instanceof FormData ? String(body.get("embedding_key")) : "";
        return jsonResponse(
          { detail: `invalid value for embedding_key: ${sentKey}` },
          422,
        );
      }),
    );
    const err = await rejection(
      uploadKnowledgeContent({
        componentId: "abc123",
        text: "hello",
        embeddingKey: "sk-echo-secret",
      }),
    );
    expect(sentKey).toBe("sk-echo-secret");
    expect(err.status).toBe(422);
    expect(err.detail).toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logLine = String(errSpy.mock.calls[0]?.[0]);
    expect(logLine).toBe(
      "[agentos] POST /platform/knowledge/abc123/content failed (422)",
    );
    errSpy.mockRestore();
    // Contrast: the SAME echoed body on a JSON-body call still extracts
    // the detail — the skip is form-scoped, not a blanket detail removal.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { detail: "invalid value for embedding_key: sk-echo-secret" },
          422,
        ),
      ),
    );
    const errSpy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    const jsonErr = await rejection(testPlatformModel("openrouter:nope"));
    expect(jsonErr.detail).toBe("invalid value for embedding_key: sk-echo-secret");
    expect(String(errSpy2.mock.calls[0]?.[0])).toContain("sk-echo-secret");
    errSpy2.mockRestore();
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

  it("accepts a >10-tool spec — tools are uncapped (regression pin)", () => {
    // The removed 10-tool cap lived in the schema as a .max(10) on the
    // tools array; a single toolkit (GitHub) carries 30+ tools, so the
    // cap made large toolkits impossible to attach. This pins the
    // uncapped behavior end-to-end: schema + requirements snapshot.
    const catalog = Array.from({ length: 12 }, (_, i) =>
      tool({ name: `tool_${i}`, toolkit: "bulk", label: `Bulk tool ${i}` }),
    );
    const big = {
      tools: catalog.map((t) => ({ name: t.name })),
      connectors: [],
    };
    expect(builderCreateBodySchema.shape.tools.safeParse(big.tools).success).toBe(true);
    const req = buildRequirements(big, model, catalog);
    expect(req.tools).toHaveLength(12);
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

describe("knowledge clients", () => {
  const capability = { enabled: true, provider: "openai", model: "text-embedding-3-small" };

  it("fetchKnowledgeConfig parses the capability payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(capability)));
    expect(await fetchKnowledgeConfig()).toEqual(capability);
  });

  it("fetchKnowledgeConfig rejects an enabled answer that names no embedder (upstream bug → 502, not a late 500)", async () => {
    // knowledgeConfigSchema's cross-field rule: enabled with EMPTY
    // provider/model would survive this read and then fail
    // requirementsSchema's min(1) at the attach write — a generic 500
    // with the corpus already uploaded. Rejected here, with the same
    // 502 posture as any malformed payload.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ enabled: true, provider: "", model: "" })),
    );
    const err = await rejection(fetchKnowledgeConfig());
    expect(err).toBeInstanceOf(AgentosError);
    expect(err.status).toBe(502);
  });

  it("fetchKnowledgeConfig rejects an enabled answer MISSING the embedder fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ enabled: true })));
    const err = await rejection(fetchKnowledgeConfig());
    expect(err).toBeInstanceOf(AgentosError);
    expect(err.status).toBe(502);
  });

  it("fetchKnowledgeConfig degrades a 404 to the unsupported shape (service predates knowledge)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "Not Found" }, 404)));
    const cfg = await fetchKnowledgeConfig();
    expect(cfg).toEqual({ enabled: false, provider: "", model: "", unsupported: true });
  });

  it("fetchKnowledgeConfig keeps a reachable-but-disabled answer distinct from 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ enabled: false, provider: "", model: "" })),
    );
    const cfg = await fetchKnowledgeConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.unsupported).toBeUndefined();
  });

  it("fetchKnowledgeConfig propagates transport failures (unreachable ≠ unsupported)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await rejection(fetchKnowledgeConfig());
    expect(err).toBeInstanceOf(AgentosError);
    expect(err.status).toBe(502);
  });

  it("fetchKnowledgeList validates the camelCase rows and tolerates unknown extra fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { id: "c1", name: "handbook.pdf", description: "The team handbook", status: "completed", size: 12_345, createdAt: 1_700, updatedAt: 1_800, extra: "ignored" },
          { id: "c2", name: "notes.txt", description: null, status: null, size: null, createdAt: 1.5, updatedAt: 2.5 },
        ]),
      ),
    );
    const rows = await fetchKnowledgeList("abc123");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "c1", name: "handbook.pdf", description: "The team handbook", status: "completed", size: 12_345, createdAt: 1_700, updatedAt: 1_800 });
    // The description round-trips when present and reads as null when the
    // service stored none (the paste-text shape); an old deployment that
    // omits the key entirely parses too (#253's wire extension is additive).
    expect(rows[1].description).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([{ id: "c3", name: "legacy.txt", status: null, size: null, createdAt: 1, updatedAt: 2 }]),
      ),
    );
    const legacyRows = await fetchKnowledgeList("abc123");
    expect(legacyRows[0].description).toBeUndefined();
  });

  it("fetchKnowledgeList treats an empty corpus as [] and a malformed payload as a 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    expect(await fetchKnowledgeList("abc123")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ nope: true })));
    const err = await rejection(fetchKnowledgeList("abc123"));
    expect(err.status).toBe(502);
  });

  it("uploadKnowledgeContent sends a multipart body — no JSON Content-Type (fetch sets the boundary)", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ id: "c1", name: "a.pdf", status: "processing" }, 202),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const file = new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" });
    const result = await uploadKnowledgeContent({
      componentId: "abc123",
      file,
      name: "Handbook",
      chunkSize: 512,
      chunkOverlap: 64,
      embeddingKey: "sk-test",
    });
    expect(result).toEqual({ id: "c1", name: "a.pdf", status: "processing" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://agent-os.test/platform/knowledge/abc123/content");
    expect(init.method).toBe("POST");
    // The multipart body passes through untouched; the boundary header is
    // fetch's job — an explicit JSON Content-Type here would corrupt it.
    expect(init.body).toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    const form = init.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("a.pdf");
    expect(form.get("name")).toBe("Handbook");
    expect(form.get("chunk_size")).toBe("512");
    expect(form.get("chunk_overlap")).toBe("64");
    // The embedding key rides in the body only.
    expect(form.get("embedding_key")).toBe("sk-test");
  });

  it("uploadKnowledgeContent maps text/url sources into the service's form fields", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ id: "c1" }, 202));
    vi.stubGlobal("fetch", fetchSpy);
    await uploadKnowledgeContent({ componentId: "abc123", text: "hello", embeddingKey: "sk-test" });
    let form = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get("text_content")).toBe("hello");
    expect(form.has("file")).toBe(false);
    expect(form.has("url")).toBe(false);

    await uploadKnowledgeContent({ componentId: "abc123", url: "https://example.com/doc", embeddingKey: "sk-test" });
    form = (fetchSpy.mock.calls[1] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get("url")).toBe("https://example.com/doc");
    expect(form.has("text_content")).toBe(false);
  });

  it("uploadKnowledgeContent never sends a text source as JSON", async () => {
    // The FormData pass-through must hold for every source shape — a JSON
    // body here would 422 at FastAPI's multipart parser.
    const fetchSpy = vi.fn(async () => jsonResponse({ id: "c1" }, 202));
    vi.stubGlobal("fetch", fetchSpy);
    await uploadKnowledgeContent({ componentId: "abc123", text: "x", embeddingKey: "k" });
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("deleteKnowledgeContent hits the content path and parses the idempotent ok", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    await deleteKnowledgeContent({ componentId: "abc123", contentId: "c9" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://agent-os.test/platform/knowledge/abc123/content/c9");
    expect(init.method).toBe("DELETE");
  });

  it("deleteKnowledgeContent maps a malformed body to a 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ unexpected: true })));
    const err = await rejection(deleteKnowledgeContent({ componentId: "abc123", contentId: "c9" }));
    expect(err.status).toBe(502);
  });
});

describe("knowledge in the snapshot + config", () => {
  const model: AgentosModel = {
    provider: "openai",
    id: "gpt-4o-mini",
    platform_tier: true,
    requires_key: true,
    dep_key: "openai_api_key",
    name: "OpenAIChat",
  };
  const contract = { provider: "openai", model: "text-embedding-3-small" };

  it("buildRequirements carries the knowledge contract and the output parses with the read schema", () => {
    const req = buildRequirements({ tools: [], connectors: [], knowledge: contract }, model, []);
    expect(req.knowledge).toEqual(contract);
    expect(requirementsSchema.safeParse(req).success).toBe(true);
  });

  it("buildRequirements keeps knowledge ABSENT when the spec lacks it (no default materializes)", () => {
    const req = buildRequirements({ tools: [], connectors: [] }, model, []);
    expect("knowledge" in req).toBe(false);
    expect(requirementsSchema.safeParse(req).success).toBe(true);
  });

  it("buildComponentConfig writes the knowledge ref when asked and never otherwise", () => {
    const withRef = buildComponentConfig(
      "comp-1",
      { name: "A", instructions: "i", tools: [], connectorIds: [], knowledgeRef: { name: "kb-comp-1" } },
      model,
      [],
    );
    expect(withRef.knowledge).toEqual({ name: "kb-comp-1" });
    const without = buildComponentConfig(
      "comp-1",
      { name: "A", instructions: "i", tools: [], connectorIds: [] },
      model,
      [],
    );
    expect("knowledge" in without).toBe(false);
  });

  it("deriveRequirementsFromConfig includes knowledge only when the config references it AND the contract is provided", () => {
    const refConfig = { model: { id: "gpt-4o-mini", name: "OpenAIChat" }, instructions: ["i"], knowledge: { name: "kb-comp-1" } };
    const derived = deriveRequirementsFromConfig(refConfig, [model], [], new Map(), contract);
    expect(derived?.knowledge).toEqual(contract);
    // The detach direction: the same config minus the ref → knowledge stays absent.
    const derivedDetached = deriveRequirementsFromConfig(
      { ...refConfig, knowledge: undefined },
      [model],
      [],
      new Map(),
      contract,
    );
    expect(derivedDetached && "knowledge" in derivedDetached).toBe(false);
    // A ref with NO contract data refuses the derivation (the caller falls
    // back to the pre-patch snapshot — never a lossy write).
    const refused = deriveRequirementsFromConfig(refConfig, [model], [], new Map());
    expect(refused).toBeNull();
    // A malformed ref refuses too.
    expect(deriveRequirementsFromConfig({ ...refConfig, knowledge: { nope: 1 } }, [model], [], new Map(), contract)).toBeNull();
  });

  it("knowledgeCorpusName derives kb-<component_id> — both sides agree by construction", () => {
    expect(knowledgeCorpusName("abc123")).toBe("kb-abc123");
  });
});

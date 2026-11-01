import { describe, expect, it } from "vitest";
import {
  BUILDER_CONNECTORS_MAX,
  BUILDER_TOOLS_MAX,
  buildCreatePayload,
  buildUpdatePayload,
  catalogEmptyCopy,
  createBlockedByEmptyModels,
  extractErrorMessage,
  findModel,
  groupModelsByProvider,
  modelKeyState,
  pickDefaultModel,
  providerForDepKeyInCatalog,
  staleModelCopy,
  toolKeyState,
  validateBuilderForm,
  type BuilderFormState,
  type BuilderToolOption,
  type CredentialCatalog,
  type PlatformModel,
} from "./builder-config";

const MODELS: PlatformModel[] = [
  { provider: "openai", id: "gpt-4o-mini", platformTier: true, requiresKey: true, depKey: "openai_api_key" },
  { provider: "anthropic", id: "claude-3-5-sonnet", platformTier: false, requiresKey: true, depKey: "anthropic_api_key" },
  { provider: "openai", id: "gpt-4o", platformTier: false, requiresKey: true, depKey: "openai_api_key" },
  { provider: "openrouter", id: "meta-llama/llama-3.1-8b", platformTier: true, requiresKey: true, depKey: "openrouter_api_key" },
  { provider: "ollama", id: "llama3", platformTier: false, requiresKey: false, depKey: null },
];

const CATALOG: CredentialCatalog = {
  openai: {
    kind: "llm",
    keyName: "openai_api_key",
    label: "Openai",
    fields: [{ key: "api_key", label: "Api key" }],
  },
  openrouter: {
    kind: "llm",
    keyName: "openrouter_api_key",
    label: "Openrouter",
    fields: [{ key: "api_key", label: "Api key" }],
  },
  tavily: {
    kind: "tool",
    keyName: "tavily_api_key",
    label: "Tavily",
    fields: [{ key: "api_key", label: "Tavily api key" }],
  },
  x: {
    kind: "tool",
    keyName: "x_consumer_key",
    label: "X",
    fields: [
      { key: "consumer_key", label: "X consumer key" },
      { key: "access_token", label: "X access token" },
    ],
  },
};

/** The tool palette as GET /api/tools returns it — the platform catalog. */
const TOOLS: BuilderToolOption[] = [
  {
    name: "web_search",
    label: "Web search (DuckDuckGo)",
    requiresKey: null,
    platformFallback: false,
    toolkit: "duckduckgo",
    credentials: [],
  },
  {
    name: "search_news",
    label: "News search (DuckDuckGo)",
    requiresKey: null,
    platformFallback: false,
    toolkit: "duckduckgo",
    credentials: [],
  },
  {
    name: "tavily_search",
    label: "Web search (Tavily)",
    requiresKey: "tavily_api_key",
    platformFallback: true,
    toolkit: "tavily",
    credentials: [{ depKey: "tavily_api_key", label: "Tavily api key" }],
  },
  {
    // Multi-credential toolkit — one provider, several fields.
    name: "search_x",
    label: "Search X posts",
    requiresKey: "x_consumer_key",
    platformFallback: false,
    toolkit: "x",
    credentials: [
      { depKey: "x_consumer_key", label: "X consumer key" },
      { depKey: "x_access_token", label: "X access token" },
    ],
  },
];

function credentialsState(has: string[]) {
  const hasKey: Record<string, boolean> = {};
  for (const p of has) hasKey[p] = true;
  return { hasKey, catalog: CATALOG };
}

const validForm: BuilderFormState = {
  name: "Researcher",
  description: "Web research assistant",
  instructions: "You are a research assistant.",
  model: { provider: "openai", id: "gpt-4o-mini" },
  tools: [],
  connectors: [],
};

describe("groupModelsByProvider", () => {
  it("groups by provider and sorts providers then model ids", () => {
    const groups = groupModelsByProvider(MODELS);
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "ollama", "openai", "openrouter"]);
    expect(groups[2].models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("returns an empty array for an empty catalog", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });
});

describe("pickDefaultModel", () => {
  it("picks the first model (TIER DORMANCY — no platform-key preference)", () => {
    expect(pickDefaultModel(MODELS)).toEqual(MODELS[0]);
  });

  it("returns null for an empty catalog", () => {
    expect(pickDefaultModel([])).toBeNull();
  });
});

describe("findModel", () => {
  it("matches on provider + id and returns null otherwise", () => {
    expect(findModel(MODELS, "openai", "gpt-4o-mini")).toEqual(MODELS[0]);
    expect(findModel(MODELS, "openai", "nope")).toBeNull();
  });
});

describe("staleModelCopy — saved model no longer in the catalog", () => {
  it("returns null when the model is in the catalog", () => {
    expect(staleModelCopy({ provider: "openai", id: "gpt-4o-mini" }, MODELS, null)).toBeNull();
  });

  it("returns null when no model is selected (create mode)", () => {
    expect(staleModelCopy(null, MODELS, null)).toBeNull();
  });

  it("returns null while loading (models null) — the catalog can't have judged the model stale yet", () => {
    expect(staleModelCopy({ provider: "openai", id: "gpt-4o-mini" }, null, null)).toBeNull();
  });

  it("returns null when the fetch failed — the unreachable banner wins", () => {
    expect(staleModelCopy({ provider: "openai", id: "gone" }, MODELS, "AgentOS is unreachable")).toBeNull();
  });

  it("returns copy naming the stale identifier for a removed model", () => {
    const copy = staleModelCopy({ provider: "openai", id: "gpt-4o-2024" }, MODELS, null);
    expect(copy).toContain("no longer offered");
    expect(copy).toContain("openai:gpt-4o-2024");
    expect(copy).toContain("keeps the old model");
  });

  it("returns copy when the whole provider was removed", () => {
    const copy = staleModelCopy({ provider: "cohere", id: "command-r" }, MODELS, null);
    expect(copy).toContain("cohere:command-r");
  });
});

describe("providerForDepKeyInCatalog", () => {
  it("maps a dep key to its provider", () => {
    expect(providerForDepKeyInCatalog(CATALOG, "tavily_api_key")).toBe("tavily");
    expect(providerForDepKeyInCatalog(CATALOG, "openai_api_key")).toBe("openai");
  });

  it("returns null for an unknown dep key", () => {
    expect(providerForDepKeyInCatalog(CATALOG, "nope")).toBeNull();
  });
});

describe("modelKeyState", () => {
  it("TIER DORMANCY: a platform-tier model without a key reports missing (no platform badge)", () => {
    expect(
      modelKeyState({ provider: "openai", platformTier: true, requiresKey: true, depKey: "openai_api_key" }, credentialsState([])),
    ).toEqual({
      status: "missing",
      providerLabel: "Openai",
      provider: "openai",
    });
  });

  it("reports connected when the runner has the provider key", () => {
    expect(
      modelKeyState({ provider: "openai", platformTier: false, requiresKey: true, depKey: "openai_api_key" }, credentialsState(["openai"])),
    ).toEqual({
      status: "connected",
      providerLabel: "Openai",
    });
  });

  it("reports missing when there is no key", () => {
    expect(
      modelKeyState({ provider: "openai", platformTier: false, requiresKey: true, depKey: "openai_api_key" }, credentialsState([])),
    ).toEqual({
      status: "missing",
      providerLabel: "Openai",
      provider: "openai",
    });
  });

  it("reports none for a keyless provider (e.g. ollama) — nothing to connect", () => {
    expect(
      modelKeyState({ provider: "ollama", platformTier: false, requiresKey: false, depKey: null }, credentialsState([])),
    ).toEqual({ status: "none" });
  });

  it("labels unknown providers with the raw provider id and no connect form", () => {
    expect(
      modelKeyState({ provider: "mystery", platformTier: false, requiresKey: true, depKey: "mystery_api_key" }, credentialsState([])),
    ).toEqual({
      status: "missing",
      providerLabel: "mystery",
      provider: null,
    });
  });

  it("returns null when no model is selected", () => {
    expect(modelKeyState(null, credentialsState([]))).toBeNull();
  });

  it("resolves a door slug through the declared dep key — vendor label, vendor hasKey", () => {
    // A responses-door model's credential is the VENDOR's (the catalog has
    // no "openai-responses" entry — doors collapse into "openai"). The
    // badge must say "Openai" (the vendor entry's label) and report
    // connected from the vendor's saved key.
    expect(
      modelKeyState(
        {
          provider: "openai-responses",
          platformTier: false,
          requiresKey: true,
          depKey: "openai_api_key",
        },
        credentialsState(["openai"]),
      ),
    ).toEqual({ status: "connected", providerLabel: "Openai" });
  });

  it("a missing door key points the connect CTA at the vendor entry", () => {
    expect(
      modelKeyState(
        {
          provider: "openai-responses",
          platformTier: false,
          requiresKey: true,
          depKey: "openai_api_key",
        },
        credentialsState([]),
      ),
    ).toEqual({
      status: "missing",
      providerLabel: "Openai",
      provider: "openai",
    });
  });

  it("falls back to the raw slug label when the catalog is unavailable", () => {
    // No credentials state → no label and no hasKey; the vendor resolution
    // itself is pure dep-key math, so the CTA provider stays correct.
    const state = modelKeyState(
      {
        provider: "openai-responses",
        platformTier: false,
        requiresKey: true,
        depKey: "openai_api_key",
      },
      null,
    );
    if (!state || state.status !== "missing") throw new Error("expected a missing state");
    expect(state.providerLabel).toBe("openai-responses"); // no catalog → no label; raw slug fallback
    expect(state.provider).toBeNull(); // no catalog → no connect form to point at
  });
});

describe("toolKeyState", () => {
  it("treats a free tool as none", () => {
    expect(toolKeyState(TOOLS[0], credentialsState([]))).toEqual({ status: "none" });
  });

  it("reports connected when the runner has the key", () => {
    expect(toolKeyState(TOOLS[2], credentialsState(["tavily"]))).toEqual({
      status: "connected",
      providerLabel: "Tavily",
    });
  });

  it("TIER DORMANCY: a platformFallback tool without a key reports missing (no fallback badge)", () => {
    expect(toolKeyState(TOOLS[2], credentialsState([]))).toEqual({
      status: "missing",
      providerLabel: "Tavily",
      provider: "tavily",
    });
  });

  it("resolves the provider from the toolkit slug (multi-credential toolkits)", () => {
    expect(toolKeyState(TOOLS[3], credentialsState(["x"]))).toEqual({
      status: "connected",
      providerLabel: "X",
    });
  });

  it("reports missing when the key is required and absent", () => {
    const noFallback = { ...TOOLS[2], platformFallback: false };
    expect(toolKeyState(noFallback, credentialsState([]))).toEqual({
      status: "missing",
      providerLabel: "Tavily",
      provider: "tavily",
    });
  });

  it("falls back to the raw dep key as the label when the catalog doesn't know the provider", () => {
    const unknown = { ...TOOLS[2], toolkit: "", requiresKey: "mystery_api_key" };
    expect(toolKeyState(unknown, credentialsState(["tavily"]))).toEqual({
      status: "missing",
      providerLabel: "mystery_api_key",
      provider: null,
    });
  });

  it("does not offer Connect for a toolkit slug the catalog doesn't know", () => {
    // A toolkit slug present on the tool but absent from the credentials
    // catalog can't be connected (KeyForm would render nothing) — the
    // badge must not offer a dead-click Connect button.
    const drifted = { ...TOOLS[2], toolkit: "ghost_toolkit" };
    expect(toolKeyState(drifted, credentialsState(["tavily"]))).toEqual({
      status: "missing",
      providerLabel: "tavily_api_key",
      provider: null,
    });
  });
});

describe("validateBuilderForm", () => {
  it("accepts a valid create form", () => {
    expect(validateBuilderForm(validForm, "create")).toEqual({});
  });

  it("requires the identity fields on create", () => {
    const errors = validateBuilderForm(
      { ...validForm, name: "", description: "", instructions: "", model: null },
      "create",
    );
    expect(errors.name).toBe("Name is required");
    expect(errors.description).toBe("Description is required");
    expect(errors.instructions).toBe("Instructions are required");
    expect(errors.model).toBe("Pick a provider and model");
  });

  it("enforces the max lengths from the builder schemas", () => {
    const errors = validateBuilderForm(
      {
        ...validForm,
        name: "x".repeat(101),
        description: "x".repeat(301),
        instructions: "x".repeat(8001),
      },
      "create",
    );
    expect(errors.name).toContain("100");
    expect(errors.description).toContain("300");
    expect(errors.instructions).toContain("8000");
  });

  it("allows blank instructions on edit (blank preserves the stored ones)", () => {
    const errors = validateBuilderForm({ ...validForm, instructions: "" }, "edit");
    expect(errors.instructions).toBeUndefined();
  });

  it("rejects more tools than BUILDER_TOOLS_MAX", () => {
    const errors = validateBuilderForm(
      {
        ...validForm,
        tools: Array.from({ length: BUILDER_TOOLS_MAX + 1 }, (_, i) => `tool_${i}`),
      },
      "create",
    );
    expect(errors.tools).toBeDefined();
  });

  it("rejects more connectors than BUILDER_CONNECTORS_MAX", () => {
    const errors = validateBuilderForm(
      {
        ...validForm,
        connectors: Array.from({ length: BUILDER_CONNECTORS_MAX + 1 }, (_, i) => `conn_${i}`),
      },
      "create",
    );
    expect(errors.connectors).toBeDefined();
  });

  it("accepts exactly BUILDER_TOOLS_MAX tools", () => {
    const errors = validateBuilderForm(
      { ...validForm, tools: Array.from({ length: BUILDER_TOOLS_MAX }, (_, i) => `tool_${i}`) },
      "create",
    );
    expect(errors.tools).toBeUndefined();
  });
});

describe("buildCreatePayload", () => {
  it("serializes the exact wire shape", () => {
    expect(buildCreatePayload({ ...validForm, tools: ["web_search"], connectors: ["github"] })).toEqual({
      name: "Researcher",
      description: "Web research assistant",
      instructions: "You are a research assistant.",
      model: { provider: "openai", id: "gpt-4o-mini" },
      tools: [{ name: "web_search" }],
      connectors: ["github"],
    });
  });

  it("trims the identity fields", () => {
    expect(buildCreatePayload({ ...validForm, name: "  Researcher " }).name).toBe("Researcher");
  });
});

describe("buildUpdatePayload", () => {
  it("omits unchanged fields when instructions are blank", () => {
    expect(buildUpdatePayload({ ...validForm, instructions: "" }, validForm)).toEqual({});
  });

  it("includes only the changed fields", () => {
    const form = {
      ...validForm,
      instructions: "",
      name: "Renamed",
      tools: ["web_search"],
      connectors: ["github", "github"],
    };
    expect(buildUpdatePayload(form, validForm)).toEqual({
      name: "Renamed",
      tools: [{ name: "web_search" }],
      connectors: ["github", "github"],
    });
  });

  it("sends instructions whenever non-blank — the local row never carries them", () => {
    expect(buildUpdatePayload({ ...validForm, instructions: " new " }, validForm)).toEqual({
      instructions: "new",
    });
  });

  it("detects reordered tool and connector sets", () => {
    const form = { ...validForm, instructions: "", tools: ["search_news", "web_search"] };
    expect(buildUpdatePayload(form, validForm)).toEqual({
      tools: [{ name: "search_news" }, { name: "web_search" }],
    });
    const same = { ...validForm, instructions: "", tools: ["web_search", "search_news"] };
    expect(buildUpdatePayload({ ...validForm, instructions: "", tools: ["search_news", "web_search"] }, same)).toEqual(
      {},
    );
  });
});

describe("extractErrorMessage", () => {
  it("returns the error string", () => {
    expect(extractErrorMessage({ error: "Agent not found" }, "fallback")).toBe("Agent not found");
  });

  it("flattens zod fieldErrors into one line", () => {
    expect(
      extractErrorMessage(
        {
          error: "Validation failed",
          details: { fieldErrors: { name: ["Name is required"], description: ["Description is required"] } },
        },
        "fallback",
      ),
    ).toBe("name: Name is required · description: Description is required");
  });

  it("falls back when the shape is unrecognized", () => {
    expect(extractErrorMessage({}, "fallback")).toBe("fallback");
    expect(extractErrorMessage(null, "fallback")).toBe("fallback");
  });
});

describe("catalogEmptyCopy — empty-by-default platform catalogs (turn 7)", () => {
  it("returns null while loading (catalog still null)", () => {
    expect(catalogEmptyCopy("models", null, null)).toBeNull();
    expect(catalogEmptyCopy("tools", null, null)).toBeNull();
  });

  it("returns null when the catalog is populated", () => {
    expect(catalogEmptyCopy("models", MODELS, null)).toBeNull();
    expect(catalogEmptyCopy("tools", TOOLS, null)).toBeNull();
    // A single entry counts as populated.
    expect(catalogEmptyCopy("tools", [TOOLS[0]], null)).toBeNull();
  });

  it("returns null when the fetch failed — the unreachable banner wins", () => {
    expect(catalogEmptyCopy("models", null, "AgentOS is unreachable")).toBeNull();
    expect(catalogEmptyCopy("tools", [], "AgentOS is unreachable")).toBeNull();
  });

  it("returns operator-facing copy for an empty model catalog", () => {
    const copy = catalogEmptyCopy("models", [], null);
    expect(copy).toContain("platform admin");
    expect(copy).toContain("The agent builder has no models yet");
  });

  it("returns operator-facing copy for an empty tool catalog", () => {
    const copy = catalogEmptyCopy("tools", [], null);
    expect(copy).toContain("platform admin");
    expect(copy).toContain("The agent builder has no tools yet");
  });

  it("never addresses the reader as the platform owner", () => {
    // SaaS end users don't own the platform — "your agent platform"
    // would imply they do. The possessive must not appear.
    for (const kind of ["models", "tools"] as const) {
      const copy = catalogEmptyCopy(kind, [], null) ?? "";
      expect(copy.toLowerCase()).not.toContain("your agent platform");
    }
  });
});

describe("createBlockedByEmptyModels — empty catalog can't produce a create", () => {
  it("blocks create with an empty, successfully loaded model catalog", () => {
    expect(createBlockedByEmptyModels("create", [], null)).toBe(true);
  });

  it("does not block while loading or on fetch failure (unreachable rule)", () => {
    expect(createBlockedByEmptyModels("create", null, null)).toBe(false);
    expect(createBlockedByEmptyModels("create", null, "AgentOS is unreachable")).toBe(false);
    expect(createBlockedByEmptyModels("create", [], "AgentOS is unreachable")).toBe(false);
  });

  it("does not block when models exist", () => {
    expect(createBlockedByEmptyModels("create", MODELS, null)).toBe(false);
  });

  it("never blocks edit — the model is only sent when it changes", () => {
    expect(createBlockedByEmptyModels("edit", [], null)).toBe(false);
    expect(createBlockedByEmptyModels("edit", MODELS, null)).toBe(false);
  });
});

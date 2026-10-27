import { describe, expect, it } from "vitest";
import {
  buildCreatePayload,
  buildUpdatePayload,
  extractErrorMessage,
  findModel,
  groupModelsByProvider,
  modelKeyState,
  pickDefaultModel,
  providerForDepKey,
  toolKeyState,
  validateBuilderForm,
  type BuilderFormState,
  type BuilderToolOption,
  type CredentialCatalog,
  type PlatformModel,
} from "./builder-config";

const MODELS: PlatformModel[] = [
  { provider: "openai", id: "gpt-4o-mini", platformTier: true },
  { provider: "anthropic", id: "claude-3-5-sonnet", platformTier: false },
  { provider: "openai", id: "gpt-4o", platformTier: false },
  { provider: "openrouter", id: "meta-llama/llama-3.1-8b", platformTier: true },
];

const CATALOG: CredentialCatalog = {
  openai: { kind: "llm", keyName: "openai_api_key", label: "Openai" },
  openrouter: { kind: "llm", keyName: "openrouter_api_key", label: "Openrouter" },
  tavily: { kind: "tool", keyName: "tavily_api_key", label: "Tavily" },
};

/** The tool palette as GET /api/tools returns it — the platform catalog. */
const TOOLS: BuilderToolOption[] = [
  { name: "web_search", label: "Web search (DuckDuckGo)", requiresKey: null, platformFallback: false },
  { name: "search_news", label: "News search (DuckDuckGo)", requiresKey: null, platformFallback: false },
  { name: "tavily_search", label: "Web search (Tavily)", requiresKey: "tavily_api_key", platformFallback: true },
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
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "openai", "openrouter"]);
    expect(groups[1].models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("returns an empty array for an empty catalog", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });
});

describe("pickDefaultModel", () => {
  it("prefers the first platform-tier model", () => {
    expect(pickDefaultModel(MODELS)).toEqual(MODELS[0]);
  });

  it("falls back to the first model when nothing is platform-tier", () => {
    expect(pickDefaultModel([MODELS[2]])).toEqual(MODELS[2]);
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

describe("providerForDepKey", () => {
  it("maps a dep key to its provider", () => {
    expect(providerForDepKey(CATALOG, "tavily_api_key")).toBe("tavily");
    expect(providerForDepKey(CATALOG, "openai_api_key")).toBe("openai");
  });

  it("returns null for an unknown dep key", () => {
    expect(providerForDepKey(CATALOG, "nope")).toBeNull();
  });
});

describe("modelKeyState", () => {
  it("reports platform tier without a key", () => {
    expect(modelKeyState({ provider: "openai", platformTier: true }, credentialsState([]))).toEqual({
      status: "platform",
    });
  });

  it("reports connected when the runner has the provider key", () => {
    expect(modelKeyState({ provider: "openai", platformTier: false }, credentialsState(["openai"]))).toEqual({
      status: "connected",
      providerLabel: "Openai",
    });
  });

  it("reports missing when there is no key", () => {
    expect(modelKeyState({ provider: "openai", platformTier: false }, credentialsState([]))).toEqual({
      status: "missing",
      providerLabel: "Openai",
      provider: "openai",
    });
  });

  it("labels unknown providers with the raw provider id and no connect form", () => {
    expect(modelKeyState({ provider: "mystery", platformTier: false }, credentialsState([]))).toEqual({
      status: "missing",
      providerLabel: "mystery",
      provider: null,
    });
  });

  it("returns null when no model is selected", () => {
    expect(modelKeyState(null, credentialsState([]))).toBeNull();
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

  it("reports fallback when the platform carries a key for the tool", () => {
    expect(toolKeyState(TOOLS[2], credentialsState([]))).toEqual({
      status: "fallback",
      providerLabel: "Tavily",
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
    const unknown = { ...TOOLS[2], requiresKey: "mystery_api_key" };
    expect(toolKeyState(unknown, credentialsState(["tavily"]))).toEqual({
      status: "fallback",
      providerLabel: "mystery_api_key",
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
    expect(errors.model).toBe("Pick a model");
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

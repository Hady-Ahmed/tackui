import { describe, expect, it } from "vitest";
import type { AgentosModel, AgentosTool } from "@/lib/agents/builder";
import {
  deriveCredentialsCatalog,
  depKeyForProvider,
  fieldForDepKey,
  prettifyProviderLabel,
  providerForDepKey,
} from "./catalog";

const MODELS: AgentosModel[] = [
  { provider: "openai", id: "gpt-4o-mini", platform_tier: true, requires_key: true },
  { provider: "openrouter", id: "z-ai/glm-5.3-flash", platform_tier: false, requires_key: true },
  { provider: "ollama", id: "llama3", platform_tier: false, requires_key: false },
];

const TOOLS: AgentosTool[] = [
  {
    name: "web_search",
    label: "Web search (DuckDuckGo)",
    requires_key: null,
    fallback_env: null,
    platform_fallback: false,
    toolkit: "duckduckgo",
    credentials: [],
  },
  {
    name: "web_search_using_tavily",
    label: "Web search (Tavily)",
    requires_key: "tavily_api_key",
    fallback_env: "TAVILY_API_KEY",
    platform_fallback: true,
    toolkit: "tavily",
    credentials: [{ dep_key: "tavily_api_key", label: "Tavily api key" }],
  },
  {
    // Multi-credential toolkit — the X toolkit's four-field contract.
    name: "search_x",
    label: "Search X posts",
    requires_key: "x_consumer_key",
    fallback_env: null,
    platform_fallback: false,
    toolkit: "x",
    credentials: [
      { dep_key: "x_consumer_key", label: "X consumer key" },
      { dep_key: "x_consumer_secret", label: "X consumer secret" },
      { dep_key: "x_access_token", label: "X access token" },
      { dep_key: "x_access_token_secret", label: "X access token secret" },
    ],
  },
];

describe("deriveCredentialsCatalog", () => {
  it("derives an empty catalog from empty platform catalogs — empty-by-default (turn 7)", () => {
    // An unconfigured platform exposes nothing; the credentials catalog
    // mirrors that with an empty (non-null) object — reachable-but-empty,
    // distinct from the unreachable `null` degrade.
    expect(deriveCredentialsCatalog([], [])).toEqual({});
  });

  it("derives LLM providers from the model catalog's distinct providers", () => {
    const catalog = deriveCredentialsCatalog(MODELS, []);
    expect(Object.keys(catalog).sort()).toEqual(["openai", "openrouter"]);
    expect(catalog.openai).toMatchObject({ kind: "llm", keyName: "openai_api_key" });
    expect(catalog.openrouter.label).toBe("Openrouter");
    // The single field of a single-key provider.
    expect(catalog.openai.fields).toEqual([{ key: "api_key", label: "API key" }]);
  });

  it("skips keyless model providers (requires_key false — e.g. ollama)", () => {
    const catalog = deriveCredentialsCatalog(MODELS, []);
    expect(catalog.ollama).toBeUndefined();
  });

  it("derives tool providers from the toolkit slug with the full field contract", () => {
    const catalog = deriveCredentialsCatalog([], TOOLS);
    expect(Object.keys(catalog).sort()).toEqual(["tavily", "x"]);
    expect(catalog.tavily).toMatchObject({
      kind: "tool",
      keyName: "tavily_api_key",
      label: "Tavily",
    });
    expect(catalog.tavily.fields).toEqual([{ key: "api_key", label: "Tavily api key" }]);
    // Multi-credential: one provider, four fields (dep key minus prefix).
    expect(catalog.x.fields.map((f) => f.key)).toEqual([
      "consumer_key",
      "consumer_secret",
      "access_token",
      "access_token_secret",
    ]);
  });

  it("falls back to the mechanical dep-key derivation when the toolkit slug is absent", () => {
    const legacy: AgentosTool[] = [
      {
        name: "tavily_search",
        label: "Web search (Tavily)",
        requires_key: "tavily_api_key",
        fallback_env: null,
        platform_fallback: false,
        toolkit: "",
        credentials: [{ dep_key: "tavily_api_key", label: "Tavily api key" }],
      },
    ];
    const catalog = deriveCredentialsCatalog([], legacy);
    expect(catalog.tavily.keyName).toBe("tavily_api_key");
  });

  it("a provider in both catalogs keeps its first (LLM) entry and unions tool fields", () => {
    // openai also exposes a keyed tool (image generation) with an extra
    // constructor arg — the saved provider's field set grows to cover both.
    const catalog = deriveCredentialsCatalog(MODELS, [
      {
        name: "openai_image",
        label: "OpenAI image",
        requires_key: "openai_api_key",
        fallback_env: null,
        platform_fallback: false,
        toolkit: "openai",
        credentials: [{ dep_key: "openai_api_key", label: "OpenAI api key" }],
      },
    ]);
    expect(catalog.openai.kind).toBe("llm");
    expect(catalog.openai.fields).toEqual([{ key: "api_key", label: "API key" }]);
  });
});

describe("dep-key ↔ provider slug convention", () => {
  it("maps both directions", () => {
    expect(providerForDepKey("tavily_api_key")).toBe("tavily");
    expect(depKeyForProvider("tavily")).toBe("tavily_api_key");
  });

  it("passes through non-conforming keys unchanged", () => {
    expect(providerForDepKey("weird_key")).toBe("weird_key");
  });
});

describe("fieldForDepKey", () => {
  it("splits <provider>_<field> with the provider known", () => {
    expect(fieldForDepKey("tavily", "tavily_api_key")).toBe("api_key");
    expect(fieldForDepKey("x", "x_consumer_key")).toBe("consumer_key");
    expect(fieldForDepKey("x", "x_access_token_secret")).toBe("access_token_secret");
  });

  it("passes through keys without the provider prefix unchanged (fail-visible)", () => {
    expect(fieldForDepKey("tavily", "other_key")).toBe("other_key");
  });
});

describe("prettifyProviderLabel", () => {
  it("title-cases on word boundaries with acronym correction", () => {
    expect(prettifyProviderLabel("openai")).toBe("OpenAI");
    expect(prettifyProviderLabel("tavily")).toBe("Tavily");
    expect(prettifyProviderLabel("z-ai")).toBe("Z AI");
    expect(prettifyProviderLabel("azure_openai")).toBe("Azure OpenAI");
    // Unknown words still plain title-case.
    expect(prettifyProviderLabel("groq")).toBe("Groq");
  });
});

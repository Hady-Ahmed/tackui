import { describe, expect, it } from "vitest";
import type { AgentosModel, AgentosTool } from "@/lib/agents/builder";
import {
  deriveCredentialsCatalog,
  depKeyForProvider,
  prettifyProviderLabel,
  providerForDepKey,
} from "./catalog";

const MODELS: AgentosModel[] = [
  { provider: "openai", id: "gpt-4o-mini", platform_tier: true },
  { provider: "openrouter", id: "z-ai/glm-5.3-flash", platform_tier: false },
];

const TOOLS: AgentosTool[] = [
  { name: "web_search", label: "Web search (DuckDuckGo)", requires_key: null, fallback_env: null, platform_fallback: false },
  {
    name: "tavily_search",
    label: "Web search (Tavily)",
    requires_key: "tavily_api_key",
    fallback_env: "TAVILY_API_KEY",
    platform_fallback: true,
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
  });

  it("derives tool providers from requiresKey dep keys, keyless tools skipped", () => {
    const catalog = deriveCredentialsCatalog([], TOOLS);
    expect(Object.keys(catalog)).toEqual(["tavily"]);
    expect(catalog.tavily).toMatchObject({
      kind: "tool",
      keyName: "tavily_api_key",
      label: "Tavily",
    });
  });

  it("a provider in both catalogs keeps its first (LLM) entry", () => {
    // openai also exposes a keyed tool using the same dep-key convention.
    const catalog = deriveCredentialsCatalog(MODELS, [
      {
        name: "openai_image",
        label: "OpenAI image",
        requires_key: "openai_api_key",
        fallback_env: null,
        platform_fallback: false,
      },
    ]);
    expect(catalog.openai.kind).toBe("llm");
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

describe("prettifyProviderLabel", () => {
  it("title-cases on word boundaries", () => {
    expect(prettifyProviderLabel("openai")).toBe("Openai");
    expect(prettifyProviderLabel("tavily")).toBe("Tavily");
    expect(prettifyProviderLabel("z-ai")).toBe("Z Ai");
  });
});

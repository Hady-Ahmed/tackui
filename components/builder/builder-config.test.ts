import { describe, expect, it } from "vitest";
import {
  BUILDER_CONNECTORS_MAX,
  buildCreatePayload,
  buildEditPayload,
  buildKnowledgeUploadForm,
  buildUpdatePayload,
  catalogEmptyCopy,
  catalogErrorCopy,
  createBlockedByEmptyModels,
  extractErrorMessage,
  filterTools,
  findModel,
  groupModelsByProvider,
  groupToolsByToolkit,
  hasProcessingDocs,
  knowledgeCapabilityState,
  knowledgeDateLabel,
  knowledgeFileError,
  knowledgeHiddenCopy,
  knowledgeKeyBadge,
  knowledgeListEmptyCopy,
  knowledgeSizeLabel,
  knowledgeStatusChip,
  knowledgeTextError,
  knowledgeUrlError,
  KNOWLEDGE_MAX_UPLOAD_BYTES,
  modelKeyState,
  parseKnowledgeChunkFields,
  pickDefaultModel,
  providerForDepKeyInCatalog,
  staleModelCopy,
  sortTools,
  toolKeyState,
  validateBuilderForm,
  type BuilderFormState,
  type BuilderToolOption,
  type CredentialCatalog,
  type CredentialsState,
  type KnowledgeCapability,
  type KnowledgeDocRow,
  type ModelKeyState,
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

describe("pickDefaultModel — key-aware default", () => {
  it("returns null when no keys are connected — the select keeps its placeholder", () => {
    expect(pickDefaultModel(MODELS, {})).toBeNull();
  });

  it("defaults to the connected provider's first model in catalog order", () => {
    expect(pickDefaultModel(MODELS, { openai: true })).toEqual(MODELS[0]);
    expect(pickDefaultModel(MODELS, { anthropic: true })).toEqual(MODELS[1]);
  });

  it("picks the first connected provider in catalog order when several have keys", () => {
    expect(pickDefaultModel(MODELS, { openai: true, anthropic: true })).toEqual(MODELS[0]);
  });

  it("resolves the provider through the model's dep key, not the door slug", () => {
    const door: PlatformModel[] = [
      { provider: "openai-responses", id: "gpt-4o", platformTier: false, requiresKey: true, depKey: "openai_api_key" },
    ];
    expect(pickDefaultModel(door, { openai: true })).toEqual(door[0]);
  });

  it("skips keyed models with no declared dep key (broken catalog rows never default)", () => {
    const broken: PlatformModel[] = [
      { provider: "openai", id: "gpt-4o", platformTier: false, requiresKey: true, depKey: null },
    ];
    expect(pickDefaultModel(broken, { openai: true })).toBeNull();
  });

  it("applies the default only once the key state exists (models first, keys later)", () => {
    expect(pickDefaultModel(MODELS, {})).toBeNull();
    expect(pickDefaultModel(MODELS, { openai: true })).toEqual(MODELS[0]);
  });

  it("returns null for an empty catalog", () => {
    expect(pickDefaultModel([], { openai: true })).toBeNull();
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

  it("names the entity 'the agent builder' — never bare 'the platform' (copy rule)", () => {
    // Member-visible copy says "the agent builder". "The platform" is the
    // drift the rule exists to prevent — one reword away from a
    // member-facing "the agent platform".
    const copy = staleModelCopy({ provider: "openai", id: "gpt-4o-2024" }, MODELS, null);
    expect(copy).toContain("the agent builder");
    expect(copy).not.toMatch(/\bthe platform\b/);
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

  it("labels unknown providers with a prettified id and no connect form", () => {
    expect(
      modelKeyState({ provider: "mystery", platformTier: false, requiresKey: true, depKey: "mystery_api_key" }, credentialsState([])),
    ).toEqual({
      status: "missing",
      providerLabel: "Mystery",
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

  it("shows keyed-without-depKey as missing with no connect form (never slug-guessed)", () => {
    // A keyed model whose platform row carries no dep key is a version-skew
    // or broken-catalog case — the live platform always declares one. The
    // honest badge is "missing" with NO connect target: guessing the vendor
    // from the slug is exactly the wrong-shape the doors work removed, and
    // the run gate 402s the run regardless.
    const state = modelKeyState(
      {
        provider: "openai-responses",
        platformTier: false,
        requiresKey: true,
        depKey: null,
      },
      credentialsState([]),
    );
    if (!state || state.status !== "missing") throw new Error("expected a missing state");
    expect(state.providerLabel).toBe("OpenAI Responses");
    expect(state.provider).toBeNull();
  });

  it("falls back to a prettified slug label when the catalog is unavailable", () => {
    // No credentials state → no label and no hasKey; the vendor resolution
    // itself is pure dep-key math, so the CTA provider stays correct.
    // The fallback prettifies the door slug — a member must never see a
    // raw slug in a badge (see prettySlug).
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
    expect(state.providerLabel).toBe("OpenAI Responses"); // no catalog → prettified slug fallback
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

  it("falls back to a prettified label when the catalog doesn't know the provider", () => {
    // The raw dep key must never reach a member's eyes — the fallback
    // prettifies the toolkit slug (or, absent even that, the dep key).
    const unknown = { ...TOOLS[2], toolkit: "", requiresKey: "mystery_api_key" };
    expect(toolKeyState(unknown, credentialsState(["tavily"]))).toEqual({
      status: "missing",
      providerLabel: "Mystery API Key", // dep key prettified, never raw
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
      providerLabel: "Ghost Toolkit",
      provider: null,
    });
  });
});

describe("sortTools", () => {
  it("groups toolkit-mates and alphabetizes within each toolkit", () => {
    // Deliberately upstream-shaped: toolkits out of order, labels
    // unalphabetized within a toolkit — the AgentOS allowlist's append
    // order, not the display order.
    const shuffled: BuilderToolOption[] = [
      { ...TOOLS[2] }, // tavily — "Web search (Tavily)"
      { ...TOOLS[1], label: "List links (DuckDuckGo)" }, // duckduckgo, later label
      { ...TOOLS[3] }, // x — "Search X posts"
      { ...TOOLS[0], label: "Web search (DuckDuckGo)" }, // duckduckgo, earlier label
    ];
    const sorted = sortTools(shuffled);
    expect(sorted.map((t) => `${t.toolkit}/${t.label}`)).toEqual([
      "duckduckgo/List links (DuckDuckGo)",
      "duckduckgo/Web search (DuckDuckGo)",
      "tavily/Web search (Tavily)",
      "x/Search X posts",
    ]);
  });

  it("sorts by label within a toolkit regardless of input order", () => {
    const a: BuilderToolOption = {
      name: "z_tool", label: "Zebra tool", requiresKey: null, platformFallback: false, toolkit: "kit", credentials: [],
    };
    const b: BuilderToolOption = {
      name: "a_tool", label: "Alpha tool", requiresKey: null, platformFallback: false, toolkit: "kit", credentials: [],
    };
    expect(sortTools([a, b]).map((t) => t.label)).toEqual(["Alpha tool", "Zebra tool"]);
  });

  it("does not mutate the input array", () => {
    const input = [{ ...TOOLS[2] }, { ...TOOLS[0] }];
    const originalOrder = [...input];
    sortTools(input);
    expect(input).toEqual(originalOrder);
  });

  it("returns an empty array for an empty catalog", () => {
    expect(sortTools([])).toEqual([]);
  });
});

describe("groupToolsByToolkit", () => {
  it("groups toolkit-mates and orders toolkits alphabetically", () => {
    // Deliberately upstream-shaped: toolkits out of order, labels
    // unalphabetized within a toolkit — the AgentOS allowlist's append
    // order, not the display order.
    const shuffled: BuilderToolOption[] = [
      { ...TOOLS[2] }, // tavily — "Web search (Tavily)"
      { ...TOOLS[1], label: "News search (DuckDuckGo)" }, // duckduckgo, later label
      { ...TOOLS[3] }, // x — "Search X posts"
      { ...TOOLS[0], label: "Web search (DuckDuckGo)" }, // duckduckgo, earlier label
    ];
    const groups = groupToolsByToolkit(shuffled);
    expect(groups.map((g) => g.toolkit)).toEqual(["duckduckgo", "tavily", "x"]);
    expect(groups[0].tools.map((t) => t.name)).toEqual([
      "search_news",
      "web_search",
    ]);
    expect(groups[0].label).toBe("Duckduckgo");
    expect(groups[1].tools.map((t) => t.name)).toEqual(["tavily_search"]);
    expect(groups[2].tools.map((t) => t.name)).toEqual(["search_x"]);
  });

  it("sorts by label within a toolkit regardless of input order", () => {
    const a: BuilderToolOption = {
      name: "z_tool", label: "Zebra tool", requiresKey: null, platformFallback: false, toolkit: "kit", credentials: [],
    };
    const b: BuilderToolOption = {
      name: "a_tool", label: "Alpha tool", requiresKey: null, platformFallback: false, toolkit: "kit", credentials: [],
    };
    const groups = groupToolsByToolkit([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tools.map((t) => t.label)).toEqual(["Alpha tool", "Zebra tool"]);
  });

  it("returns an empty array for an empty catalog", () => {
    expect(groupToolsByToolkit([])).toEqual([]);
  });

  it("falls back to a degenerate group for a missing/empty toolkit slug", () => {
    // A platform shape drift — toolKeyState treats the same state as
    // degraded. The tool still renders (grouped last), it just can't
    // share a toolkit's identity.
    const orphans: BuilderToolOption[] = [
      { ...TOOLS[2], toolkit: "" }, // tavily
      { ...TOOLS[0], toolkit: "duckduckgo" },
    ];
    const groups = groupToolsByToolkit(orphans);
    expect(groups.map((g) => `${g.toolkit}:${g.label}`)).toEqual([
      "duckduckgo:Duckduckgo",
      ":Other tools",
    ]);
    expect(groups[1].tools.map((t) => t.name)).toEqual(["tavily_search"]);
  });
});

describe("filterTools", () => {
  const catalog: BuilderToolOption[] = [
    {
      name: "generate_sound_effect",
      label: "Generate sound effect",
      description: "Generate a sound effect from a text description. Args: prompt (str): What to generate.",
      requiresKey: "elevenlabs_api_key",
      platformFallback: false,
      toolkit: "elevenlabs",
      credentials: [{ depKey: "elevenlabs_api_key", label: "Elevenlabs api key" }],
    },
    {
      name: "text_to_speech",
      label: "Text to speech",
      description: "Convert text to speech. Args: prompt (str): Text to generate audio from.",
      requiresKey: "elevenlabs_api_key",
      platformFallback: false,
      toolkit: "elevenlabs",
      credentials: [{ depKey: "elevenlabs_api_key", label: "Elevenlabs api key" }],
    },
    { ...TOOLS[0] }, // keyless DuckDuckGo search — no description on the fixture
  ];

  it("matches the label case-insensitively", () => {
    expect(filterTools(catalog, "SOUND EFFECT").map((t) => t.name)).toEqual([
      "generate_sound_effect",
    ]);
  });

  it("matches the description (so arg-name searches hit too)", () => {
    expect(filterTools(catalog, "convert text to speech")).toHaveLength(1);
    expect(filterTools(catalog, "prompt (str)").map((t) => t.name)).toEqual([
      "generate_sound_effect",
      "text_to_speech",
    ]);
  });

  it("matches the toolkit slug — a toolkit search surfaces all its tools", () => {
    // Searching "github" should surface the toolkit even though the
    // individual tool labels are like "Create an issue" (the grouped
    // palette's search spans both levels).
    expect(filterTools(catalog, "elevenlabs").map((t) => t.name)).toEqual([
      "generate_sound_effect",
      "text_to_speech",
    ]);
  });

  it("matches the toolkit's pretty label", () => {
    expect(filterTools(catalog, "Elevenlabs").map((t) => t.name)).toEqual([
      "generate_sound_effect",
      "text_to_speech",
    ]);
  });

  it("is whitespace-insensitive: an all-space query matches everything", () => {
    expect(filterTools(catalog, "   ")).toBe(catalog);
  });

  it("returns the input unchanged for an empty query", () => {
    expect(filterTools(catalog, "")).toBe(catalog);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterTools(catalog, "elevenlabs-piano")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const snapshot = catalog.map((t) => t.name);
    filterTools(catalog, "sound");
    expect(catalog.map((t) => t.name)).toEqual(snapshot);
  });
});

/**
 * The composed pipeline the builder form renders —
 * `groupToolsByToolkit(filterTools(tools, query))`. Regression pin for
 * #187: a group's tools are the FILTERED subset, so the toolkit
 * checkbox's select-all (which maps `group.tools`) can only ever touch
 * the tools the filter shows — checking a toolkit under an active
 * filter cannot select tools the search hides. A refactor that made
 * groups hold the full toolkit while filtering only the rendered rows
 * would silently reintroduce that hidden-selection surprise.
 */
describe("toolkit select-all under an active filter", () => {
  const gh = (name: string, label: string): BuilderToolOption => ({
    name,
    label,
    requiresKey: null,
    platformFallback: false,
    toolkit: "github",
    credentials: [],
  });
  const catalog: BuilderToolOption[] = [
    gh("gh_create_issue", "Create an issue"),
    gh("gh_list_issues", "List issues"),
    gh("gh_get_issue", "Get an issue"),
    gh("gh_create_repository", "Create a repository"),
    gh("gh_get_repository", "Get a repository"),
    gh("gh_list_repositories", "List repositories"),
    gh("gh_create_pull", "Create a pull request"),
    gh("gh_merge_pull", "Merge a pull request"),
    gh("gh_star_repository", "Star a repository"),
    gh("gh_fork_repository", "Fork a repository"),
  ];

  it("checking a toolkit under a filter selects only the visible tools", () => {
    const groups = groupToolsByToolkit(filterTools(catalog, "issue"));
    const github = groups.find((g) => g.toolkit === "github");
    // The names toggleToolkit maps over — exactly the matching subset,
    // never the toolkit's hidden members.
    expect(github?.tools.map((t) => t.name)).toEqual([
      "gh_create_issue",
      "gh_get_issue",
      "gh_list_issues",
    ]);
  });

  it("the header count reads the filtered subset, not the full toolkit", () => {
    const groups = groupToolsByToolkit(filterTools(catalog, "issue"));
    const github = groups.find((g) => g.toolkit === "github");
    expect(github?.tools).toHaveLength(3);
    expect(catalog).toHaveLength(10);
  });

  it("a toolkit-slug filter shows the whole toolkit, so select-all still attaches all of it", () => {
    const groups = groupToolsByToolkit(filterTools(catalog, "github"));
    const github = groups.find((g) => g.toolkit === "github");
    expect(github?.tools).toHaveLength(10);
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

describe("buildEditPayload", () => {
  it("sends a FULL config when the row has no snapshot (original = null) — even with zero edits", () => {
    // The stale-snapshot recovery pin: the run gate 402s snapshot-less
    // rows with "open it in the agent builder and save it again". That
    // remedy only works if a zero-edit save still produces a complete
    // PATCH body (model + tools + connectors) — the server 409s anything
    // partial, and a diff that happened to include one tool would
    // silently destroy the agent's real tool set.
    const untouchedForm = { ...validForm }; // exactly what the prefill produces
    expect(buildEditPayload(untouchedForm, null)).toEqual({
      name: validForm.name,
      description: validForm.description,
      instructions: validForm.instructions,
      model: validForm.model,
      tools: validForm.tools.map((name) => ({ name })),
      connectors: validForm.connectors,
    });
  });

  it("still diffs against the original when a snapshot exists", () => {
    expect(buildEditPayload({ ...validForm, name: "Renamed" }, validForm)).toEqual({
      name: "Renamed",
      instructions: validForm.instructions,
    });
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

describe("catalogErrorCopy — the disabled-builder banner", () => {
  it("joins two genuinely distinct catalog errors with the separator", () => {
    expect(catalogErrorCopy("Models catalog returned 503", "Tools catalog returned 502")).toBe(
      "Models catalog returned 503 · Tools catalog returned 502",
    );
  });

  it("collapses the identical message both catalog loads fail with", () => {
    // One shared 503 from agentosRequest sets BOTH state slots to the
    // same AgentosError message — the banner must render it once.
    const message = "The agent builder isn't enabled on this deployment.";
    expect(catalogErrorCopy(message, message)).toBe(message);
  });

  it("keeps only the failing side when a single catalog fails", () => {
    expect(catalogErrorCopy("Models catalog returned 503", null)).toBe(
      "Models catalog returned 503",
    );
    expect(catalogErrorCopy(null, "Tools catalog returned 502")).toBe(
      "Tools catalog returned 502",
    );
  });

  it("returns null when nothing failed", () => {
    expect(catalogErrorCopy(null, null)).toBeNull();
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

/* ---------------------------------------------------------------------- */
/* Knowledge — the corpus section's pure logic (#236)                      */
/* ---------------------------------------------------------------------- */

const KNOWLEDGE_ENABLED: KnowledgeCapability = {
  enabled: true,
  provider: "openai",
  model: "text-embedding-3-small",
};
const KNOWLEDGE_DISABLED: KnowledgeCapability = {
  enabled: false,
  provider: "openai",
  model: "text-embedding-3-small",
};
const KNOWLEDGE_UNSUPPORTED: KnowledgeCapability = {
  enabled: false,
  provider: "",
  model: "",
  unsupported: true,
};

const docRow = (overrides: Partial<KnowledgeDocRow> = {}): KnowledgeDocRow => ({
  id: "row-1",
  name: "Handbook.pdf",
  status: "completed",
  size: 1536,
  createdAt: 1764000000,
  updatedAt: 1764000000,
  ...overrides,
});

describe("knowledgeCapabilityState — the section's gate", () => {
  it("loading while the capability fetch is in flight", () => {
    expect(knowledgeCapabilityState(null, null)).toEqual({ kind: "loading" });
  });

  it("unreachable on a fetch failure — never read as 'knowledge is off'", () => {
    const state = knowledgeCapabilityState(null, "Couldn't reach the server");
    expect(state).toEqual({ kind: "unreachable", error: "Couldn't reach the server" });
    // An error beats a stale capability — the banner wins.
    expect(knowledgeCapabilityState(KNOWLEDGE_ENABLED, "boom")).toEqual({
      kind: "unreachable",
      error: "boom",
    });
  });

  it("hidden when the service answers with knowledge off (enabled=false)", () => {
    expect(knowledgeCapabilityState(KNOWLEDGE_DISABLED, null)).toEqual({
      kind: "hidden",
      reason: "disabled",
    });
  });

  it("hidden with the unsupported reason when the deployment predates knowledge", () => {
    expect(knowledgeCapabilityState(KNOWLEDGE_UNSUPPORTED, null)).toEqual({
      kind: "hidden",
      reason: "unsupported",
    });
  });

  it("available when enabled — carrying the embedding contract", () => {
    expect(knowledgeCapabilityState(KNOWLEDGE_ENABLED, null)).toEqual({
      kind: "available",
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });
});

describe("knowledgeHiddenCopy — the hidden section's one-liner", () => {
  it("gives a plain explanation for both reasons, never possessive", () => {
    for (const reason of ["disabled", "unsupported"] as const) {
      const copy = knowledgeHiddenCopy(reason);
      expect(copy.toLowerCase()).not.toContain("your ");
      expect(copy.toLowerCase()).toContain("knowledge");
    }
  });

  it("names the agent builder, never a bare 'platform'", () => {
    expect(knowledgeHiddenCopy("unsupported")).toContain("agent builder");
  });
});

describe("knowledgeListEmptyCopy", () => {
  it("copy on an empty, successfully loaded list", () => {
    expect(knowledgeListEmptyCopy([], null)).not.toBeNull();
  });

  it("null while loading, populated, or on fetch failure", () => {
    expect(knowledgeListEmptyCopy(null, null)).toBeNull();
    expect(knowledgeListEmptyCopy([docRow()], null)).toBeNull();
    expect(knowledgeListEmptyCopy([], "boom")).toBeNull();
  });
});

describe("knowledgeStatusChip — agno's ContentStatus values", () => {
  it("maps processing / completed→Ready / partial / failed", () => {
    expect(knowledgeStatusChip("processing")).toMatchObject({ label: "Processing" });
    expect(knowledgeStatusChip("completed")).toMatchObject({ label: "Ready" });
    expect(knowledgeStatusChip("partial")).toMatchObject({ label: "Partial" });
    expect(knowledgeStatusChip("failed")).toMatchObject({ label: "Failed" });
  });

  it("gives Ready the settled-green class and Partial its own amber (never a false Ready)", () => {
    expect(knowledgeStatusChip("completed")!.className).toContain("green");
    expect(knowledgeStatusChip("partial")!.className).toContain("amber");
  });

  it("no chip for null (a row predating a status write) or an unknown value", () => {
    expect(knowledgeStatusChip(null)).toBeNull();
    expect(knowledgeStatusChip("mysterious")).toBeNull();
  });
});

describe("hasProcessingDocs — the poll gate", () => {
  it("true only while a row is processing", () => {
    expect(hasProcessingDocs([docRow({ status: "processing" })])).toBe(true);
  });

  it("false on settled rows (completed, partial, failed, null) and the empty list", () => {
    // partial and failed never change without a re-upload — polling
    // forever on them would never stop.
    expect(hasProcessingDocs([])).toBe(false);
    expect(hasProcessingDocs([docRow({ status: "completed" })])).toBe(false);
    expect(hasProcessingDocs([docRow({ status: "partial" })])).toBe(false);
    expect(hasProcessingDocs([docRow({ status: "failed" })])).toBe(false);
    expect(hasProcessingDocs([docRow({ status: null })])).toBe(false);
  });
});

describe("knowledgeSizeLabel / knowledgeDateLabel", () => {
  it("formats bytes, KB and MB; null stays null", () => {
    expect(knowledgeSizeLabel(null)).toBeNull();
    expect(knowledgeSizeLabel(512)).toBe("512 B");
    expect(knowledgeSizeLabel(1536)).toBe("1.5 KB");
    expect(knowledgeSizeLabel(10240)).toBe("10 KB");
    expect(knowledgeSizeLabel(2_621_440)).toBe("2.5 MB");
  });

  it("refuses nonsense (negative)", () => {
    expect(knowledgeSizeLabel(-5)).toBeNull();
  });

  it("dates format from epoch seconds", () => {
    expect(knowledgeDateLabel(1764000000)).toBe(
      new Date(1764000000 * 1000).toLocaleDateString(),
    );
  });
});

describe("knowledgeFileError / knowledgeTextError / knowledgeUrlError", () => {
  it("rejects an unsupported extension, naming the file and the accepted set", () => {
    const file = new File(["x"], "virus.exe");
    const error = knowledgeFileError(file);
    expect(error).toContain("virus.exe");
    expect(error).toContain(".pdf");
  });

  it("rejects an oversized file with the MB cap", () => {
    const file = new File([new ArrayBuffer(11)], "big.pdf");
    Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
    expect(knowledgeFileError(file)).toContain("10 MB");
  });

  it("accepts an in-cap, allowed file", () => {
    const file = new File(["x"], "notes.md");
    Object.defineProperty(file, "size", { value: 12 });
    expect(knowledgeFileError(file)).toBeNull();
  });

  it("paste-text: empty rejected, in-cap accepted, oversize rejected", () => {
    expect(knowledgeTextError("   ")).not.toBeNull();
    expect(knowledgeTextError("hello")).toBeNull();
    const big = "x".repeat(KNOWLEDGE_MAX_UPLOAD_BYTES + 1);
    expect(knowledgeTextError(big)).toContain("10 MB");
  });

  it("url: blank, relative, and non-http schemes rejected; http(s) accepted", () => {
    expect(knowledgeUrlError("")).not.toBeNull();
    expect(knowledgeUrlError("not-a-url")).not.toBeNull();
    expect(knowledgeUrlError("ftp://example.com/x")).toContain("http");
    expect(knowledgeUrlError("https://example.com/doc")).toBeNull();
    expect(knowledgeUrlError("http://example.com/doc")).toBeNull();
  });
});

describe("parseKnowledgeChunkFields — blank = omitted (agno's own defaults)", () => {
  it("omits both when blank — no invented defaults", () => {
    expect(parseKnowledgeChunkFields("", "")).toEqual({ ok: true });
  });

  it("parses integers; junk and out-of-range rejected", () => {
    expect(parseKnowledgeChunkFields("500", "0")).toEqual({ ok: true, chunkSize: 500, chunkOverlap: 0 });
    expect(parseKnowledgeChunkFields("500.5", "")).toEqual({
      ok: false,
      error: "Chunk size must be a whole number.",
    });
    expect(parseKnowledgeChunkFields("0", "")).toEqual({
      ok: false,
      error: "Chunk size must be at least 1.",
    });
    expect(parseKnowledgeChunkFields("", "-1")).toEqual({
      ok: false,
      error: "Chunk overlap must be 0 or more.",
    });
  });

  it("enforces overlap < size (mirrors the route)", () => {
    expect(parseKnowledgeChunkFields("500", "500")).toEqual({
      ok: false,
      error: "Chunk overlap must be smaller than chunk size.",
    });
    expect(parseKnowledgeChunkFields("500", "600")).toEqual({
      ok: false,
      error: "Chunk overlap must be smaller than chunk size.",
    });
  });
});

describe("buildKnowledgeUploadForm — the multipart payload shapes", () => {
  it("file source: exactly the file field (plus optional chunk fields)", () => {
    const file = new File(["x"], "notes.md");
    const bare = buildKnowledgeUploadForm({ kind: "file", file });
    // FormData clones stored values — compare structurally.
    expect(bare.get("file")).toStrictEqual(file);
    expect(bare.get("text")).toBeNull();
    expect(bare.get("url")).toBeNull();
    expect(bare.get("name")).toBeNull();

    const chunked = buildKnowledgeUploadForm(
      { kind: "file", file },
      { chunkSize: 500, chunkOverlap: 0 },
    );
    // camelCase — the tackui route re-shapes them service-side.
    expect(chunked.get("chunkSize")).toBe("500");
    expect(chunked.get("chunkOverlap")).toBe("0");
  });

  it("text source: text + name; url source: url only", () => {
    const text = buildKnowledgeUploadForm(
      { kind: "text", text: "hello", name: "Pasted notes" },
      { chunkSize: 500 },
    );
    expect(text.get("text")).toBe("hello");
    expect(text.get("name")).toBe("Pasted notes");
    expect(text.get("file")).toBeNull();
    expect(text.get("chunkSize")).toBe("500");

    const url = buildKnowledgeUploadForm({ kind: "url", url: "https://example.com" });
    expect(url.get("url")).toBe("https://example.com");
    expect(url.get("file")).toBeNull();
    expect(url.get("text")).toBeNull();
  });

  it("never carries an embedding key — the author's key is resolved server-side", () => {
    const form = buildKnowledgeUploadForm({ kind: "text", text: "x", name: "n" });
    for (const key of form.keys()) {
      expect(key.toLowerCase()).not.toContain("key");
    }
  });
});

describe("knowledgeKeyBadge — the section header's badge, deduped", () => {
  const creds = (providers: string[]): CredentialsState => ({
    hasKey: Object.fromEntries(providers.map((p) => [p, true])),
    catalog: CATALOG,
  });
  const missingModel = (provider: string): ModelKeyState => ({
    status: "missing",
    providerLabel: "Whatever",
    provider,
  });

  it("connected + docs → the green 'runs on' chip", () => {
    expect(
      knowledgeKeyBadge([docRow()], "openai", creds(["openai"]), null),
    ).toMatchObject({ show: true, connected: true, providerLabel: "Openai" });
  });

  it("connected + no docs → nothing (nothing uses the key yet)", () => {
    expect(knowledgeKeyBadge([], "openai", creds(["openai"]), null)).toMatchObject({
      show: false,
      connected: true,
    });
  });

  it("missing key → the demand + Connect, even with an empty corpus (uploads need it too)", () => {
    expect(knowledgeKeyBadge([], "openai", creds([]), null)).toMatchObject({
      show: true,
      connected: false,
      provider: "openai",
    });
    expect(knowledgeKeyBadge([docRow()], "openai", creds([]), null)).toMatchObject({
      show: true,
      connected: false,
    });
  });

  it("DEDUPE: the model badge already demanding the same provider's key hides this one (one line, not two)", () => {
    expect(
      knowledgeKeyBadge([docRow()], "openai", creds([]), missingModel("openai")),
    ).toMatchObject({ show: false });
  });

  it("a different provider's model badge does NOT suppress it (per-need display)", () => {
    expect(
      knowledgeKeyBadge([docRow()], "openai", creds([]), missingModel("openrouter")),
    ).toMatchObject({ show: true, connected: false });
  });

  it("a provider the catalog doesn't know gets a prettified label and NO connect flow", () => {
    const badge = knowledgeKeyBadge([docRow()], "weirdo", creds([]), null);
    expect(badge).toMatchObject({ show: true, connected: false, provider: null, providerLabel: "Weirdo" });
  });
});


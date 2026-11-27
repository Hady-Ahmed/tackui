// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { BuilderForm } from "./builder-form";
import type {
  CredentialCatalog,
  CredentialsState,
  KnowledgeCapability,
  KnowledgeDocRow,
  PlatformModel,
} from "./builder-config";
import type { PublicAgent } from "@/lib/agents/agents.config";

/**
 * Component-level wiring of the key-aware defaulting effect
 * (builder-form.tsx "The key-aware default (create mode)"). The pure
 * `pickDefaultModel` cases live in builder-config.test.ts — this file
 * exercises what a pure-function call cannot: the effect's actual keying
 * on the (mode, models, credentials) props across rerenders, the
 * `prev.model ? prev` guard that protects user selections, and the
 * edit-mode skip.
 *
 * The component's data hooks (session/auth config/can-manage/billing) are
 * mocked at the module boundary — the effect under test depends only on
 * the (mode, models, credentials) props, and solo mode (`authDisabled`)
 * renders the full form without a session. next/link and the upgrade
 * dialog are stubbed so no Next runtime or billing client is needed.
 *
 * This file doubles as the repo's component-test template: jsdom via the
 * per-file `@vitest-environment` directive (node suites stay untouched),
 * RTL cleanup in afterEach (vitest's `globals: false` disables RTL's
 * auto-cleanup), and module-boundary mocks for the page-data hooks.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/upgrade-dialog", () => ({
  UpgradeDialog: () => null,
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
}));

vi.mock("@/lib/auth/use-auth-config", () => ({
  useAuthConfig: () => ({
    config: {
      emailAndPassword: false,
      social: [],
      oidc: false,
      authDisabled: true,
      emailVerification: false,
      user: { id: "user-1", name: "Solo admin", role: "admin" },
    },
    loading: false,
  }),
}));

vi.mock("@/lib/auth/use-can-manage-agents", () => ({
  useCanManageAgents: () => ({ canManage: true, loading: false }),
}));

vi.mock("@/lib/billing/use-billing", () => ({
  useBilling: () => ({ billing: null, loading: false }),
}));

const MODELS: PlatformModel[] = [
  { provider: "openai", id: "gpt-4o-mini", platformTier: false, requiresKey: true, depKey: "openai_api_key" },
  { provider: "anthropic", id: "claude-3-5-sonnet", platformTier: false, requiresKey: true, depKey: "anthropic_api_key" },
  { provider: "openai", id: "gpt-4o", platformTier: false, requiresKey: true, depKey: "openai_api_key" },
];

const CATALOG: CredentialCatalog = {
  openai: {
    kind: "llm",
    keyName: "openai_api_key",
    label: "OpenAI",
    fields: [{ key: "api_key", label: "Api key" }],
  },
  anthropic: {
    kind: "llm",
    keyName: "anthropic_api_key",
    label: "Anthropic",
    fields: [{ key: "api_key", label: "Api key" }],
  },
};

// A fresh object per call — the parent passes a NEW credentials state
// after refreshCredentials, and the effect must re-run on that identity.
const credentialsWith = (providers: string[]): CredentialsState => ({
  hasKey: Object.fromEntries(providers.map((p) => [p, true])),
  catalog: CATALOG,
});

type BuilderFormProps = Parameters<typeof BuilderForm>[0];

function builderProps(
  overrides: Partial<BuilderFormProps> = {},
): BuilderFormProps {
  return {
    mode: "create",
    models: MODELS,
    modelsError: null,
    tools: null,
    toolsError: null,
    retryCatalogs: async () => {},
    credentials: credentialsWith([]),
    refreshCredentials: async () => {},
    connectors: null,
    connectorsError: null,
    retryConnectors: async () => {},
    onSaved: () => {},
    onCancel: () => {},
    ...overrides,
  };
}

const providerSelect = () =>
  screen.getByLabelText(/^Provider/) as HTMLSelectElement;
const modelSelect = () => screen.getByLabelText(/^Model/) as HTMLSelectElement;

describe("BuilderForm — the key-aware defaulting effect (component wiring)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("no keys connected → the default never applies, the select keeps its placeholder", () => {
    render(<BuilderForm {...builderProps()} />);
    expect(providerSelect().value).toBe("");
    expect(modelSelect().value).toBe("");
  });

  it("credentials arrive after the models → the default applies once both exist", async () => {
    const view = render(<BuilderForm {...builderProps()} />);
    expect(providerSelect().value).toBe("");

    view.rerender(
      <BuilderForm
        {...builderProps({ credentials: credentialsWith(["openai"]) })}
      />,
    );
    await waitFor(() => expect(providerSelect().value).toBe("openai"));
    expect(modelSelect().value).toBe("gpt-4o-mini");
  });

  it("models arrive after the credentials → the default applies once both exist", async () => {
    const view = render(
      <BuilderForm
        {...builderProps({
          models: null,
          credentials: credentialsWith(["openai"]),
        })}
      />,
    );
    expect(providerSelect().value).toBe("");

    view.rerender(
      <BuilderForm
        {...builderProps({
          models: MODELS,
          credentials: credentialsWith(["openai"]),
        })}
      />,
    );
    await waitFor(() => expect(providerSelect().value).toBe("openai"));
    expect(modelSelect().value).toBe("gpt-4o-mini");
  });

  it("a user-selected model survives a credentials re-run (prev.model guard)", async () => {
    const view = render(
      <BuilderForm
        {...builderProps({ credentials: credentialsWith(["openai"]) })}
      />,
    );
    await waitFor(() => expect(providerSelect().value).toBe("openai"));

    fireEvent.change(providerSelect(), { target: { value: "anthropic" } });
    expect(modelSelect().value).toBe("claude-3-5-sonnet");

    view.rerender(
      <BuilderForm
        {...builderProps({
          credentials: credentialsWith(["openai", "anthropic"]),
        })}
      />,
    );
    expect(providerSelect().value).toBe("anthropic");
    expect(modelSelect().value).toBe("claude-3-5-sonnet");
  });

  it("edit mode: the snapshot prefill wins and the default never overrides it", async () => {
    const agent: PublicAgent = {
      id: "b1",
      name: "Claude agent",
      description: "",
      orgId: "o1",
      authMode: "jwt",
      hasJwtSecret: false,
      jwtSecretStatus: "none",
      origin: "builder",
      authorUserId: "user-1",
      instructions: "Be helpful.",
      requirements: {
        model: {
          provider: "anthropic",
          id: "claude-3-5-sonnet",
          platformTier: false,
          requiresKey: true,
          depKey: "anthropic_api_key",
          name: "Anthropic",
        },
        tools: [],
        connectors: [],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => agent })),
    );

    render(
      <BuilderForm
        {...builderProps({
          mode: "edit",
          agentId: "b1",
          credentials: credentialsWith(["openai"]),
        })}
      />,
    );
    await screen.findByLabelText(/^Provider/);
    expect(providerSelect().value).toBe("anthropic");
    expect(modelSelect().value).toBe("claude-3-5-sonnet");
  });

  it("edit mode: no snapshot (stale) → nothing is defaulted, the placeholder stays", async () => {
    const agent: PublicAgent = {
      id: "b2",
      name: "Stale agent",
      description: "",
      orgId: "o1",
      authMode: "jwt",
      hasJwtSecret: false,
      jwtSecretStatus: "none",
      origin: "builder",
      authorUserId: "user-1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => agent })),
    );

    const view = render(
      <BuilderForm
        {...builderProps({
          mode: "edit",
          agentId: "b2",
          credentials: credentialsWith(["openai"]),
        })}
      />,
    );
    await screen.findByText(/saved by an older version of the agent builder/);
    expect(providerSelect().value).toBe("");
    expect(modelSelect().value).toBe("");

    // Connecting a key inside the edit form refreshes the page's
    // credentials state (a new object identity re-runs the effect) —
    // edit mode must still never fill the empty model.
    view.rerender(
      <BuilderForm
        {...builderProps({
          mode: "edit",
          agentId: "b2",
          credentials: credentialsWith(["openai", "anthropic"]),
        })}
      />,
    );
    expect(providerSelect().value).toBe("");
    expect(modelSelect().value).toBe("");
  });
});

/* ---------------------------------------------------------------------- */
/* Knowledge section (#236) — capability gating, polling, delete, badge.   */
/* The pure-logic cases live in builder-config.test.ts; this file covers   */
/* what a pure function can't: the fetch wiring per capability state, the  */
/* poll loop's start/stop, the confirm gate, and the detach-retry flow.    */
/* ---------------------------------------------------------------------- */

const KB_AGENT: PublicAgent = {
  id: "b9",
  name: "Knowledge agent",
  description: "",
  orgId: "o1",
  authMode: "jwt",
  hasJwtSecret: false,
  jwtSecretStatus: "none",
  origin: "builder",
  authorUserId: "user-1",
  instructions: "Use the corpus.",
  requirements: {
    model: {
      provider: "anthropic",
      id: "claude-3-5-sonnet",
      platformTier: false,
      requiresKey: true,
      depKey: "anthropic_api_key",
      name: "Anthropic",
    },
    tools: [],
    connectors: [],
  },
};

const KB_ENABLED: KnowledgeCapability = {
  enabled: true,
  provider: "openai",
  model: "text-embedding-3-small",
};

const KB_POLL_MS = 5000; // mirrors KNOWLEDGE_POLL_MS (the section's poll cadence)

const kbRow = (overrides: Partial<KnowledgeDocRow> = {}): KnowledgeDocRow => ({
  id: "row-1",
  name: "Handbook.pdf",
  status: "completed",
  size: 1536,
  createdAt: 1764000000,
  updatedAt: 1764000000,
  ...overrides,
});

type KbFetchOptions = {
  capability?: KnowledgeCapability | { error: string; status?: number };
  list?: () => KnowledgeDocRow[];
  deleteResult?: { ok: boolean; status: number; body: unknown };
  /** The DELETE rejects after `onDelete` fired — the lost response after
   *  the delete landed (a network blip), the list-truth catch path. */
  deleteThrows?: boolean;
  onDelete?: () => void;
  /** POST /knowledge results consumed per call (a batch walks the array). */
  postResults?: Array<{ ok: boolean; status: number; body: unknown }>;
};

/**
 * A URL-dispatching fetch stub for the edit-mode knowledge loads: the
 * agent GET, the capability proxy, the doc list, the content DELETE, and
 * (via `postResults`) POST uploads. Unguarded POSTs 500 loudly — only
 * tests that pass `postResults` upload.
 */
function stubKnowledgeFetch(options: KbFetchOptions) {
  const deleteCalls: string[] = [];
  const postCalls: number[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const jsonRes = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    if (url.endsWith("/knowledge/config")) {
      const cap = options.capability ?? KB_ENABLED;
      return "error" in cap
        ? jsonRes({ error: cap.error }, cap.status ?? 502)
        : jsonRes(cap);
    }
    if (url.endsWith("/knowledge") && method === "GET") {
      const rows = options.list?.() ?? [];
      return jsonRes(rows);
    }
    if (url.includes("/knowledge/") && method === "DELETE") {
      deleteCalls.push(url);
      options.onDelete?.();
      if (options.deleteThrows) throw new TypeError("network blip after the delete reached the server");
      const result = options.deleteResult ?? { ok: true, status: 200, body: { ok: true } };
      return jsonRes(result.body, result.status);
    }
    if (url.endsWith("/knowledge") && method === "POST") {
      postCalls.push(postCalls.length);
      const result = options.postResults?.[postCalls.length - 1];
      if (result) return jsonRes(result.body, result.status);
      return jsonRes({ error: "unexpected POST in this test" }, 500);
    }
    if (url.endsWith("/api/agents/b9")) {
      return jsonRes(KB_AGENT);
    }
    return jsonRes({ error: `unrouted fetch: ${method} ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, deleteCalls, postCalls };
}

function editProps(overrides: Partial<BuilderFormProps> = {}): BuilderFormProps {
  return builderProps({
    mode: "edit",
    agentId: "b9",
    credentials: credentialsWith([]),
    ...overrides,
  });
}

describe("BuilderForm — the Knowledge section", () => {
  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => false));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("create mode: the knowledge preview is visible before saving — header, the three sources, and the save-first note", async () => {
    // The discovery gap (#259): a one-line note below the form didn't
    // register — first-time builders were never shown that knowledge
    // exists. Create mode now renders the section as an inert preview:
    // the same header and upload rows the edit section carries, so the
    // capability is visible where it will live after the save.
    const { fetchMock } = stubKnowledgeFetch({});
    render(
      <BuilderForm
        {...builderProps({ mode: "create", agentId: undefined })}
      />,
    );
    expect(screen.getByText("Knowledge")).toBeTruthy();
    await screen.findByText(/Save the agent first, then add documents it can search/);
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("Choose files…")).toBeTruthy();
    expect(screen.getByText("Paste text")).toBeTruthy();
    expect(screen.getByText("Web page")).toBeTruthy();
    // The preview is the affordance, not the live section — no Advanced
    // disclosure (chunk tuning is an edit-mode concern), no doc rows.
    expect(screen.queryByText("Advanced — chunk size and overlap")).toBeNull();
    expect(screen.queryByText("Handbook.pdf")).toBeNull();
    // The preview is static — no capability or corpus fetch in create
    // mode (docs attach to a SAVED component's corpus).
    const knowledgeFetches = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/knowledge"),
    );
    expect(knowledgeFetches).toHaveLength(0);
  });

  it("create mode: every preview control is disabled and nothing is wired (clicks make no calls)", async () => {
    // Inert-but-real, not clickable-and-broken: the same controls the
    // edit section carries, all genuinely disabled, and no handlers —
    // interacting with the preview fires nothing.
    const { fetchMock } = stubKnowledgeFetch({});
    render(
      <BuilderForm
        {...builderProps({ mode: "create", agentId: undefined })}
      />,
    );
    await screen.findByText(/Save the agent first/);
    expect((screen.getByLabelText("Upload files") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByLabelText("Pasted text document name") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Paste text to add as a document") as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Page URL to add as a document") as HTMLInputElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Add text" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Add URL" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByText("Choose files…"));
    fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it("capability available: the section renders with the doc list rows", async () => {
    stubKnowledgeFetch({ list: () => [kbRow()] });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Handbook.pdf");
    expect(screen.getByText("Ready")).toBeTruthy();
    // Key connected? Not yet — the header shows the demand (no model
    // badge covers OpenAI — the model is Anthropic).
    expect(screen.getByText(/Needs your OpenAI key/)).toBeTruthy();
  });

  it("capability hidden: a one-line explanation, no upload surface", async () => {
    stubKnowledgeFetch({
      capability: { enabled: false, provider: "openai", model: "x" },
    });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText(/Knowledge isn't offered on this deployment/);
    expect(screen.queryByLabelText("Upload files")).toBeNull();
  });

  it("capability unreachable: the error banner with Retry, never an 'off' claim", async () => {
    stubKnowledgeFetch({
      capability: { error: "The agent builder is unavailable right now." },
    });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText(/The agent builder is unavailable right now/);
    expect(screen.queryByLabelText("Upload files")).toBeNull();
  });

  it("the connect shortcut opens the KeyForm (the existing inline pattern)", async () => {
    stubKnowledgeFetch({ list: () => [kbRow()] });
    render(<BuilderForm {...editProps()} />);
    // The MODEL badge also offers a connect shortcut (the Anthropic key is
    // missing too) — scope to the knowledge badge's own demand line.
    await screen.findByText(/Needs your OpenAI key/);
    const badge = screen.getByText(/Needs your OpenAI key/);
    fireEvent.click(within(badge).getByText("connect one"));
    await screen.findByText(/Connect a OpenAI key/);
  });

  it("key connected + docs: the green chip, no demand line", async () => {
    stubKnowledgeFetch({ list: () => [kbRow()] });
    render(<BuilderForm {...editProps({ credentials: credentialsWith(["openai"]) })} />);
    await screen.findByText("Handbook.pdf");
    expect(screen.getByText(/Runs on your OpenAI key/)).toBeTruthy();
    expect(screen.queryByText(/Needs your OpenAI key/)).toBeNull();
  });

  it("polls the list while a row is processing and stops once settled", async () => {
    vi.useFakeTimers();
    let listCalls = 0;
    let current: KnowledgeDocRow[] = [kbRow({ status: "processing" })];
    stubKnowledgeFetch({
      list: () => {
        listCalls += 1;
        return current;
      },
    });
    render(<BuilderForm {...editProps()} />);
    // Flush the initial load chain (agent + capability + list + the
    // setState → poll-effect mount → immediate tick): each hop is an
    // await boundary, so several small flushes are needed.
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1);
    const afterLoad = listCalls;
    expect(afterLoad).toBeGreaterThanOrEqual(2);
    // While processing: the interval keeps polling.
    await vi.advanceTimersByTimeAsync(KB_POLL_MS * 2.2);
    expect(listCalls).toBeGreaterThan(afterLoad);
    // Settled: the next poll observes it, the effect tears the interval
    // down, and nothing polls after.
    current = [kbRow({ status: "completed" })];
    await vi.advanceTimersByTimeAsync(KB_POLL_MS * 1.2);
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1);
    const afterSettleSeen = listCalls;
    await vi.advanceTimersByTimeAsync(KB_POLL_MS * 2.2);
    expect(listCalls).toBe(afterSettleSeen);
  });

  it("delete: confirm gates the DELETE; confirming deletes and refetches", async () => {
    const { fetchMock, deleteCalls } = stubKnowledgeFetch({ list: () => [kbRow()] });
    const confirmFn = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmFn);
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Handbook.pdf");
    // confirm = false — no DELETE fires.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    expect(deleteCalls).toHaveLength(0);

    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteCalls).toHaveLength(1));
    expect(deleteCalls[0]).toContain("/knowledge/row-1");
    // The list re-fetches after the delete (the truth about "last doc").
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          (c) => String(c[0]).endsWith("/knowledge") && (c[1]?.method ?? "GET") === "GET",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("a landed delete with a failed detach: the notice appears and Retry re-fires the delete", async () => {
    // The 502-after-landed-delete case (#235's review note): the delete
    // DID land — only the detach publish failed. The list is the truth:
    // the row vanishes, the notice appears, and Retry re-fires the
    // idempotent delete to finish the detach.
    let deleted = false;
    const { deleteCalls } = stubKnowledgeFetch({
      list: () => (deleted ? [] : [kbRow()]),
      deleteResult: {
        ok: false,
        status: 502,
        body: { error: "The agent builder is unavailable right now — please try again shortly." },
      },
      onDelete: () => {
        deleted = true;
      },
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Handbook.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // The row is gone AND the retry-safe notice is up — amber alone (a
    // red error would frame a good outcome as a failure).
    await screen.findByText(/The document was removed, but finishing/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Handbook.pdf")).toBeNull();
    // Retry re-fires the DELETE (idempotent) without a confirm.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(deleteCalls).toHaveLength(2));
  });

  it("a lost delete response settles from the list truth: amber notice only, no re-confirm", async () => {
    // The delete REACHED the server, then the response was lost (network
    // blip): onDelete fires, then the fetch rejects. The catch path
    // re-fetches the list as truth — the vanished row raises the amber
    // retry notice ALONE (a red error would frame a good outcome as a
    // failure), and the retry needs no confirm.
    let deleted = false;
    const { deleteCalls } = stubKnowledgeFetch({
      list: () => (deleted ? [] : [kbRow()]),
      deleteThrows: true,
      onDelete: () => {
        deleted = true;
      },
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Handbook.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText(/The document was removed, but finishing/);
    expect(screen.queryByText(/deleting again is safe/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(deleteCalls).toHaveLength(2));
  });

  it("a landed upload schedules one delayed re-fetch (the row insert races the 202)", async () => {
    // The service writes the contents row AFTER the 202 — the immediate
    // list load can see no new row, and with no OTHER row processing the
    // poll never engages. The delayed re-fetch closes that gap.
    vi.useFakeTimers();
    let listCalls = 0;
    stubKnowledgeFetch({
      list: () => {
        listCalls += 1;
        return [];
      },
      postResults: [{ ok: true, status: 202, body: { id: "c1", name: "d", status: "processing" } }],
    });
    render(<BuilderForm {...editProps()} />);
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1);
    const afterInitialLoad = listCalls;
    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    const file = new File(["x"], "a.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    // Upload + the immediate refresh after it.
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1);
    const afterImmediate = listCalls;
    expect(afterImmediate).toBeGreaterThan(afterInitialLoad);
    // …and exactly ONE delayed re-fetch (replaced-not-stacked: two would
    // mean the rapid-fire scheduling stacked timers), which stops after.
    await vi.advanceTimersByTimeAsync(KB_POLL_MS + 50);
    const afterDelayed = listCalls;
    expect(afterDelayed).toBe(afterImmediate + 1);
    await vi.advanceTimersByTimeAsync(KB_POLL_MS * 2);
    expect(listCalls).toBe(afterDelayed);
  });

  it("a file batch that stops at a failing file still shows the files that landed", async () => {
    let listCalls = 0;
    stubKnowledgeFetch({
      list: () => {
        listCalls += 1;
        return [kbRow()];
      },
      postResults: [
        { ok: true, status: 202, body: { id: "c1", name: "d1", status: "processing" } },
        { ok: false, status: 400, body: { error: "Unsupported format" } },
      ],
    });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Handbook.pdf");
    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    const files = [
      new File(["a"], "a.md", { type: "text/markdown" }),
      // Passes the client check (extension+size) — the ROUTE 400s it, the
      // shape the batch-stop path actually covers.
      new File(["b"], "b.pdf", { type: "application/pdf" }),
    ];
    fireEvent.change(input, { target: { files } });
    // The batch stopped at file 2 — but file 1 LANDED, so the list still
    // refreshes (unconditional) instead of leaving file 1 invisible.
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/Unsupported format/)).toBeTruthy();
  });

  it("failed rows show the re-upload guidance (no resume)", async () => {
    stubKnowledgeFetch({ list: () => [kbRow({ status: "failed" })] });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Failed");
    expect(screen.getByText(/Delete this document and upload it again/)).toBeTruthy();
  });

  it("a failed row shows the captured failure reason (e.g. an expired key)", async () => {
    // The live-demo gap that asked for this: agno stores the classified
    // reason on the row ("authentication (HTTP 401) ... Check the
    // embedder's API key and permissions") and the wire carries it —
    // "Failed" alone left the author guessing.
    stubKnowledgeFetch({
      list: () => [
        kbRow({
          status: "failed",
          statusMessage:
            'Embedding failed for "chine" (0 of 1 chunks embedded). Reason: authentication (HTTP 401). Check the embedder\'s API key and permissions.',
        }),
      ],
    });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Failed");
    expect(screen.getByText(/authentication \(HTTP 401\)/)).toBeTruthy();
    expect(screen.getByText(/Check the embedder's API key/)).toBeTruthy();
    // The remedy guidance still rides below the reason.
    expect(screen.getByText(/Delete this document and upload it again/)).toBeTruthy();
  });

  it("a partial row shows the captured partial reason (agno's N-of-M status message)", async () => {
    // agno writes a status_message on PARTIAL rows too ("N of M chunks
    // were embedded; Z failed and are not retrievable…") and the wire
    // carries it for every row — "Partial" alone left the author
    // guessing exactly like the failed-row case above.
    stubKnowledgeFetch({
      list: () => [
        kbRow({
          status: "partial",
          statusMessage:
            "1 of 3 chunks were embedded; 2 failed and are not retrievable. Re-ingest this content to retry the missing chunks.",
        }),
      ],
    });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Partial");
    expect(screen.getByText(/1 of 3 chunks were embedded/)).toBeTruthy();
    expect(screen.getByText(/2 failed and are not retrievable/)).toBeTruthy();
    // The failed remedy never rides a partial row — something was kept
    // (agno's own copy says re-ingest, not delete + re-upload).
    expect(screen.queryByText(/Delete this document and upload it again/)).toBeNull();
  });

  it("a partial row without a captured reason stays the bare chip only", async () => {
    // The wire permits a null statusMessage (agno always writes one on
    // a partial row, but the contract allows absence) — the conditional
    // must not grow an empty block, the same no-empty-line discipline
    // the description second line follows.
    stubKnowledgeFetch({ list: () => [kbRow({ status: "partial" })] });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("Partial");
    const card = screen.getByText("Handbook.pdf").closest("div.rounded-lg");
    expect(card?.childElementCount).toBe(1);
  });

  it("a doc row renders its description as a second line; a row without one stays single-line", async () => {
    // The #253 wire extension: agno's Content description rides the list
    // payload and renders under the name when a row carries one. The
    // paste-text flow maps name to what the user typed and carries NO
    // description — its row must not grow an empty second line.
    stubKnowledgeFetch({
      list: () => [
        kbRow({
          id: "row-desc",
          description: "The team handbook — policies and onboarding.",
        }),
        kbRow({ id: "row-bare", name: "Pasted text" }),
      ],
    });
    render(<BuilderForm {...editProps()} />);
    await screen.findByText("The team handbook — policies and onboarding.");
    // Structural pin: the described row's card holds the name/chip/size/
    // date line PLUS the description line; the bare row's card holds the
    // one line alone.
    const describedCard = screen
      .getByText("Handbook.pdf")
      .closest("div.rounded-lg");
    const bareCard = screen.getByText("Pasted text").closest("div.rounded-lg");
    expect(describedCard?.childElementCount).toBe(2);
    expect(bareCard?.childElementCount).toBe(1);
  });
});

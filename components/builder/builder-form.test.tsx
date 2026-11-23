// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { BuilderForm } from "./builder-form";
import type {
  CredentialCatalog,
  CredentialsState,
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

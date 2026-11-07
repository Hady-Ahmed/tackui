import Link from "next/link";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { AGENTOS_ENABLED } from "@/lib/config/agentos";
import { MarketingLayout } from "./marketing-layout";
import { RevealOnScroll } from "./reveal-on-scroll";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Feature data                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

type VisualKind =
  | "agent-switch"
  | "tool-call"
  | "builder-form"
  | "catalog-cards"
  | "code-snippet";

/**
 * The features grid sits below the builder spotlight and describes what
 * chatting in TackUI feels like. Copy is written for non-technical visitors —
 * protocol talk lives in the developer section, not here.
 */
const FEATURES: {
  title: string;
  body: string;
  large?: boolean;
  visual?: VisualKind;
  icon: React.ReactNode;
}[] = [
  {
    title: "Every agent, one chat",
    body: "Built, installed, or connected — every agent lives in the same sidebar. Switch agents per conversation; the interface never changes.",
    large: true,
    visual: "agent-switch",
    icon: (
      <path
        d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
  },
  {
    title: "Human-in-the-loop approvals",
    body: "Agents can pause and ask for your sign-off before doing anything sensitive — you approve right inside the chat.",
    icon: (
      <path
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
  },
  {
    title: "See the work as it happens",
    body: "Watch agents call tools live — structured, readable renders instead of raw JSON.",
    large: true,
    visual: "tool-call",
    icon: (
      <path
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
  },
  {
    title: "Conversations that persist",
    body: "Every chat is a saved thread per agent. Close the tab, come back tomorrow — the history is waiting.",
    icon: (
      <path
        d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
  },
];

/* ────────────────────────────────────────────────────────────────────────── */
/*  The three paths                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The page's centerpiece: every visitor gets an agent one of three ways —
 * build it (agent builder), install it (catalog), or connect it (own AG-UI
 * backend). The build path is advertised only when the builder is
 * configured (`AGENTOS_ENABLED` is a boot-time env check, not a health
 * probe — a builder-service outage never removes it from this page).
 */
type PathCard = {
  title: string;
  body: string;
  cta: { label: string; href: string; external?: boolean };
  visual: VisualKind;
  icon: React.ReactNode;
};

const BUILD_PATH: PathCard | null = AGENTOS_ENABLED
  ? {
      title: "Build it",
      body: "Open the builder, pick a model, add the tools and connectors it needs. No code, no backend — your agent shows up in the sidebar.",
      cta: { label: "Build your first agent", href: "/signup" },
      visual: "builder-form",
      icon: (
        <path
          d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ),
    }
  : null;

const INSTALL_PATH: PathCard = {
  title: "Install it",
  body: "Ready-made agents from the catalog — add one to your workspace in a single click. No endpoints, no config.",
  cta: { label: "Browse the catalog", href: "/catalog" },
  visual: "catalog-cards",
  icon: (
    <path
      d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  ),
};

const CONNECT_PATH: PathCard = {
  title: "Connect it",
  body: "Already have an agent backend? Point any AG-UI-compatible endpoint at the registry — it gets the full frontend for free.",
  cta: {
    label: "AG-UI quickstart",
    href: "https://docs.ag-ui.com/quickstart/server",
    external: true,
  },
  visual: "code-snippet",
  icon: (
    <path
      d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  ),
};

const PATHS: PathCard[] = [BUILD_PATH, INSTALL_PATH, CONNECT_PATH].filter(
  (p): p is PathCard => p !== null,
);

const DEV_POINTS = [
  "Any framework — LangGraph, Agno, or your own server",
  "Everything standard — streaming, interrupts, and tool renders come from the protocol, not custom code",
  "Self-host it — Elastic License 2.0, unlimited everything, your infrastructure",
];

const BUILT_ON = ["AG-UI Protocol", "CopilotKit", "Better Auth", "Next.js 16"];

/* ────────────────────────────────────────────────────────────────────────── */
/*  Small mockup primitives                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function ToolChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-blue-50 px-2 py-0.5 font-mono text-[10px] font-medium text-blue-600 dark:bg-blue-950 dark:text-blue-400">
      {children}
    </span>
  );
}

function DashedChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-dashed border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </span>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
      {children}
    </p>
  );
}

function ChevronDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      className="text-zinc-400"
      aria-hidden
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className="mt-0.5 shrink-0 text-blue-500"
      aria-hidden
    >
      <path
        d="M5 13l4 4L19 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Card visuals — pure CSS/JSX, no screenshots                               */
/* ────────────────────────────────────────────────────────────────────────── */

function Visual({ kind }: { kind: VisualKind }) {
  if (kind === "agent-switch") {
    return (
      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600 dark:bg-blue-950 dark:text-blue-400">
          Research Agent
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          className="text-zinc-300 dark:text-zinc-600"
          aria-hidden
        >
          <path
            d="M5 12h14m0 0l-5-5m5 5l-5 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          Code Assistant
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          className="text-zinc-300 dark:text-zinc-600"
          aria-hidden
        >
          <path
            d="M5 12h14m0 0l-5-5m5 5l-5 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          Data Analyst
        </span>
      </div>
    );
  }

  if (kind === "tool-call") {
    return (
      <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <span className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs font-medium text-blue-600 dark:bg-blue-950 dark:text-blue-400">
            web_search
          </span>
          <span className="text-xs text-green-500">✓ completed</span>
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          &quot;Q3 2024 SaaS market trends analysis&quot;
        </p>
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-full w-2/3 rounded-full bg-blue-500" />
        </div>
      </div>
    );
  }

  if (kind === "builder-form") {
    return (
      <div className="mt-5 space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950">
          <span className="text-zinc-700 dark:text-zinc-300">GPT-4o</span>
          <ChevronDown />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ToolChip>web_search</ToolChip>
          <ToolChip>run_code</ToolChip>
          <DashedChip>+ Add tool</DashedChip>
        </div>
        <div className="rounded-lg border border-dashed border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Connect an MCP server
        </div>
      </div>
    );
  }

  if (kind === "catalog-cards") {
    return (
      <div className="mt-5 grid grid-cols-2 gap-2">
        {[
          {
            name: "Release Notes Writer",
            body: "Merged PRs → clean changelogs",
          },
          {
            name: "Meeting Notes Agent",
            body: "Transcripts → action items",
          },
        ].map((t) => (
          <div
            key={t.name}
            className="rounded-xl border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-900/50"
          >
            <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
              {t.name}
            </p>
            <p className="mt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
              {t.body}
            </p>
            <span className="mt-2 inline-block rounded bg-blue-600 px-1.5 py-0.5 text-[9px] font-medium text-white">
              Add
            </span>
          </div>
        ))}
      </div>
    );
  }

  // code-snippet
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-relaxed">
      <div className="mb-2 flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
      </div>
      <p className="text-zinc-500">{"{"}</p>
      <p className="pl-3 text-zinc-300">
        <span className="text-sky-300">&quot;name&quot;</span>:{" "}
        <span className="text-green-300">&quot;Research Agent&quot;</span>,
      </p>
      <p className="pl-3 text-zinc-300">
        <span className="text-sky-300">&quot;kind&quot;</span>:{" "}
        <span className="text-green-300">&quot;agui&quot;</span>,
      </p>
      <p className="pl-3 text-zinc-300">
        <span className="text-sky-300">&quot;endpoint&quot;</span>:{" "}
        <span className="text-green-300">&quot;https://…/agent&quot;</span>
      </p>
      <p className="text-zinc-500">{"}"}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Product chat mockup — styled JSX (no screenshot, pure CSS/JSX)            */
/* ────────────────────────────────────────────────────────────────────────── */

function ChatMockup() {
  return (
    <div className="relative mx-auto mt-16 max-w-4xl">
      {/* Subtle gradient border glow */}
      <div
        className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-b from-blue-500/20 via-transparent to-transparent"
        aria-hidden
      />

      {/* Window frame */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-red-400/70" />
            <span className="h-3 w-3 rounded-full bg-yellow-400/70" />
            <span className="h-3 w-3 rounded-full bg-green-400/70" />
          </div>
          <span className="mx-auto text-xs font-medium text-zinc-400 dark:text-zinc-500">
            TackUI — Unified agent frontend
          </span>
        </div>

        {/* Two-pane layout */}
        <div className="flex h-[340px] text-sm sm:h-[380px]">
          {/* Sidebar */}
          <aside className="hidden w-52 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 sm:flex">
            {/* Header */}
            <div className="border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
              <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-50">
                TackUI
              </p>
              <p className="text-[10px] text-zinc-400">
                Unified agent frontend
              </p>
            </div>

            {/* New chat */}
            <div className="p-2">
              <div className="rounded-lg border border-zinc-200 px-2 py-1.5 text-center text-xs text-zinc-500 dark:border-zinc-700">
                + New Chat
              </div>
            </div>

            {/* Agents + conversations */}
            <div className="flex-1 overflow-hidden px-2">
              <p className="px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                Agents
              </p>

              {/* Active agent */}
              <div className="rounded-lg bg-blue-50 px-2 py-1.5 dark:bg-blue-950/70">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                    Research Agent
                  </span>
                </div>
                <span className="mt-1 inline-block rounded bg-zinc-100 px-1 py-0.5 text-[8px] font-medium uppercase text-zinc-500 dark:bg-zinc-800">
                  agui
                </span>
              </div>

              {/* Inactive agents */}
              <div className="mt-0.5 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  <span className="text-xs text-zinc-700 dark:text-zinc-300">
                    Code Assistant
                  </span>
                </div>
              </div>
              <div className="mt-0.5 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                  <span className="text-xs text-zinc-700 dark:text-zinc-300">
                    Data Analyst
                  </span>
                </div>
              </div>

              {/* Conversations */}
              <p className="mt-3 px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                Conversations
              </p>
              <div className="rounded-lg bg-zinc-100 px-2 py-1.5 text-xs font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50">
                Q3 market analysis
              </div>
              <div className="mt-0.5 px-2 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                API design review
              </div>
            </div>
          </aside>

          {/* Chat area */}
          <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
            {/* Chat header */}
            <div className="border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Research Agent
                </span>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 space-y-3 overflow-hidden p-4">
              {/* User message */}
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-blue-600 px-3 py-1.5 text-xs text-white">
                  Analyze the Q3 market trends for SaaS tools
                </div>
              </div>

              {/* Agent response */}
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  I&apos;ll research Q3 SaaS market trends. Let me gather data
                  from multiple sources.
                </div>
              </div>

              {/* Tool-call card */}
              <div className="mx-auto max-w-[75%] rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center gap-2">
                  <span className="flex h-4 w-4 items-center justify-center rounded bg-blue-50 text-[9px] text-blue-600 dark:bg-blue-950 dark:text-blue-400">
                    🔍
                  </span>
                  <span className="font-mono text-[10px] font-medium text-zinc-600 dark:text-zinc-400">
                    web_search
                  </span>
                  <span className="text-[9px] text-green-500">✓ done</span>
                </div>
                <p className="mt-1.5 text-[10px] text-zinc-400">
                  &quot;Q3 2024 SaaS market trends&quot;
                </p>
              </div>

              {/* Streaming message with blinking cursor */}
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  Based on the results, the SaaS market in Q3 showed strong
                  growth in AI-native tools
                  <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-blue-500 align-middle" />
                </div>
              </div>
            </div>

            {/* Input bar */}
            <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
              <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
                Message Research Agent…
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom fade — blends the mockup into the page */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-2xl bg-gradient-to-t from-white to-transparent dark:from-black"
        aria-hidden
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Builder mockup — the agent-builder form, pure CSS/JSX                     */
/* ────────────────────────────────────────────────────────────────────────── */

function BuilderMockup() {
  return (
    <div className="relative">
      {/* Subtle gradient border glow */}
      <div
        className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-b from-blue-500/20 via-transparent to-transparent"
        aria-hidden
      />

      <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-red-400/70" />
            <span className="h-3 w-3 rounded-full bg-yellow-400/70" />
            <span className="h-3 w-3 rounded-full bg-green-400/70" />
          </div>
          <span className="mx-auto text-xs font-medium text-zinc-400 dark:text-zinc-500">
            TackUI — Agent builder
          </span>
        </div>

        {/* Form */}
        <div className="space-y-4 p-5">
          {/* Name */}
          <div>
            <FieldLabel>Name</FieldLabel>
            <div className="mt-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
              Release Notes Writer
            </div>
          </div>

          {/* Model */}
          <div>
            <FieldLabel>Model</FieldLabel>
            <div className="mt-1.5 flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              <span className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                GPT-4o
                <span className="text-zinc-400">· balanced</span>
              </span>
              <ChevronDown />
            </div>
          </div>

          {/* Tools */}
          <div>
            <FieldLabel>Tools</FieldLabel>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <ToolChip>get_pull_request</ToolChip>
              <ToolChip>list_commits</ToolChip>
              <ToolChip>run_code</ToolChip>
              <DashedChip>+ Add tool</DashedChip>
            </div>
          </div>

          {/* Connectors */}
          <div>
            <FieldLabel>Connectors</FieldLabel>
            <div className="mt-1.5 space-y-1.5">
              <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                <span className="text-zinc-900 dark:text-zinc-100">
                  GitHub MCP
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-green-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  connected
                </span>
              </div>
              <div className="rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                + Connect an MCP server
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <span className="rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm">
              Create agent
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Catalog mockup — the catalog browsing experience, pure CSS/JSX            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Illustrative catalog entries for the spotlight mockup — static examples,
 * same approach as the chat and builder mockups (which also show sample
 * content). The first two mirror the "Install it" path-card visual; swap
 * in live `listTemplates` data when the real catalog is big enough to
 * carry the section.
 */
const CATALOG_EXAMPLES = [
  {
    icon: "📚",
    name: "Release Notes Writer",
    body: "Merged PRs → clean changelogs",
  },
  {
    icon: "📝",
    name: "Meeting Notes Agent",
    body: "Transcripts → action items",
  },
  {
    icon: "📥",
    name: "Inbox Triage",
    body: "Sorts, labels, drafts replies",
  },
  {
    icon: "🔭",
    name: "Competitive Scan",
    body: "Tracks rivals, weekly digest",
  },
];

function CatalogMockup() {
  return (
    <div className="relative">
      {/* Subtle gradient border glow */}
      <div
        className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-b from-blue-500/20 via-transparent to-transparent"
        aria-hidden
      />

      <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-red-400/70" />
            <span className="h-3 w-3 rounded-full bg-yellow-400/70" />
            <span className="h-3 w-3 rounded-full bg-green-400/70" />
          </div>
          <span className="mx-auto text-xs font-medium text-zinc-400 dark:text-zinc-500">
            TackUI — Agent catalog
          </span>
        </div>

        {/* Search row */}
        <div className="p-4 pb-0">
          <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
            Search agents…
          </div>
        </div>

        {/* Template grid */}
        <div className="grid grid-cols-2 gap-2.5 p-4">
          {CATALOG_EXAMPLES.map((t) => (
            <div
              key={t.name}
              className="flex flex-col rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50"
            >
              <span className="text-lg leading-none" aria-hidden>
                {t.icon}
              </span>
              <p className="mt-2 text-xs font-medium text-zinc-900 dark:text-zinc-100">
                {t.name}
              </p>
              <p className="mt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                {t.body}
              </p>
              <span className="mt-2.5 self-start rounded bg-blue-600 px-2 py-0.5 text-[9px] font-medium text-white">
                Add
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Landing page                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Marketing landing page — SaaS mode only (`SAAS_MODE=true`).
 * Self-host deployments redirect `/` → `/app` (see app/page.tsx) and never
 * render this component.
 *
 * Page narrative, top to bottom: hero (outcome-first headline + chat
 * mockup) → "three ways to get an agent" (build / install / connect) →
 * agent-builder spotlight (AGENTOS_ENABLED-gated) → catalog spotlight
 * (illustrative template mockup) → features of the chat itself → "for
 * developers: bring your own backend" → built-on strip → pricing teaser
 * (BILLING_ENABLED-gated) → final CTA.
 *
 * Copy rules: AG-UI appears only in the hero badge, the built-on strip, and
 * the developer section — everywhere the visitor is being sold, it's TackUI.
 *
 * Server component for SEO; minimal client JS. The only client island is
 * `RevealOnScroll` (IntersectionObserver-based scroll reveals). The hero
 * section uses CSS-only `animate-fade-in-up` for on-load animation.
 */
export async function Landing() {
  return (
    <MarketingLayout>
      {/* ─── Hero ─────────────────────────────────────────────── */}
      <section className="relative flex flex-col items-center overflow-hidden py-16 text-center md:py-24">
        {/* Dot-grid background — fades out at edges */}
        <div
          className="hero-grid pointer-events-none absolute inset-0 h-[500px]"
          aria-hidden
        />

        {/* Radial glow — subtle blue blur behind the headline */}
        <div
          className="animate-pulse-glow pointer-events-none absolute top-0 left-1/2 h-[400px] w-[600px] -translate-x-1/2 rounded-full bg-blue-500/10 blur-[120px]"
          aria-hidden
        />

        <div className="animate-fade-in-up relative flex flex-col items-center">
          {/* Eyebrow — product name */}
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">
            TackUI
          </p>

          {/* Badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/50 px-3 py-1 text-xs font-medium text-zinc-600 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
            </span>
            Open Source · AG-UI Protocol
          </div>

          {/* Headline with gradient text — outcome first, protocol later */}
          <h1 className="max-w-3xl bg-gradient-to-b from-zinc-900 via-zinc-700 to-zinc-600 bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl md:text-6xl dark:from-white dark:via-zinc-200 dark:to-blue-300">
            Your own AI agents — built, installed, or connected
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            Build an agent without code, install a ready-made one with a
            click, or connect your own backend — all in one ChatGPT-style
            chat that&apos;s actually yours.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-6 py-3 font-medium text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-600 hover:to-blue-700 hover:shadow-xl hover:shadow-blue-600/30 active:scale-[0.98]"
            >
              Get started — free
            </Link>
            <a
              href="https://github.com/Hady-Ahmed/tackui"
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-zinc-300 px-6 py-3 font-medium text-zinc-700 transition-all hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 active:scale-[0.98]"
            >
              Self-host on GitHub
            </a>
          </div>

          <p className="mt-4 text-sm text-zinc-400 dark:text-zinc-600">
            Elastic License 2.0 · No credit card required
          </p>
        </div>

        {/* Product mockup — scroll-revealed */}
        <RevealOnScroll delay={200} className="w-full">
          <ChatMockup />
        </RevealOnScroll>
      </section>

      {/* ─── Three ways to get an agent ──────────────────────── */}
      <RevealOnScroll>
        <section className="py-16">
          <div className="mb-10 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Three ways to get an agent
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-zinc-600 dark:text-zinc-400">
              Build one, install one, or connect one — they all end up in the
              same place: your agents, in one chat.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-3">
            {PATHS.map((p) => (
              <div
                key={p.title}
                className="flex flex-col rounded-2xl border border-zinc-200 p-6 transition-all hover:border-zinc-300 hover:shadow-lg dark:border-zinc-800 dark:hover:border-zinc-700"
              >
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
                  <svg width="20" height="20" viewBox="0 0 24 24">
                    {p.icon}
                  </svg>
                </div>
                <h3 className="mt-4 font-semibold tracking-tight">
                  {p.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {p.body}
                </p>
                <Visual kind={p.visual} />
                <div className="mt-auto pt-5">
                  {p.cta.external ? (
                    <a
                      href={p.cta.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {p.cta.label} →
                    </a>
                  ) : (
                    <Link
                      href={p.cta.href}
                      className="text-sm font-medium text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {p.cta.label} →
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </RevealOnScroll>

      {/* ─── Builder spotlight ───────────────────────────────── */}
      {AGENTOS_ENABLED && (
        <RevealOnScroll>
          <section className="py-16">
            <div className="grid items-center gap-10 lg:grid-cols-2">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">
                  Agent builder
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  An agent of your own, in{" "}
                  <span className="whitespace-nowrap">five minutes</span>
                </h2>
                <p className="mt-4 leading-relaxed text-zinc-600 dark:text-zinc-400">
                  Name it, pick a model, choose the tools it can use, wire up
                  an MCP connector or two. No code, no backend — the builder
                  turns your description into a working agent that appears in
                  your sidebar.
                </p>
                <Link
                  href="/signup"
                  className="mt-6 inline-block rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-2.5 font-medium text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-600 hover:to-blue-700 hover:shadow-xl hover:shadow-blue-600/30 active:scale-[0.98]"
                >
                  Start building
                </Link>
              </div>
              <BuilderMockup />
            </div>
          </section>
        </RevealOnScroll>
      )}

      {/* ─── Catalog spotlight ───────────────────────────────── */}
      <RevealOnScroll>
        <section className="py-16">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div className="lg:order-2">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">
                Agent catalog
              </p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                Or skip the setup entirely
              </h2>
              <p className="mt-4 leading-relaxed text-zinc-600 dark:text-zinc-400">
                Ready-made agents from the catalog — add one to your
                workspace with a single click. No endpoints, no config.
                Install, open a chat, go.
              </p>
              <Link
                href="/catalog"
                className="mt-6 inline-block rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-2.5 font-medium text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-600 hover:to-blue-700 hover:shadow-xl hover:shadow-blue-600/30 active:scale-[0.98]"
              >
                Browse the catalog
              </Link>
            </div>
            <div className="lg:order-1">
              <CatalogMockup />
            </div>
          </div>
        </section>
      </RevealOnScroll>

      {/* ─── Bento features — the three-ways payoff ─────────── */}
      <RevealOnScroll>
        <section className="py-16">
          <div className="mb-10 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Whatever their origin — one chat
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-zinc-600 dark:text-zinc-400">
              Built, installed, or connected — every agent lands in the same
              sidebar and the same chat.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className={`group rounded-2xl border border-zinc-200 p-6 transition-all hover:border-zinc-300 hover:shadow-lg dark:border-zinc-800 dark:hover:border-zinc-700 ${
                  f.large ? "lg:col-span-2" : ""
                }`}
              >
                <div className="flex items-start gap-4">
                  <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 transition-colors group-hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-400 dark:group-hover:bg-blue-900/50">
                    <svg width="20" height="20" viewBox="0 0 24 24">
                      {f.icon}
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold tracking-tight">{f.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                      {f.body}
                    </p>
                  </div>
                </div>
                {f.visual && <Visual kind={f.visual} />}
              </div>
            ))}
          </div>
        </section>
      </RevealOnScroll>

      {/* ─── For developers: bring your own backend ─────────── */}
      <RevealOnScroll>
        <section className="py-16">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">
                For developers
              </p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                Bring your own backend
              </h2>
              <p className="mt-4 leading-relaxed text-zinc-600 dark:text-zinc-400">
                TackUI speaks the AG-UI protocol natively — built on
                CopilotKit, the 1st-party AG-UI client. Any backend that
                speaks AG-UI gets the full frontend: streaming, interrupts,
                tool renders, persisted threads.
              </p>
              <ul className="mt-5 space-y-2.5 text-sm text-zinc-600 dark:text-zinc-400">
                {DEV_POINTS.map((point) => (
                  <li key={point} className="flex gap-2.5">
                    <CheckIcon />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="https://github.com/Hady-Ahmed/tackui"
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-zinc-300 px-5 py-2 text-sm font-medium text-zinc-700 transition-all hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 active:scale-[0.98]"
                >
                  Self-host on GitHub →
                </a>
                <a
                  href="https://docs.ag-ui.com/quickstart/server"
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-zinc-300 px-5 py-2 text-sm font-medium text-zinc-700 transition-all hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 active:scale-[0.98]"
                >
                  Read the AG-UI docs →
                </a>
              </div>
            </div>
            <Visual kind="code-snippet" />
          </div>
        </section>
      </RevealOnScroll>

      {/* ─── Built on ────────────────────────────────────────── */}
      <RevealOnScroll>
        <section className="flex flex-col items-center py-12">
          <p className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            Built on open standards
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {BUILT_ON.map((tech, i) => (
              <span key={tech} className="flex items-center gap-6">
                {i > 0 && (
                  <span className="hidden h-4 w-px bg-zinc-200 dark:bg-zinc-700 sm:inline" />
                )}
                <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  {tech}
                </span>
              </span>
            ))}
          </div>
        </section>
      </RevealOnScroll>

      {/* ─── Pricing teaser ──────────────────────────────────── */}
      {BILLING_ENABLED && (
        <RevealOnScroll>
          <section className="py-12 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">
              Simple pricing
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Free to start. Upgrade when you need more agents or team seats.
            </p>
            <Link
              href="/pricing"
              className="mt-6 inline-block rounded-xl border border-zinc-300 px-6 py-3 font-medium text-zinc-700 transition-all hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 active:scale-[0.98]"
            >
              See plans
            </Link>
          </section>
        </RevealOnScroll>
      )}

      {/* ─── Final CTA ───────────────────────────────────────── */}
      <RevealOnScroll>
        <section className="relative flex flex-col items-center overflow-hidden py-16 text-center md:py-24">
          {/* Dot-grid + glow for the CTA section */}
          <div
            className="hero-grid pointer-events-none absolute inset-0 h-[300px]"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute top-1/2 left-1/2 h-[300px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/10 blur-[100px]"
            aria-hidden
          />
          <div className="relative">
            <h2 className="bg-gradient-to-b from-zinc-900 to-zinc-600 bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl dark:from-white dark:to-blue-300">
              Start building with{" "}
              <span className="whitespace-nowrap">TackUI</span> today
            </h2>
            <p className="mt-4 text-zinc-600 dark:text-zinc-400">
              Build your first agent in minutes — no code required.
            </p>
            <Link
              href="/signup"
              className="mt-8 inline-block rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-6 py-3 font-medium text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-600 hover:to-blue-700 hover:shadow-xl hover:shadow-blue-600/30 active:scale-[0.98]"
            >
              Get started — free
            </Link>
          </div>
        </section>
      </RevealOnScroll>
    </MarketingLayout>
  );
}

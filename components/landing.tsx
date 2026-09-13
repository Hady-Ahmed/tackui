import Link from "next/link";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { MarketingLayout } from "./marketing-layout";
import { RevealOnScroll } from "./reveal-on-scroll";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Feature data                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

type FeatureVisual = "agent-switch" | "tool-call" | "code-snippet";

const FEATURES: {
  title: string;
  body: string;
  large?: boolean;
  visual?: FeatureVisual;
  icon: React.ReactNode;
}[] = [
  {
    title: "Multi-agent switching",
    body: "Connect LangGraph, Agno, or any AG-UI backend. Switch agents per conversation — no UI changes needed.",
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
    title: "AG-UI protocol native",
    body: "Built on CopilotKit, the 1st-party AG-UI client. Streaming, interrupts, tool renders — all standard.",
    icon: (
      <path
        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
  },
  {
    title: "Human-in-the-loop",
    body: "Approval interrupts let agents pause for your sign-off before taking sensitive actions.",
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
    title: "Tool-call visualization",
    body: "See what your agents are doing as they work — structured tool renders, not raw JSON.",
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
    title: "Bring your own backend",
    body: "Point any AG-UI-compatible endpoint at the registry. Your backends stay yours — self-host TackUI or use our hosted SaaS.",
    large: true,
    visual: "code-snippet",
    icon: (
      <path
        d="M13 10V3L4 14h7v7l9-11h-7z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
  },
  {
    title: "Self-host or use ours",
    body: "Elastic License 2.0. Run it yourself with unlimited everything, or let us host it for you.",
    icon: (
      <path
        d="M5 12H3l9-9 9 9h-2M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7M9 21v-6a2 2 0 012-2h2a2 2 0 012 2v6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
  },
];

const STEPS = [
  {
    num: "01",
    title: "Connect your endpoint",
    body: "Point any AG-UI-compatible backend at the registry — via the admin UI or a single POST request.",
  },
  {
    num: "02",
    title: "Pick your agent",
    body: "Select from the sidebar. Each agent keeps its own conversation threads and state.",
  },
  {
    num: "03",
    title: "Start chatting",
    body: "Stream tokens, approve interrupts, visualize tool calls. Full multi-turn conversations, persisted.",
  },
];

const BUILT_ON = ["AG-UI Protocol", "CopilotKit", "Better Auth", "Next.js 16"];

/* ────────────────────────────────────────────────────────────────────────── */
/*  Bento card visuals                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

function FeatureVisual({ kind }: { kind: FeatureVisual }) {
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
/*  Landing page                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Marketing landing page — SaaS mode only (`SAAS_MODE=true`).
 * Self-host deployments redirect `/` → `/app` (see app/page.tsx) and never
 * render this component.
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

          {/* Headline with gradient text */}
          <h1 className="max-w-3xl bg-gradient-to-b from-zinc-900 via-zinc-700 to-zinc-600 bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl md:text-6xl dark:from-white dark:via-zinc-200 dark:to-blue-300">
            One frontend for every AG-UI agent
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            A ChatGPT-style chat for your custom agents. Connect any backend
            speaking the AG-UI protocol — switch agents per conversation,
            stream tokens, approve interrupts, visualize tool calls.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-6 py-3 font-medium text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-600 hover:to-blue-700 hover:shadow-xl hover:shadow-blue-600/30"
            >
              Get started — free
            </Link>
            <a
              href="https://github.com/Hady-Ahmed/tackui"
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-zinc-300 px-6 py-3 font-medium text-zinc-700 transition-all hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900"
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

      {/* ─── Bento features ──────────────────────────────────── */}
      <RevealOnScroll>
        <section className="grid gap-5 py-12 sm:grid-cols-2 lg:grid-cols-3">
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
              {f.visual && <FeatureVisual kind={f.visual} />}
            </div>
          ))}
        </section>
      </RevealOnScroll>

      {/* ─── How it works ────────────────────────────────────── */}
      <RevealOnScroll>
        <section className="py-16">
          <div className="mb-12 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Up and running in minutes
            </h2>
            <p className="mt-3 text-zinc-600 dark:text-zinc-400">
              No build steps, no SDK to install. Just point your agent
              endpoint and start chatting.
            </p>
          </div>

          <div className="relative grid gap-8 md:grid-cols-3">
            {/* Connector line — desktop only, behind the step badges */}
            <div
                              className="absolute left-0 right-0 top-6 hidden h-px bg-gradient-to-r from-transparent via-zinc-200 to-transparent md:block dark:via-zinc-700"
                              aria-hidden
            />

            {STEPS.map((step) => (
              <div
                key={step.num}
                className="relative flex flex-col items-center text-center"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-200 bg-white text-sm font-semibold text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50">
                  {step.num}
                </div>
                <h3 className="mt-4 font-semibold tracking-tight">
                  {step.title}
                </h3>
                <p className="mt-2 max-w-xs text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {step.body}
                </p>
              </div>
            ))}
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
              className="mt-6 inline-block rounded-xl border border-zinc-300 px-6 py-3 font-medium text-zinc-700 transition-all hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900"
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
              Start building with AG-UI today
            </h2>
            <p className="mt-4 text-zinc-600 dark:text-zinc-400">
              Connect your first agent in under two minutes. Free forever for
              personal use.
            </p>
            <Link
              href="/signup"
              className="mt-8 inline-block rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-6 py-3 font-medium text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-600 hover:to-blue-700 hover:shadow-xl hover:shadow-blue-600/30"
            >
              Get started — free
            </Link>
          </div>
        </section>
      </RevealOnScroll>
    </MarketingLayout>
  );
}

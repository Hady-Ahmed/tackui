import Link from "next/link";
import { BILLING_ENABLED } from "@/lib/config/saas";
import { MarketingLayout } from "./marketing-layout";

const FEATURES = [
  {
    title: "Multi-agent switching",
    body: "Connect LangGraph, Agno, or any AG-UI backend. Switch agents per conversation — no UI changes needed.",
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
    body: "Point any AG-UI-compatible endpoint at the registry. Self-host your agent backends, or use ours.",
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

const BUILT_ON = ["AG-UI Protocol", "CopilotKit", "Better Auth", "Next.js 16"];

/**
 * Marketing landing page — SaaS mode only (`SAAS_MODE=true`).
 * Self-host deployments redirect `/` → `/app` (see app/page.tsx) and never
 * render this component.
 *
 * Server component for SEO; minimal client JS. Uses MarketingLayout for
 * the shared header/footer (session-aware nav). Nav links adapt to billing
 * being configured: "Pricing" only shows when Stripe is wired up.
 */
export async function Landing() {
  return (
    <MarketingLayout>
      {/* ─── Hero ─────────────────────────────────────────────── */}
      <section className="relative flex flex-col items-center overflow-hidden py-16 text-center md:py-24">
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
          <h1 className="max-w-3xl bg-gradient-to-b from-zinc-900 to-zinc-600 bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl md:text-6xl dark:from-white dark:to-zinc-400">
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
              className="rounded-xl bg-blue-600 px-6 py-3 font-medium text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-700 hover:shadow-blue-600/30"
            >
              Get started — free
            </Link>
            <a
              href="https://github.com/"
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
      </section>

      {/* ─── Features ────────────────────────────────────────── */}
      <section className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="group rounded-2xl border border-zinc-200 p-6 transition-all hover:border-zinc-300 hover:shadow-lg dark:border-zinc-800 dark:hover:border-zinc-700"
          >
            <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
              <svg width="20" height="20" viewBox="0 0 24 24">
                {f.icon}
              </svg>
            </div>
            <h3 className="font-semibold tracking-tight">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              {f.body}
            </p>
          </div>
        ))}
      </section>

      {/* ─── Built on ────────────────────────────────────────── */}
      <section className="flex flex-col items-center py-16">
        <p className="text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
          Built on open standards
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {BUILT_ON.map((tech) => (
            <span
              key={tech}
              className="rounded-lg border border-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
            >
              {tech}
            </span>
          ))}
        </div>
      </section>

      {/* ─── Pricing teaser ──────────────────────────────────── */}
      {BILLING_ENABLED && (
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
      )}

      {/* ─── Final CTA ───────────────────────────────────────── */}
      <section className="relative flex flex-col items-center overflow-hidden py-16 text-center md:py-24">
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 h-[300px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/5 blur-[100px]"
          aria-hidden
        />
        <div className="relative">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Start building with AG-UI today
          </h2>
          <p className="mt-4 text-zinc-600 dark:text-zinc-400">
            Connect your first agent in under two minutes. Free forever for
            personal use.
          </p>
          <Link
            href="/signup"
            className="mt-8 inline-block rounded-xl bg-blue-600 px-6 py-3 font-medium text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-700 hover:shadow-blue-600/30"
          >
            Get started — free
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}

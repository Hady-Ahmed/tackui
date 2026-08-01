import Link from "next/link";
import { BILLING_ENABLED } from "@/lib/config/saas";

const FEATURES = [
  {
    title: "Multi-agent switching",
    body: "Connect LangGraph, Agno, or any AG-UI backend. Switch agents per conversation — no UI changes needed.",
  },
  {
    title: "AG-UI protocol native",
    body: "Built on CopilotKit, the 1st-party AG-UI client. Streaming, interrupts, tool renders — all standard.",
  },
  {
    title: "Human-in-the-loop",
    body: "Approval interrupts let agents pause for your sign-off before taking sensitive actions.",
  },
  {
    title: "Tool-call visualization",
    body: "See what your agents are doing as they work — structured tool renders, not raw JSON.",
  },
  {
    title: "Bring your own backend",
    body: "Point any AG-UI-compatible endpoint at the registry. Self-host your agent backends, or use ours.",
  },
  {
    title: "Self-host or use ours",
    body: "Apache-2.0 licensed. Run it yourself with unlimited everything, or let us host it for you.",
  },
];

/**
 * Marketing landing page — SaaS mode only (`SAAS_MODE=true`).
 * Self-host deployments redirect `/` → `/app` (see app/page.tsx) and never
 * render this component.
 *
 * Server component for SEO; minimal client JS. Nav links adapt to billing
 * being configured: "Pricing" only shows when Stripe is wired up.
 */
export function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-white text-zinc-900 dark:bg-black dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            AG-UI Chat
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            {BILLING_ENABLED && (
              <Link
                href="/pricing"
                className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Pricing
              </Link>
            )}
            <Link
              href="/terms"
              className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Privacy
            </Link>
            <Link
              href="/login"
              className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Sign up free
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6">
        <section className="flex flex-col items-center py-20 text-center">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            One frontend for every AG-UI agent
          </h1>
          <p className="mt-5 max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
            A ChatGPT-style chat for your custom agents. Connect any backend
            speaking the AG-UI protocol — switch agents per conversation,
            stream tokens, approve interrupts, visualize tool calls.
          </p>
          <div className="mt-8 flex items-center gap-3">
            <Link
              href="/signup"
              className="rounded-lg bg-zinc-900 px-5 py-2.5 font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Get started — free
            </Link>
            <a
              href="https://github.com/"
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-zinc-300 px-5 py-2.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Self-host on GitHub
            </a>
          </div>
          <p className="mt-3 text-sm text-zinc-500">
            Apache-2.0 · No credit card required
          </p>
        </section>

        <section className="grid gap-6 py-10 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-zinc-200 p-6 dark:border-zinc-800"
            >
              <h3 className="font-medium">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                {f.body}
              </p>
            </div>
          ))}
        </section>

        {BILLING_ENABLED && (
          <section className="py-16 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">
              Simple pricing
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Free to start. Upgrade when you need more agents or team seats.
            </p>
            <Link
              href="/pricing"
              className="mt-6 inline-block rounded-lg border border-zinc-300 px-5 py-2.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              See plans
            </Link>
          </section>
        )}
      </main>

      <footer className="border-t border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-6 py-6 text-sm text-zinc-500 sm:flex-row">
          <p>© {new Date().getFullYear()} AG-UI Chat</p>
          <div className="flex items-center gap-6">
            <Link href="/terms" className="hover:text-zinc-700 dark:hover:text-zinc-300">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-zinc-700 dark:hover:text-zinc-300">
              Privacy
            </Link>
            <a
              href="https://github.com/"
              target="_blank"
              rel="noreferrer"
              className="hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

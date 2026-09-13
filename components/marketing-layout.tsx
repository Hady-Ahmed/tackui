import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/context";
import { BILLING_ENABLED } from "@/lib/config/saas";

/**
 * Shared layout for SaaS marketing pages (landing, pricing, terms, privacy).
 *
 * Server component — calls getCurrentUser() to make the nav session-aware:
 * signed-in users see "Go to app" instead of "Sign in" / "Sign up free".
 * This keeps the landing page from showing a dead "Sign in" link to users
 * who are already authenticated.
 *
 * The header + footer are extracted here from landing.tsx so /terms,
 * /privacy, and /pricing get the same chrome instead of rendering as
 * orphaned text pages with just a "Back to home" link.
 */
export async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col bg-white text-zinc-900 dark:bg-black dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 md:px-6">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            TackUI
          </Link>
          {/* Desktop nav — full link set */}
          <nav className="hidden items-center gap-6 text-sm md:flex">
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
            {user ? (
              <Link
                href="/app"
                className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Go to app
              </Link>
            ) : (
              <>
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
              </>
            )}
          </nav>
          {/* Mobile nav — compact CTA only (Terms/Privacy/Pricing are in the footer) */}
          <nav className="md:hidden">
            {user ? (
              <Link
                href="/app"
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Go to app
              </Link>
            ) : (
              <Link
                href="/signup"
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Sign up
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 md:px-6">
        {children}
      </main>

      <footer className="border-t border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-zinc-500 sm:flex-row md:px-6">
          <p>© {new Date().getFullYear()} TackUI</p>
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

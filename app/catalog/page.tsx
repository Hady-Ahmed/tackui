import Link from "next/link";
import { redirect } from "next/navigation";
import { SAAS_MODE } from "@/lib/config/saas";
import { listTemplates } from "@/lib/catalog/template-store";
import { getCurrentUser } from "@/lib/auth/context";
import { MarketingLayout } from "@/components/marketing-layout";

/**
 * Public agent catalog — the marketing-facing list of curated agents
 * (SaaS mode only; self-host redirects to /app, same as /pricing).
 *
 * This is the shareable surface: a link like tackui.app/catalog#slug
 * goes straight to that agent's card. Gated templates stay visible
 * with their tier badge. Qualitative copy: the free tier's daily run
 * number is never stated anywhere.
 */
export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  if (!SAAS_MODE) redirect("/app");

  const [user, templates] = await Promise.all([
    getCurrentUser(),
    listTemplates({ activeOnly: true }),
  ]);

  return (
    <MarketingLayout>
      <div className="py-16">
        <h1 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
          The agent catalog
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-center text-zinc-600 dark:text-zinc-400">
          Ready-to-use agents, one click to add to your workspace. No
          endpoints, no config — pick one and start chatting.
        </p>

        {templates.length === 0 ? (
          <p className="mt-12 text-center text-sm text-zinc-400">
            The catalog is launching soon — sign up to get started in the
            meantime.
          </p>
        ) : (
          <div className="mx-auto mt-12 grid max-w-3xl gap-5 sm:grid-cols-2">
            {templates.map((template) => (
              <div
                key={template.id}
                id={template.slug}
                className="flex flex-col rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    {template.icon ? (
                      <span className="text-2xl leading-none" aria-hidden="true">
                        {template.icon}
                      </span>
                    ) : (
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        {template.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
                        {template.name}
                      </h2>
                      {template.category && (
                        <p className="mt-0.5 text-xs text-zinc-400">{template.category}</p>
                      )}
                    </div>
                  </div>
                  {template.requiredPlan && (
                    <span className="shrink-0 rounded-full bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white">
                      {template.requiredPlan === "pro" ? "Pro" : "Team"}
                    </span>
                  )}
                </div>

                {template.tagline && (
                  <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {template.tagline}
                  </p>
                )}
                {template.description && (
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {template.description}
                  </p>
                )}

                <div className="mt-auto pt-4">
                  {(template.requiredPlan || template.freeDailyQuota != null) && (
                    <p className="mb-3 text-xs text-zinc-400">
                      {template.requiredPlan
                        ? // Plain statement — no "free" promise on a
                          // gated card; the plan gate is enforced
                          // in-app after signup (the 🔒 state +
                          // upgrade dialog).
                          `Available on the ${template.requiredPlan === "pro" ? "Pro" : "Team"} plan`
                        : // No "Free plan" prefix — ungated cards without
                          // a quota don't say anything, and mentioning
                          // free on quota'd cards implied the others
                          // weren't on free.
                          "Daily usage limit · unlimited on Pro"}
                    </p>
                  )}
                  <Link
                    href={user ? "/app/catalog" : "/signup"}
                    className={`block rounded-lg px-4 py-2 text-center text-sm font-medium transition-all active:scale-[0.98] ${
                      user
                        ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
                  >
                    {/* Uniform signed-out CTA — per-card variations
                        ("Try it free" vs "Get started") read as tier
                        signals that don't exist. */}
                    {user ? "Open in TackUI" : "Get started"}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-12 text-center text-sm text-zinc-500">
          Every agent runs on the AG-UI protocol — your workspace, your
          conversations.
        </p>
      </div>
    </MarketingLayout>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicAgent } from "@/lib/agents/agents.config";
import type { PublicAgentTemplate } from "@/lib/catalog/catalog.config";
import { planSatisfies, type PlanId } from "@/lib/billing/plans";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import { useBilling } from "@/lib/billing/use-billing";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { BackToChat } from "@/components/back-to-chat";

/**
 * In-app agent catalog — one-click install of curated templates into the
 * active workspace. Available in both SaaS and self-host modes (the
 * catalog is product infrastructure; only plan gates/quotas are
 * SaaS-enforced server-side).
 *
 * Installing changes the org's agent list, so the install button shows
 * for org owners/admins (canManage) — same gate as manual agent
 * creation. Everyone else can browse.
 */

export default function CatalogPage() {
  const { canManage, loading: canManageLoading } = useCanManageAgents();
  const { billing } = useBilling();
  const [templates, setTemplates] = useState<PublicAgentTemplate[]>([]);
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // The org's effective plan for client-side gate previews. billing is
  // null on self-host / SaaS-without-Stripe — everything is allowed
  // there (matching the server's short-circuit).
  const orgPlan = (billing?.plan ?? "self-host") as PlanId;
  const isSaas = billing !== null;

  // At the plan's live-agent cap (tombstones don't count), the install
  // button becomes an upgrade CTA — clicking "Add" would just 402.
  const maxAgents = isSaas ? (billing?.limits?.maxAgents ?? null) : null;
  const liveAgentCount = agents.filter((a) => !a.templateRemovedAt).length;
  const atCap = maxAgents !== null && liveAgentCount >= maxAgents;

  const load = useCallback(async () => {
    const [tplRes, agentRes] = await Promise.all([
      fetch("/api/catalog"),
      fetch("/api/agents"),
    ]);
    if (tplRes.ok) setTemplates(await tplRes.json());
    if (agentRes.ok) setAgents(await agentRes.json());
    setLoading(false);
  }, []);

  // Ref indirection (same pattern as the agents page) so the initial
  // fetch from the effect doesn't setState synchronously.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    loadRef.current();
  }, []);

  const install = async (template: PublicAgentTemplate) => {
    setBusyId(template.id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/catalog/${template.id}/install`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Plan-blocked → open the upgrade dialog (the 402 copy explains
        // the gate; the dialog is the upgrade path).
        if (data.code === "PLAN_AGENT_LOCKED" || data.code === "PLAN_AGENT_LIMIT") {
          setError(typeof data.error === "string" ? data.error : null);
          setUpgradeOpen(true);
        } else {
          setError(
            (typeof data.error === "string" && data.error) ||
              `Install failed (${res.status})`,
          );
        }
        return;
      }
      setMessage(
        data.installed
          ? `${template.name} was added to your workspace.`
          : `${template.name} is up to date.`,
      );
      await load();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusyId(null);
    }
  };

  if (canManageLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-sm text-zinc-400">Loading catalog...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-10">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Agent catalog
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Ready-to-use agents, one click to add to your workspace. No
              configuration needed.
            </p>
          </div>
          <BackToChat />
        </header>

        {message && (
          <div className="mb-6 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
            {message}
          </div>
        )}
        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        {templates.length === 0 ? (
          <p className="text-sm text-zinc-400">
            The catalog is empty — no agents have been published yet.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {templates.map((template) => (
              <CatalogCard
                key={template.id}
                template={template}
                installed={agents.find((a) => a.sourceTemplateId === template.id)}
                orgPlan={orgPlan}
                isSaas={isSaas}
                atCap={atCap}
                canManage={canManage === true}
                busy={busyId === template.id}
                onInstall={() => install(template)}
                onUpgrade={() => setUpgradeOpen(true)}
              />
            ))}
          </div>
        )}
      </div>

      {isSaas && <UpgradeDialog open={upgradeOpen} onClose={() => setUpgradeOpen(false)} />}
    </div>
  );
}

function CatalogCard({
  template,
  installed,
  orgPlan,
  isSaas,
  atCap,
  canManage,
  busy,
  onInstall,
  onUpgrade,
}: {
  template: PublicAgentTemplate;
  installed: PublicAgent | undefined;
  orgPlan: PlanId;
  isSaas: boolean;
  atCap: boolean;
  canManage: boolean;
  busy: boolean;
  onInstall: () => void;
  onUpgrade: () => void;
}) {
  const locked =
    isSaas &&
    !!template.requiredPlan &&
    !planSatisfies(orgPlan, template.requiredPlan);
  // Vague-copy policy: never state the quota number. The card shows the
  // tier difference, not the cap.
  const showQuotaNote = isSaas && template.freeDailyQuota != null && orgPlan === "free";

  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
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
            <h3 className="font-medium text-zinc-900 dark:text-zinc-50">
              {template.name}
            </h3>
            {template.category && (
              <p className="mt-0.5 text-xs text-zinc-400">{template.category}</p>
            )}
          </div>
        </div>
        {template.requiredPlan && (
          <span className="shrink-0 rounded-full bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white">
            {locked ? "🔒 " : ""}
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
        {showQuotaNote && (
          <p className="mb-3 text-xs text-zinc-400">
            Daily usage limit · unlimited on Pro
          </p>
        )}
        {locked ? (
          <button
            onClick={onUpgrade}
            disabled={!isSaas}
            className="w-full rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950"
          >
            Upgrade to {template.requiredPlan === "team" ? "Team" : "Pro"} to
            unlock
          </button>
        ) : installed ? (
          // Live propagation: template edits reach installed agents
          // automatically — there's no user-facing update action.
          <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-500 dark:border-zinc-800">
            <span className="text-green-600 dark:text-green-400">✓</span>
            Added to workspace
          </div>
        ) : canManage ? (
          atCap ? (
            // At the plan's agent cap the install would just 402 — the
            // honest button is the upgrade path (same as a plan-locked
            // card; the install route still enforces the cap).
            <button
              onClick={onUpgrade}
              className="w-full rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950"
            >
              Upgrade to add more agents
            </button>
          ) : (
            <button
              onClick={onInstall}
              disabled={busy}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 active:scale-[0.99]"
            >
              {busy ? "Adding..." : "Add to workspace"}
            </button>
          )
        ) : (
          <p className="text-center text-xs text-zinc-400">
            Ask your workspace admin to add this agent.
          </p>
        )}
      </div>
    </div>
  );
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PlatformAdmin } from "@/components/platform-admin";
import { BackToChat } from "@/components/back-to-chat";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";

/**
 * Models & tools — the deployment's agent catalog: which model providers
 * and toolkits the builder offers. Gated to platform admins
 * (role === "admin"), identical to /admin — org owners/admins are NOT
 * platform admins. The catalog is global (one shared AgentOS), so who may
 * edit it must be global too; members are redirected to /app. The
 * AgentOS-side admin API is reachable ONLY through tackui's proxy routes —
 * the platform's JWT secret never reaches the browser.
 */
export default function PlatformAdminPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { config } = useAuthConfig();

  useEffect(() => {
    if (isPending || !config) return;
    // Solo mode (AUTH_DISABLED=true) — everyone is the platform admin.
    if (config.authDisabled) return;
    if (!session) {
      router.push("/login");
      return;
    }
    if (session.user.role !== "admin") {
      router.push("/app");
    }
  }, [session, isPending, config, router]);

  if (
    isPending ||
    !config ||
    (!session && !config.authDisabled) ||
    (!config.authDisabled && session?.user?.role !== "admin")
  ) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black">
        <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-10">
          <p className="text-sm text-zinc-500">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-10 text-zinc-900 dark:text-zinc-100">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Models &amp; tools
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              What the agent builder offers. Tick providers and toolkits, list
              model ids — everything else (credential contracts, function
              lists) is derived automatically. Changes go live without a
              restart.
            </p>
          </div>
          <BackToChat />
        </header>
        <PlatformAdmin />
      </div>
    </div>
  );
}

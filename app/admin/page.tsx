"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CatalogAdmin } from "@/components/catalog-admin";
import { UsersAdmin } from "@/components/users-admin";
import { BackToChat } from "@/components/back-to-chat";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";

/**
 * Platform admin — global catalog templates + user management. Split out
 * of /agents so that page stays purely workspace-scoped (org agent
 * backends); this surface is cross-org and gated to platform admins
 * (role === "admin") — org owners/admins are NOT platform admins. Solo
 * mode's synthetic admin passes via the authDisabled branch.
 */
export default function AdminPage() {
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
  }, [session, isPending, router, config]);

  if (
    isPending ||
    !config ||
    (!session && !config.authDisabled) ||
    (!config.authDisabled && session?.user?.role !== "admin")
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-10">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Admin settings
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Global agent-catalog templates and user management. Workspace
              agent backends live on the{" "}
              <Link
                href="/agents"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                Agents
              </Link>{" "}
              page instead.
            </p>
          </div>
          <BackToChat />
        </header>

        <CatalogAdmin />

        <UsersAdmin />
      </div>
    </div>
  );
}

"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CopilotChat, useCopilotKit } from "@copilotkit/react-core/v2";
import { AgentSidebar } from "./agent-sidebar";
import { HitlHandlers } from "./hitl/approval-card";
import { ToolRenders } from "./tools/tool-renders";
import { authClient } from "@/lib/auth/auth-client";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import type { AgentEntry } from "@/lib/agents/agents.config";

export function ChatShell() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const { config } = useAuthConfig();
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [activeAgent, setActiveAgent] = useState("");
  const [activeThreadId, setActiveThreadId] = useState(() =>
    crypto.randomUUID(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("sidebarCollapsed") === "true";
  });

  // Admin = real session admin role OR solo mode (synthetic admin from server).
  const isAdmin = session?.user.role === "admin" || (config?.authDisabled ?? false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/agents");
      if (cancelled) return;
      if (res.status === 401) {
        // Solo mode never 401s, so this only fires when auth is enabled.
        router.push("/login");
        return;
      }
      if (!res.ok) return;
      const list: AgentEntry[] = await res.json();
      setAgents(list);
      setHasLoaded(true);
      setActiveAgent((prev) => {
        const stillExists = list.some((a) => a.id === prev);
        return stillExists ? prev : list[0]?.id ?? "";
      });
    };
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [router]);

  const handleSelectAgent = useCallback((id: string) => {
    setActiveAgent(id);
    setActiveThreadId(crypto.randomUUID());
  }, []);

  const handleNewChat = useCallback(() => {
    setActiveThreadId(crypto.randomUUID());
  }, []);

  const handleSelectThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebarCollapsed", String(next));
      return next;
    });
  }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-zinc-50 dark:bg-black">
      <AgentSidebar
        agents={agents}
        activeAgent={activeAgent}
        activeThreadId={activeThreadId}
        onSelectAgent={handleSelectAgent}
        onNewChat={handleNewChat}
        onSelectThread={handleSelectThread}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        {activeAgent ? (
          <>
            <HitlHandlers agentId={activeAgent} />
            <ToolRenders agentId={activeAgent} />
            <AgentChat agentId={activeAgent} threadId={activeThreadId} />
          </>
        ) : hasLoaded ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            {isAdmin ? (
              <>
                <p className="text-sm text-zinc-400">
                  No agents configured yet.
                </p>
                <Link
                  href="/agents"
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                >
                  Add your first agent →
                </Link>
              </>
            ) : (
              <p className="text-sm text-zinc-400">
                No agents available yet. Ask your administrator to add one.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
            Loading agents...
          </div>
        )}
      </main>
    </div>
  );
}

function AgentChat({ agentId, threadId }: { agentId: string; threadId: string }) {
  const { copilotkit } = useCopilotKit();

  useEffect(() => {
    return () => {
      const agent = copilotkit.getAgent(agentId);
      if (agent && agent.messages.length > 0) agent.setMessages([]);
    };
  }, [agentId, copilotkit]);

  return (
    <CopilotChat
      key={agentId + threadId}
      agentId={agentId}
      threadId={threadId}
      className="flex-1"
    />
  );
}

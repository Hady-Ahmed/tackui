"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CopilotChat, useCopilotKit } from "@copilotkit/react-core/v2";
import { AgentSidebar } from "./agent-sidebar";
import { HitlHandlers } from "./hitl/approval-card";
import { ToolRenders } from "./tools/tool-renders";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";
import type { PublicAgent } from "@/lib/agents/agents.config";

export function ChatShell() {
  const router = useRouter();
  const { config } = useAuthConfig();
  const { canManage } = useCanManageAgents();
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [activeAgent, setActiveAgent] = useState("");
  const [activeThreadId, setActiveThreadId] = useState(() =>
    crypto.randomUUID(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Read the persisted collapsed state AFTER hydration to avoid a
  // server/client mismatch (server has no window/localStorage).
  // Uses ref indirection to satisfy react-hooks/set-state-in-effect.
  const applyStoredCollapsed = useRef(() => {
    const stored = localStorage.getItem("sidebarCollapsed");
    if (stored === "true") setSidebarCollapsed(true);
  });
  useEffect(() => {
    applyStoredCollapsed.current();
  }, []);

  // Show the empty-state CTA to org owners/admins OR in solo mode.
  const canManageAgents_ = canManage === true || (config?.authDisabled ?? false);

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
      const list: PublicAgent[] = await res.json();
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
    setRunError(null);
  }, []);

  const handleNewChat = useCallback(() => {
    setActiveThreadId(crypto.randomUUID());
    setRunError(null);
  }, []);

  const handleSelectThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    setRunError(null);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebarCollapsed", String(next));
      return next;
    });
  }, []);

  const activeAgentName =
    agents.find((a) => a.id === activeAgent)?.name ?? "Chat";

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
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar — hamburger + active agent name. Hidden on
            desktop (md+). */}
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 md:hidden dark:border-zinc-800">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-1.5 text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            aria-label="Open sidebar"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-5 w-5"
            >
              <path
                fillRule="evenodd"
                d="M2 4.75A.75.75 0 0 1 2.75 4h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8ZM2.75 11.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <span className="truncate text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {activeAgentName}
          </span>
        </div>
        {activeAgent ? (
          <>
            {runError && (
              <div className="mx-4 mt-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                <span>{runError}</span>
                <button
                  type="button"
                  onClick={() => setRunError(null)}
                  aria-label="Dismiss"
                  className="shrink-0 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200"
                >
                  x
                </button>
              </div>
            )}
            <HitlHandlers agentId={activeAgent} />
            <ToolRenders agentId={activeAgent} />
            <AgentChat
              agentId={activeAgent}
              threadId={activeThreadId}
              onRunError={setRunError}
            />
          </>
        ) : hasLoaded ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            {canManageAgents_ ? (
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
                <a
                  href="https://docs.ag-ui.com/quickstart/server"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-zinc-500 hover:text-zinc-400"
                >
                  Need a backend? AG-UI quickstart →
                </a>
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

function AgentChat({
  agentId,
  threadId,
  onRunError,
}: {
  agentId: string;
  threadId: string;
  onRunError: (msg: string | null) => void;
}) {
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
      onError={(event) => {
        // CopilotChat's onError is a union: either the AG-UI error event
        // ({ error, code, context }) or a passthrough React SyntheticEvent.
        // Discriminate: the AG-UI event carries an `error` field (an Error).
        if (!("error" in event)) return;
        const error = event.error;
        // Ignore user-initiated cancels and empty aborts.
        const msg = error?.message ?? "";
        if (
          error?.name === "AbortError" ||
          msg === "Fetch is aborted" ||
          msg === "signal is aborted without reason" ||
          msg === "component unmounted" ||
          msg === ""
        ) {
          return;
        }
        // Only surface HTTP 429s in the UI (concurrent cap + 20/min run limit).
        const status = (error as Error & { status?: number }).status;
        if (status !== 429) return;
        const payload = (error as Error & { payload?: unknown }).payload;
        const serverMsg =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : msg;
        onRunError(serverMsg || "Too many requests. Try again shortly.");
      }}
    />
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useThreads, useAgent } from "@copilotkit/react-core/v2";
import type { PublicAgent, AgentKind } from "@/lib/agents/agents.config";
import { AccountMenu } from "./account-menu";
import { ThemeToggle } from "./theme-toggle";
import { useAuthConfig } from "@/lib/auth/use-auth-config";
import { useCanManageAgents } from "@/lib/auth/use-can-manage-agents";

type TestStatus = "idle" | "loading" | "ok" | "fail";
type TestResult = { status: TestStatus; message?: string };

const TEST_HELP =
  "Tests only that the server is reachable (an HTTP request succeeds). " +
  "A success does NOT validate auth, AG-UI protocol compliance, or that the agent will actually run. " +
  "A failure usually means the URL is wrong or the server is down.";

async function testEndpoint(
  endpoint: string,
  kind: AgentKind,
): Promise<TestResult> {
  try {
    const res = await fetch("/api/agents/reachability-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, kind }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        status: "fail",
        message:
          (typeof data === "object" && data && "error" in data
            ? String((data as { error: unknown }).error)
            : `Validation failed (${res.status})`),
      };
    }
    return {
      status: data.ok ? "ok" : "fail",
      message: data.message as string,
    };
  } catch {
    return { status: "fail", message: "Network error talking to /api/agents/reachability-probe" };
  }
}

function dotClass(status: TestStatus): string {
  switch (status) {
    case "loading":
      return "bg-zinc-400 animate-pulse";
    case "ok":
      return "bg-green-500";
    case "fail":
      return "bg-red-500";
    default:
      return "bg-zinc-300 dark:bg-zinc-600";
  }
}

function dotTitle(status: TestStatus, message?: string): string {
  switch (status) {
    case "idle":
      return "Not tested yet";
    case "loading":
      return "Testing connection...";
    default:
      return message || "";
  }
}

interface AgentSidebarProps {
  agents: PublicAgent[];
  activeAgent: string;
  activeThreadId: string;
  onSelectAgent: (id: string) => void;
  onNewChat: () => void;
  onSelectThread: (threadId: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function AgentSidebar({
  agents,
  activeAgent,
  activeThreadId,
  onSelectAgent,
  onNewChat,
  onSelectThread,
  collapsed,
  onToggleCollapse,
}: AgentSidebarProps) {
  const [statuses, setStatuses] = useState<Record<string, TestResult>>({});
  const { config } = useAuthConfig();
  const { canManage } = useCanManageAgents();
  // Show the "Manage agents" link to org owners/admins (canManage from
  // /api/auth/can-manage-agents) OR in solo mode (synthetic admin).
  const showManageLink = canManage === true || (config?.authDisabled ?? false);

  useEffect(() => {
    let cancelled = false;
    const testAll = async () => {
      const entries = agents.map((a) => ({
        id: a.id,
        endpoint: a.endpoint,
        kind: a.kind,
      }));
      setStatuses((prev) => {
        const next: Record<string, TestResult> = {};
        for (const e of entries) next[e.id] = { status: "loading" };
        for (const id of Object.keys(prev)) {
          if (!next[id]) next[id] = prev[id];
        }
        return next;
      });

      const results = await Promise.all(
        entries.map(async (e) => ({
          id: e.id,
          result: await testEndpoint(e.endpoint, e.kind),
        })),
      );
      if (cancelled) return;
      setStatuses((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.id] = r.result;
        return next;
      });
    };
    testAll();
    const onFocus = () => testAll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [agents]);

  return (
    <aside
      className={`flex flex-col overflow-hidden border-r border-zinc-200 bg-white transition-[width] duration-200 ease-in-out dark:border-zinc-800 dark:bg-zinc-950 ${
        collapsed ? "w-14 items-center py-3" : "w-64"
      }`}
    >
      {collapsed ? (
        <CollapsedContent
          agents={agents}
          activeAgent={activeAgent}
          statuses={statuses}
          onSelectAgent={onSelectAgent}
          onNewChat={onNewChat}
          onToggleCollapse={onToggleCollapse}
          showManageLink={showManageLink}
        />
      ) : (
        <ExpandedContent
          agents={agents}
          activeAgent={activeAgent}
          activeThreadId={activeThreadId}
          statuses={statuses}
          onSelectAgent={onSelectAgent}
          onNewChat={onNewChat}
          onSelectThread={onSelectThread}
          onToggleCollapse={onToggleCollapse}
          showManageLink={showManageLink}
        />
      )}
    </aside>
  );
}

function ExpandedContent({
  agents,
  activeAgent,
  activeThreadId,
  statuses,
  onSelectAgent,
  onNewChat,
  onSelectThread,
  onToggleCollapse,
  showManageLink,
}: {
  agents: PublicAgent[];
  activeAgent: string;
  activeThreadId: string;
  statuses: Record<string, TestResult>;
  onSelectAgent: (id: string) => void;
  onNewChat: () => void;
  onSelectThread: (threadId: string) => void;
  onToggleCollapse: () => void;
  showManageLink: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 p-4 dark:border-zinc-800">
        <div>
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            TackUI
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Unified agent frontend
          </p>
        </div>
        <button
          onClick={onToggleCollapse}
          title="Collapse sidebar"
          className="shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          aria-label="Collapse sidebar"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M9.78 4.22a.75.75 0 0 1 0 1.06L7.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      <div className="p-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-center rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          + New Chat
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        <div className="flex items-center gap-1 px-2 py-1">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Agents
          </p>
          <span
            className="inline-flex cursor-help text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
            title={TEST_HELP}
            aria-label="What do the status dots mean?"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm0-9a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM7 7a.75.75 0 0 0 0 1.5h.25v2.5H7a.75.75 0 0 0 0 1.5h2a.75.75 0 0 0 0-1.5h-.25v-3A.75.75 0 0 0 8 7H7Z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        </div>
        <ul className="space-y-0.5">
          {agents.map((agent) => (
            <li key={agent.id}>
              <button
                onClick={() => onSelectAgent(agent.id)}
                className={`flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors ${
                  activeAgent === agent.id
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                <div className="flex w-full items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass(
                      (statuses[agent.id] ?? { status: "idle" }).status,
                    )}`}
                    title={dotTitle(
                      (statuses[agent.id] ?? { status: "idle" }).status,
                      statuses[agent.id]?.message,
                    )}
                    aria-label={`Connection status: ${dotTitle(
                      (statuses[agent.id] ?? { status: "idle" }).status,
                      statuses[agent.id]?.message,
                    )}`}
                  />
                  <span className="text-sm font-medium">{agent.name}</span>
                </div>
                <span className="mt-0.5 text-xs text-zinc-400">
                  {agent.description}
                </span>
                <span className="mt-1 inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {agent.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {activeAgent && (
          <ConversationList
            agentId={activeAgent}
            activeThreadId={activeThreadId}
            onSelectThread={onSelectThread}
            onNewChat={onNewChat}
          />
        )}
      </nav>

      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <AccountMenu />
        <ThemeToggle />
        {showManageLink && (
          <Link
            href="/agents"
            className="mt-2 flex w-full items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Manage agents
          </Link>
        )}
      </div>
    </>
  );
}

function CollapsedContent({
  agents,
  activeAgent,
  statuses,
  onSelectAgent,
  onNewChat,
  onToggleCollapse,
  showManageLink,
}: {
  agents: PublicAgent[];
  activeAgent: string;
  statuses: Record<string, TestResult>;
  onSelectAgent: (id: string) => void;
  onNewChat: () => void;
  onToggleCollapse: () => void;
  showManageLink: boolean;
}) {
  return (
    <>
      <button
        onClick={onToggleCollapse}
        title="Expand sidebar"
        className="mb-3 rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label="Expand sidebar"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-4 w-4"
        >
          <path
            fillRule="evenodd"
            d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 1 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      <button
        onClick={onNewChat}
        title="New chat"
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 text-lg text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        aria-label="New chat"
      >
        +
      </button>

      <nav className="flex flex-1 flex-col items-center gap-1 overflow-y-auto">
        {agents.map((agent) => {
          const st = statuses[agent.id] ?? { status: "idle" as TestStatus };
          const isActive = activeAgent === agent.id;
          return (
            <button
              key={agent.id}
              onClick={() => onSelectAgent(agent.id)}
              title={agent.name}
              className={`relative flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium transition-colors ${
                isActive
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
              aria-label={agent.name}
            >
              {agent.name.charAt(0).toUpperCase()}
              <span
                className={`absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full border border-white dark:border-zinc-950 ${dotClass(
                  st.status,
                )}`}
              />
            </button>
          );
        })}
      </nav>

      {showManageLink && (
        <Link
          href="/agents"
          title="Manage agents"
          className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          aria-label="Manage agents"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M8 1a2.5 2.5 0 0 1 2.45 2.01l.05.24.24.05a2.5 2.5 0 0 1 1.7 3.7l-.12.21.12.21a2.5 2.5 0 0 1-1.7 3.7l-.24.05-.05.24a2.5 2.5 0 0 1-4.9 0l-.05-.24-.24-.05a2.5 2.5 0 0 1-1.7-3.7l.12-.21-.12-.21a2.5 2.5 0 0 1 1.7-3.7l.24-.05.05-.24A2.5 2.5 0 0 1 8 1Zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"
              clipRule="evenodd"
            />
          </svg>
        </Link>
      )}

      <div className="mt-2 flex flex-col items-center gap-1">
        <ThemeToggle collapsed />
        <AccountMenu />
      </div>
    </>
  );
}

function ConversationList({
  agentId,
  activeThreadId,
  onSelectThread,
  onNewChat,
}: {
  agentId: string;
  activeThreadId: string;
  onSelectThread: (threadId: string) => void;
  onNewChat: () => void;
}) {
  const { threads, isLoading, refetchThreads } = useThreads({ agentId });
  const { agent } = useAgent({ agentId });
  const refetchRef = useRef(refetchThreads);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refetchRef.current = refetchThreads;
  }, [refetchThreads]);

  useEffect(() => {
    if (!agent) return;
    const subscription = agent.subscribe({
      onRunFinalized: () => refetchRef.current(),
      onRunFailed: () => refetchRef.current(),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const startRename = (threadId: string, currentName: string) => {
    setEditingId(threadId);
    setEditValue(currentName || "");
    setError(null);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditValue("");
    setError(null);
  };

  const submitRename = async (threadId: string) => {
    const title = editValue.trim();
    if (!title) {
      cancelRename();
      return;
    }
    const res = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(
        (typeof data === "object" && data && "error" in data
          ? String((data as { error: unknown }).error)
          : null) || "Rename failed",
      );
      return;
    }
    cancelRename();
    refetchThreads();
  };

  const handleDelete = async (threadId: string) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    const res = await fetch(`/api/threads/${threadId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(
        (typeof data === "object" && data && "error" in data
          ? String((data as { error: unknown }).error)
          : null) || "Delete failed",
      );
      return;
    }
    if (threadId === activeThreadId) onNewChat();
    refetchThreads();
  };

  if (isLoading) {
    return (
      <div className="mt-4">
        <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
          Conversations
        </p>
        <div className="px-3 py-2 text-xs text-zinc-400">Loading...</div>
      </div>
    );
  }

  if (!threads || threads.length === 0) {
    return (
      <div className="mt-4">
        <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
          Conversations
        </p>
        <div className="px-3 py-2 text-xs text-zinc-400">
          No conversations yet
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Conversations
      </p>
      {error && (
        <p className="mx-2 mb-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-600 dark:bg-red-950 dark:text-red-400">
          {error}
        </p>
      )}
      <ul className="space-y-0.5">
        {threads.map((thread) => {
          const isEditing = editingId === thread.id;
          const name = thread.name || "New conversation";

          if (isEditing) {
            return (
              <li
                key={thread.id}
                className="flex items-center gap-1 rounded-lg px-2 py-1"
              >
                <input
                  ref={editInputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitRename(thread.id);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  maxLength={200}
                  className="w-full rounded border border-blue-400 bg-white px-2 py-1 text-sm outline-none dark:bg-zinc-900 dark:text-zinc-50"
                />
                <button
                  onClick={() => submitRename(thread.id)}
                  title="Save"
                  className="shrink-0 text-xs font-medium text-green-600 hover:underline dark:text-green-400"
                >
                  ✓
                </button>
                <button
                  onClick={cancelRename}
                  title="Cancel"
                  className="shrink-0 text-xs font-medium text-zinc-400 hover:underline"
                >
                  ✕
                </button>
              </li>
            );
          }

          return (
            <li
              key={thread.id}
              className={`group flex items-center gap-1 rounded-lg pr-1 transition-colors ${
                activeThreadId === thread.id
                  ? "bg-zinc-100 dark:bg-zinc-800"
                  : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
              }`}
            >
              <button
                onClick={() => onSelectThread(thread.id)}
                className={`flex-1 truncate px-3 py-2 text-left text-sm ${
                  activeThreadId === thread.id
                    ? "font-medium text-zinc-900 dark:text-zinc-50"
                    : "text-zinc-600 dark:text-zinc-400"
                }`}
              >
                {name}
              </button>
              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => startRename(thread.id, name)}
                  title="Rename"
                  className="px-1 py-1 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path d="M11.06.94a1.5 1.5 0 0 0-2.12 0l-7.5 7.5a1.5 1.5 0 0 0-.44 1.06v2.5a.75.75 0 0 0 .75.75h2.5a1.5 1.5 0 0 0 1.06-.44l7.5-7.5a1.5 1.5 0 0 0 0-2.12l-1.75-1.75ZM3.75 12L9 6.75 10.25 8 5 13.25H3.75V12Z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDelete(thread.id)}
                  title="Delete"
                  className="px-1 py-1 text-xs text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5 2.5A.5.5 0 0 1 5.5 2H10.5a.5.5 0 0 1 .5.5V4h2.5a.5.5 0 0 1 0 1H13v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5h-.5a.5.5 0 0 1 0-1H5V2.5Zm1 1V4h4V3.5H6ZM5 6.5a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0v-5Zm3 0a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0v-5Zm3 0a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0v-5Z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

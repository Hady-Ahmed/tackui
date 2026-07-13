"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useThreads, useAgent } from "@copilotkit/react-core/v2";
import type { AgentEntry, AgentKind } from "@/lib/agents/agents.config";

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
    const res = await fetch("/api/agents/test", {
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
    return { status: "fail", message: "Network error talking to /api/agents/test" };
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
  agents: AgentEntry[];
  activeAgent: string;
  activeThreadId: string;
  onSelectAgent: (id: string) => void;
  onNewChat: () => void;
  onSelectThread: (threadId: string) => void;
}

export function AgentSidebar({
  agents,
  activeAgent,
  activeThreadId,
  onSelectAgent,
  onNewChat,
  onSelectThread,
}: AgentSidebarProps) {
  const [statuses, setStatuses] = useState<Record<string, TestResult>>({});

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
    <aside className="flex w-64 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
        <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          AG-UI Chat
        </h1>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Unified agent frontend
        </p>
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
          />
        )}
      </nav>

      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <Link
          href="/agents"
          className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Manage agents
        </Link>
      </div>
    </aside>
  );
}

function ConversationList({
  agentId,
  activeThreadId,
  onSelectThread,
}: {
  agentId: string;
  activeThreadId: string;
  onSelectThread: (threadId: string) => void;
}) {
  const { threads, isLoading, refetchThreads } = useThreads({ agentId });
  const { agent } = useAgent({ agentId });
  const refetchRef = useRef(refetchThreads);

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
      <ul className="space-y-0.5">
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              onClick={() => onSelectThread(thread.id)}
              className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                activeThreadId === thread.id
                  ? "bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }`}
            >
              {thread.name || "New conversation"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

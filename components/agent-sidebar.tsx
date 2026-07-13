"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useThreads, useAgent } from "@copilotkit/react-core/v2";
import type { AgentEntry } from "@/lib/agents/agents.config";

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
        <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
          Agents
        </p>
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
                <span className="text-sm font-medium">{agent.name}</span>
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

"use client";

import { useState, useCallback, useEffect } from "react";
import { CopilotChat, useCopilotKit } from "@copilotkit/react-core/v2";
import { AgentSidebar } from "./agent-sidebar";
import { HitlHandlers } from "./hitl/approval-card";
import { ToolRenders } from "./tools/tool-renders";
import type { AgentEntry } from "@/lib/agents/agents.config";

export function ChatShell() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [activeAgent, setActiveAgent] = useState("");
  const [activeThreadId, setActiveThreadId] = useState(() =>
    crypto.randomUUID(),
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/agents");
      if (cancelled || !res.ok) return;
      const list: AgentEntry[] = await res.json();
      setAgents(list);
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
  }, []);

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

  return (
    <div className="flex h-screen w-full overflow-hidden bg-zinc-50 dark:bg-black">
      <AgentSidebar
        agents={agents}
        activeAgent={activeAgent}
        activeThreadId={activeThreadId}
        onSelectAgent={handleSelectAgent}
        onNewChat={handleNewChat}
        onSelectThread={handleSelectThread}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        {activeAgent ? (
          <>
            <HitlHandlers agentId={activeAgent} />
            <ToolRenders agentId={activeAgent} />
            <AgentChat agentId={activeAgent} threadId={activeThreadId} />
          </>
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

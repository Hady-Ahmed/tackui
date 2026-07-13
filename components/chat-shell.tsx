"use client";

import { useState, useCallback, useEffect } from "react";
import { CopilotChat, useCopilotKit } from "@copilotkit/react-core/v2";
import { AgentSidebar } from "./agent-sidebar";
import { HitlHandlers } from "./hitl/approval-card";
import { ToolRenders } from "./tools/tool-renders";
import { agents } from "@/lib/agents/agents.config";

export function ChatShell() {
  const [activeAgent, setActiveAgent] = useState(agents[0]?.id ?? "");
  const [activeThreadId, setActiveThreadId] = useState(() =>
    crypto.randomUUID(),
  );

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
        <HitlHandlers agentId={activeAgent} />
        <ToolRenders agentId={activeAgent} />
        <AgentChat agentId={activeAgent} threadId={activeThreadId} />
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

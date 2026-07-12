"use client";

import { useState, useCallback } from "react";
import { CopilotChat } from "@copilotkit/react-core/v2";
import { AgentSidebar } from "./agent-sidebar";
import { HitlHandlers } from "./hitl/approval-card";
import { ToolRenders } from "./tools/tool-renders";
import { agents } from "@/lib/agents/agents.config";

export function ChatShell() {
  const [activeAgent, setActiveAgent] = useState(agents[0]?.id ?? "");
  const [threadIds, setThreadIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(agents.map((a) => [a.id, crypto.randomUUID()]))
  );

  const threadId = threadIds[activeAgent];

  const handleNewChat = useCallback(() => {
    setThreadIds((prev) => ({ ...prev, [activeAgent]: crypto.randomUUID() }));
  }, [activeAgent]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-zinc-50 dark:bg-black">
      <AgentSidebar
        agents={agents}
        activeAgent={activeAgent}
        onSelectAgent={setActiveAgent}
        onNewChat={handleNewChat}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <HitlHandlers agentId={activeAgent} />
        <ToolRenders agentId={activeAgent} />
        <CopilotChat
          key={activeAgent + threadId}
          agentId={activeAgent}
          threadId={threadId}
          className="flex-1"
        />
      </main>
    </div>
  );
}

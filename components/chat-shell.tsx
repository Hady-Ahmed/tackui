"use client";

import { useState, useCallback, useEffect } from "react";
import { CopilotChat, useCopilotKit } from "@copilotkit/react-core/v2";
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
        <AgentChat agentId={activeAgent} threadId={threadId} />
      </main>
    </div>
  );
}

/**
 * Keyed wrapper around CopilotChat that clears the agent's in-memory messages
 * on unmount.
 *
 * Why: CopilotKit's InMemoryAgentRunner /connect replays ALL historic events on
 * every connect (no cursor). AbstractAgent.apply() handles TEXT_MESSAGE_CONTENT
 * by appending the delta to an existing message's content. So if the agent
 * already has messages (from a prior connect or /run), the replay appends a
 * second copy of the text — and compounds on every subsequent connect.
 *
 * React StrictMode (Next.js dev default) double-invokes the connect effect
 * (mount → cleanup → remount), which doubles the duplication rate in dev.
 *
 * Clearing messages on unmount ensures every connect replay starts from an
 * empty list and builds exactly one copy. The key ensures this cleanup fires
 * on every agent switch AND between StrictMode's double-mount.
 */
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

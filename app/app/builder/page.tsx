"use client";

/**
 * /app/builder — the agent builder create page. Member-accessible (the
 * builder is Phase 1's "create your own agents"): any signed-in org member
 * can build an agent on the platform AgentOS service.
 */

import { BuilderPage } from "@/components/builder/builder-page";

export default function AgentBuilderPage() {
  return <BuilderPage mode="create" />;
}

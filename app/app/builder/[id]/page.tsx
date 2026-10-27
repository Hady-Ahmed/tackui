"use client";

/**
 * /app/builder/[id] — the agent builder edit page. Only builder-origin
 * agents authored by the current user are addressable here (the backend
 * PATCH/DELETE enforce the same; this page mirrors it — non-authors get a
 * 404-style state).
 */

import { useParams } from "next/navigation";
import { BuilderPage } from "@/components/builder/builder-page";

export default function AgentBuilderEditPage() {
  const params = useParams<{ id: string }>();
  return <BuilderPage mode="edit" agentId={params.id} />;
}

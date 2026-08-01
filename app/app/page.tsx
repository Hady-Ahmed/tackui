"use client";

import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { ChatShell } from "@/components/chat-shell";

export default function Home() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit">
      <ChatShell />
    </CopilotKitProvider>
  );
}

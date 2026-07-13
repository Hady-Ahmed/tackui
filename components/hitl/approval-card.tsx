"use client";

import { useInterrupt } from "@copilotkit/react-core/v2";

interface HitlHandlersProps {
  agentId: string;
}

export function HitlHandlers({ agentId }: HitlHandlersProps) {
  useInterrupt({
    agentId,
    render: ({ event, interrupt, resolve, cancel }) => {
      let title = interrupt?.reason;
      let description = interrupt?.message;

      if ((!title || !description) && event?.value) {
        try {
          const value =
            typeof event.value === "string"
              ? JSON.parse(event.value)
              : event.value;
          title = title ?? value?.reason;
          description = description ?? value?.message;
        } catch {
          // value isn't JSON, fall through to defaults
        }
      }

      return (
        <ApprovalCard
          title={title ?? event.name ?? "Approval Required"}
          description={
            description ??
            "The agent is requesting your approval to proceed."
          }
          onApprove={() => resolve({ approved: true })}
          onDeny={() => resolve({ approved: false })}
        />
      );
    },
  });

  return null;
}

function ApprovalCard({
  title,
  description,
  onApprove,
  onDeny,
}: {
  title: string;
  description: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="my-2 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
      <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
        {title}
      </h3>
      <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
        {description}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={onApprove}
          className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700"
        >
          Approve
        </button>
        <button
          onClick={onDeny}
          className="rounded-lg bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

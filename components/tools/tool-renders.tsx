"use client";

import { useRenderTool } from "@copilotkit/react-core/v2";

interface ToolRendersProps {
  agentId: string;
}

export function ToolRenders({ agentId }: ToolRendersProps) {
  useRenderTool(
    {
      name: "*",
      agentId,
      render: ({ name, status, result }) => {
        if (status === "inProgress" || status === "executing") {
          return (
            <ToolCard name={name} status="running">
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Spinner />
                Executing...
              </div>
            </ToolCard>
          );
        }

        let parsedResult: unknown = result;
        try {
          parsedResult = result ? JSON.parse(result) : null;
        } catch {
          // keep raw string
        }

        return (
          <ToolCard name={name} status="complete">
            <pre className="overflow-x-auto text-xs text-zinc-600 dark:text-zinc-300">
              {parsedResult !== null
                ? JSON.stringify(parsedResult, null, 2)
                : "No result"}
            </pre>
          </ToolCard>
        );
      },
    },
    [agentId],
  );

  return null;
}

function ToolCard({
  name,
  status,
  children,
}: {
  name: string;
  status: "running" | "complete";
  children: React.ReactNode;
}) {
  return (
    <div className="my-2 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            status === "running" ? "animate-pulse bg-blue-500" : "bg-green-500"
          }`}
        />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {name}
        </span>
      </div>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-blue-500"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

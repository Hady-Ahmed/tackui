"use client";

import { useState } from "react";
import { useRenderTool } from "@copilotkit/react-core/v2";

interface ToolRendersProps {
  agentId: string;
}

export function ToolRenders({ agentId }: ToolRendersProps) {
  useRenderTool(
    {
      name: "*",
      render: ({ name, status, parameters, result }) => {
        const isRunning = status === "inProgress" || status === "executing";
        const parsedResult = status === "complete" ? tryParse(result) : null;
        const isError = status === "complete" && isErrorResult(result, parsedResult);

        return (
          <ToolCard
            name={name}
            status={isRunning ? "running" : isError ? "error" : "complete"}
            parameters={parameters}
            result={status === "complete" ? result : undefined}
            parsedResult={parsedResult}
            defaultExpanded={isRunning}
          />
        );
      },
    },
    [agentId],
  );

  return null;
}

function tryParse(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isErrorResult(rawResult: string | undefined, parsed: unknown): boolean {
  if (!rawResult) return false;
  if (parsed && typeof parsed === "object" && parsed !== null) {
    return "error" in parsed || "exception" in parsed;
  }
  const lower = rawResult.toLowerCase();
  return (
    lower.startsWith("error") ||
    lower.startsWith("exception") ||
    lower.includes("traceback")
  );
}

function ToolCard({
  name,
  status,
  parameters,
  result,
  parsedResult,
  defaultExpanded,
}: {
  name: string;
  status: "running" | "complete" | "error";
  parameters: unknown;
  result?: string;
  parsedResult: unknown;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  const dotColor =
    status === "running"
      ? "animate-pulse bg-blue-500"
      : status === "error"
        ? "bg-red-500"
        : "bg-green-500";

  const cardBorder =
    status === "error"
      ? "border-red-200 dark:border-red-900"
      : "border-zinc-200 dark:border-zinc-700";

  const hasExpandableContent =
    parameters != null || (result != null && result !== "");

  return (
    <div
      className={`my-2 rounded-xl border ${cardBorder} bg-white p-3 shadow-sm dark:bg-zinc-900`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotColor}`}
        />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {name}
        </span>
        {status === "running" && (
          <span className="text-xs text-zinc-400">Executing...</span>
        )}
        {status === "error" && (
          <span className="text-xs font-medium text-red-500">Failed</span>
        )}
        {hasExpandableContent && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="ml-auto shrink-0 text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
            title={expanded ? "Collapse" : "Expand"}
            aria-label={expanded ? "Collapse details" : "Expand details"}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`h-3.5 w-3.5 transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
            >
              <path
                fillRule="evenodd"
                d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
      </div>

      {expanded && hasExpandableContent && (
        <div className="mt-2 space-y-2">
          {parameters != null && (
            <div>
              <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                Arguments
              </p>
              <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {formatValue(parameters)}
              </pre>
            </div>
          )}
          {result != null && result !== "" && (
            <div>
              <div className="mb-0.5 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                  Result
                </p>
                <button
                  onClick={handleCopy}
                  className="text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
                  title="Copy result"
                  aria-label="Copy result"
                >
                  {copied ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="h-3.5 w-3.5 text-green-500"
                    >
                      <path
                        fillRule="evenodd"
                        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 0 1-1.06 0L2.22 10.78a.75.75 0 1 1 1.06-1.06L6 12.19l6.72-6.72a.75.75 0 0 1 1.06 0Z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="h-3.5 w-3.5"
                    >
                      <path d="M5.75 1a.75.75 0 0 0-.75.75V3H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h.25a.75.75 0 0 0 .75-.75v-7.5A.75.75 0 0 0 12.25 3H11V1.75a.75.75 0 0 0-.75-.75h-4.5ZM10 3H7V1.5h3V3ZM4 4.5h6a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Z" />
                    </svg>
                  )}
                </button>
              </div>
              <pre
                className={`overflow-x-auto rounded p-2 text-xs ${
                  status === "error"
                    ? "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400"
                    : "bg-zinc-50 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                }`}
              >
                {parsedResult !== null
                  ? typeof parsedResult === "string"
                    ? parsedResult
                    : JSON.stringify(parsedResult, null, 2)
                  : "No result"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

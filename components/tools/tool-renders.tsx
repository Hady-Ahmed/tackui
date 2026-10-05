"use client";

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useRenderTool } from "@copilotkit/react-core/v2";
import {
  argPreview,
  humanizeToolName,
  isArrayOfObjects,
  looksLikeMarkdown,
  normalizeResultString,
  prettyJson,
  toKeyValueRows,
  truncateRaw,
} from "@/lib/tools/format";

interface ToolRendersProps {
  agentId: string;
}

export function ToolRenders({ agentId }: ToolRendersProps) {
  useRenderTool(
    {
      name: "*",
      render: ({ name, status, parameters, result }) => {
        const isRunning = status === "inProgress" || status === "executing";

        return (
          <ToolCallRow
            name={name}
            running={isRunning}
            parameters={parameters}
            rawResult={status === "complete" ? result : undefined}
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
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isErrorResult(
  rawResult: string | undefined,
  parsed: unknown,
): boolean {
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

function ToolCallRow({
  name,
  running,
  parameters,
  rawResult,
}: {
  name: string;
  running: boolean;
  parameters: unknown;
  rawResult?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Memoized so the memoized ResultBody (and arg rows) never re-parse on
  // expand/copy re-renders — big results parse once on mount.
  const parsedResult = useMemo(
    () => (rawResult != null ? tryParse(rawResult) : null),
    [rawResult],
  );
  const error = useMemo(
    () => rawResult != null && isErrorResult(rawResult, parsedResult),
    [rawResult, parsedResult],
  );
  const paramsObj = useMemo(() => tryParse(parameters), [parameters]);
  const preview = useMemo(() => argPreview(parameters), [parameters]);
  const { argRows, argsJson, hasArgs } = useMemo(() => {
    const rows = toKeyValueRows(paramsObj);
    const json = rows === null ? prettyJson(paramsObj) : null;
    return {
      argRows: rows,
      argsJson: json,
      hasArgs: (rows !== null && rows.length > 0) || json !== null,
    };
  }, [paramsObj]);
  const hasResult = rawResult != null && rawResult !== "";
  const hasDetails = hasArgs || hasResult;

  const handleCopy = async () => {
    if (!rawResult) return;
    try {
      await navigator.clipboard.writeText(rawResult);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  return (
    <div className="my-2">
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={hasDetails ? expanded : undefined}
        className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
          hasDetails
            ? "cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
            : "cursor-default"
        }`}
      >
        <StatusIcon running={running} error={error} />
        <span
          className={`shrink-0 text-xs font-medium ${
            error
              ? "text-red-600 dark:text-red-400"
              : "text-zinc-600 dark:text-zinc-300"
          }`}
        >
          {humanizeToolName(name)}
        </span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-400 dark:text-zinc-500">
            {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {running && (
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-blue-500">
            Running
          </span>
        )}
        {error && (
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-red-500">
            Failed
          </span>
        )}
        {hasDetails && <ChevronIcon open={expanded} />}
      </button>

      {expanded && hasDetails && (
        <div className="ml-2 mt-1 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/40">
          <div className="space-y-2.5">
            {hasArgs && (
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Arguments
                </p>
                {argRows && argRows.length > 0 ? (
                  <dl className="space-y-1">
                    {argRows.map(([key, value]) => (
                      <div
                        key={key}
                        className="grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 text-xs"
                      >
                        <dt className="truncate font-medium text-zinc-500 dark:text-zinc-400">
                          {key}
                        </dt>
                        <dd className="min-w-0 break-words whitespace-pre-wrap font-mono text-zinc-600 dark:text-zinc-300">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-xs text-zinc-600 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700/60">
                    {argsJson}
                  </pre>
                )}
              </div>
            )}

            {hasResult && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    Result
                  </p>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
                    title="Copy result"
                    aria-label="Copy result"
                  >
                    {copied ? <CopiedIcon /> : <CopyIcon />}
                  </button>
                </div>
                <MemoizedResultBody
                  rawResult={rawResult}
                  parsedResult={parsedResult}
                  error={error}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const TABLE_CELL_MAX_CHARS = 200;

type ResultRender =
  | { kind: "error"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; keys: string[]; rows: Record<string, unknown>[] }
  | { kind: "markdown"; text: string }
  | { kind: "json"; text: string }
  | { kind: "text"; text: string };

function decideResultRender(
  raw: string,
  parsed: unknown,
  error: boolean,
): ResultRender {
  // Some backends send JSON-escaped results (literal \n, no real newlines)
  // — decode before deciding how to render.
  const text = normalizeResultString(raw);
  if (error) return { kind: "error", text };
  if (parsed != null && typeof parsed === "object") {
    if (isArrayOfObjects(parsed)) {
      const rows = parsed as Record<string, unknown>[];
      const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      if (keys.length > 0) return { kind: "table", keys, rows };
    }
    const json = prettyJson(parsed);
    if (json) return { kind: "json", text: json };
    return { kind: "code", text };
  }
  if (looksLikeMarkdown(text)) return { kind: "markdown", text };
  return { kind: "text", text };
}

function ResultBody({
  rawResult,
  parsedResult,
  error,
}: {
  rawResult: string;
  parsedResult: unknown;
  error: boolean;
}) {  const [showAll, setShowAll] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const render = useMemo(
    () => decideResultRender(rawResult, parsedResult, error),
    [rawResult, parsedResult, error],
  );

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || showAll) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 4);
  }, [showAll, render]);

  return (
    <>
      <div
        ref={contentRef}
        className={
          showAll ? undefined : "relative max-h-96 overflow-hidden"
        }
      >
        {renderResultContent(render)}
        {!showAll && overflowing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-zinc-50 to-transparent dark:from-zinc-800/40" />
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="mt-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {showAll ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

// Props are referentially stable (memoized in ToolCallRow), so expand/copy
// clicks skip re-rendering the markdown/table subtree entirely.
const MemoizedResultBody = memo(ResultBody);

function renderResultContent(render: ResultRender) {
  switch (render.kind) {
    case "error":
      return (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-red-50 p-2 font-mono text-xs text-red-600 dark:bg-red-950/50 dark:text-red-400">
          {render.text}
        </pre>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-xs text-zinc-600 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700/60">
          {render.text}
        </pre>
      );
    case "table":
      return <ResultTable keys={render.keys} rows={render.rows} />;
    case "markdown":
      return (
        <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 [&_a]:text-blue-600 [&_a]:underline dark:[&_a]:text-blue-400 [&_code]:rounded [&_code]:bg-zinc-200/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8em] dark:[&_code]:bg-zinc-700/60 [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-1.5 [&_h3]:text-sm [&_h3]:font-medium [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-white [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:ring-1 [&_pre]:ring-zinc-200/60 dark:[&_pre]:bg-zinc-900 dark:[&_pre]:ring-zinc-700/60 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-xs [&_td]:border-b [&_td]:border-zinc-100 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top dark:[&_td]:border-zinc-800 [&_th]:border-b [&_th]:border-zinc-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold dark:[&_th]:border-zinc-700 [&_ul]:list-disc [&_ul]:pl-5">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {render.text}
          </ReactMarkdown>
        </div>
      );
    case "json":
      return (
        <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-xs text-zinc-600 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700/60">
          {render.text}
        </pre>
      );
    case "text":
      return (
        <div className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-600 dark:text-zinc-300">
          {render.text}
        </div>
      );
  }
}

function ResultTable({
  keys,
  rows,
}: {
  keys: string[];
  rows: Record<string, unknown>[];
}) {
  return (
    <div className="overflow-x-auto rounded bg-white ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-700/60">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-700">
            {keys.map((key) => (
              <th
                key={key}
                className="px-2.5 py-1.5 font-semibold text-zinc-500 dark:text-zinc-400"
              >
                {key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
            >
              {keys.map((key) => (
                <td
                  key={key}
                  className="max-w-64 px-2.5 py-1.5 align-top text-zinc-600 dark:text-zinc-300"
                >
                  {formatCell(row[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") {
    return truncateRaw(value, TABLE_CELL_MAX_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncateRaw(prettyJson(value) ?? String(value), TABLE_CELL_MAX_CHARS);
}

function StatusIcon({ running, error }: { running: boolean; error: boolean }) {
  if (running) {
    return (
      <svg
        className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r="6.5"
          stroke="currentColor"
          strokeWidth="2"
          className="opacity-20"
        />
        <path
          d="M8 1.5A6.5 6.5 0 0 1 14.5 8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (error) {
    return (
      <svg
        className="h-3.5 w-3.5 shrink-0 text-red-500"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z"
          clipRule="evenodd"
        />
      </svg>
    );
  }
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 text-green-500"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 0 1-1.06 0L2.22 10.78a.75.75 0 1 1 1.06-1.06L6 12.19l6.72-6.72a.75.75 0 0 1 1.06 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-hover:text-zinc-600 dark:group-hover:text-zinc-300 ${
        open ? "rotate-180" : ""
      }`}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M5.75 1a.75.75 0 0 0-.75.75V3H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h.25a.75.75 0 0 0 .75-.75v-7.5A.75.75 0 0 0 12.25 3H11V1.75a.75.75 0 0 0-.75-.75h-4.5ZM10 3H7V1.5h3V3ZM4 4.5h6a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Z" />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5 text-green-500"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 0 1-1.06 0L2.22 10.78a.75.75 0 1 1 1.06-1.06L6 12.19l6.72-6.72a.75.75 0 0 1 1.06 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

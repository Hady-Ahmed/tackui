"use client";

import { useEffect, useRef, useState } from "react";

export type TestStatus = "idle" | "loading" | "ok" | "fail";
export type TestResult = { status: TestStatus; message?: string };

export const TEST_HELP =
  "Tests only that the server is reachable (an HTTP request succeeds). " +
  "A success does NOT validate auth, AG-UI protocol compliance, or that the agent will actually run. " +
  "A failure usually means the URL is wrong or the server is down.";

export async function testEndpoint(endpoint: string): Promise<TestResult> {
  try {
    const res = await fetch("/api/agents/reachability-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        status: "fail",
        message:
          (typeof data === "object" && data && "error" in data
            ? String((data as { error: unknown }).error)
            : `Request failed (${res.status})`) ||
          "Validation failed — check the URL.",
      };
    }
    return {
      status: data.ok ? "ok" : "fail",
      message: data.message as string,
    };
  } catch {
    return { status: "fail", message: "Network error talking to /api/agents/reachability-probe" };
  }
}

/**
 * Transient reachability-probe feedback for the admin surfaces (/agents
 * and /admin): form badge + per-row badges that auto-dismiss after
 * TEST_RESULT_CLEAR_MS so a failed probe doesn't sit on screen forever.
 * Persistent status belongs to the sidebar's dots, not these badges.
 */
const TEST_RESULT_CLEAR_MS = 5000;

export function useTestResults() {
  const [formTest, setFormTest] = useState<TestResult>({ status: "idle" });
  const [rowTests, setRowTests] = useState<Record<string, TestResult>>({});
  const formTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearFormTimer = () => {
    if (formTimer.current) {
      clearTimeout(formTimer.current);
      formTimer.current = null;
    }
  };

  const clearRowTimer = (id: string) => {
    const timer = rowTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      rowTimers.current.delete(id);
    }
  };

  const resetFormTest = () => {
    clearFormTimer();
    setFormTest({ status: "idle" });
  };

  const runFormTest = async (endpoint: string) => {
    if (!endpoint) return;
    clearFormTimer();
    setFormTest({ status: "loading" });
    const result = await testEndpoint(endpoint);
    setFormTest(result);
    formTimer.current = setTimeout(() => {
      formTimer.current = null;
      setFormTest({ status: "idle" });
    }, TEST_RESULT_CLEAR_MS);
  };

  const runRowTest = async (id: string, endpoint: string) => {
    if (!endpoint) return;
    clearRowTimer(id);
    setRowTests((prev) => ({ ...prev, [id]: { status: "loading" } }));
    const result = await testEndpoint(endpoint);
    setRowTests((prev) => ({ ...prev, [id]: result }));
    rowTimers.current.set(
      id,
      setTimeout(() => {
        rowTimers.current.delete(id);
        setRowTests((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)),
        );
      }, TEST_RESULT_CLEAR_MS),
    );
  };

  useEffect(
    () => () => {
      if (formTimer.current) clearTimeout(formTimer.current);
      rowTimers.current.forEach((timer) => clearTimeout(timer));
      rowTimers.current.clear();
    },
    [],
  );

  return { formTest, rowTests, runFormTest, runRowTest, resetFormTest };
}

export function TestBadge({
  result,
  inline = false,
}: {
  result: TestResult;
  inline?: boolean;
}) {
  if (result.status === "idle") return null;
  if (result.status === "loading") {
    return (
      <span className={`${inline ? "ml-2" : ""} text-xs text-zinc-400`}>...</span>
    );
  }
  const ok = result.status === "ok";
  return (
    <span
      className={`${inline ? "ml-2" : ""} text-xs font-medium ${
        ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
      }`}
      title={result.message}
    >
      {ok ? "✓" : "✗"} {result.message}
    </span>
  );
}
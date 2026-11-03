/**
 * Fail fast when a boot step that leaves the app non-functional exhausted
 * its retries: without app tables (migrations) or auth tables, every
 * request 500s — and a merely-logged error would let orchestrators keep a
 * permanently-broken container "healthy". Exiting non-zero makes the
 * container unhealthy (Docker/k8s restart it; compose dependency gates
 * never go green), which is the truthful signal. Real PG connectivity is
 * verified by the retries themselves — this fires only when PG accepted
 * connections but the step still failed, OR PG never came up in ~30s.
 *
 * Lives in its own module so `instrumentation.ts` carries no static
 * reference to `process.exit`: instrumentation is bundled for the Edge
 * runtime too, and the Edge compiler rejects Node-only APIs it can *see*,
 * even behind a NEXT_RUNTIME guard that prevents them from ever *running*
 * there. The Edge bundler skips this module entirely (it is only reached
 * via dynamic import from the Node.js branch of register()).
 */
export function failFast(step: string, err?: unknown): never {
  const detail = err instanceof Error ? err.message : err ? String(err) : "retries exhausted";
  console.error(
    `[boot] FATAL: ${step} failed (${detail}) — the app cannot serve requests without it. Exiting non-zero so the orchestrator restarts/reports unhealthy.`,
  );
  process.exit(1);
}

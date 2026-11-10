-- agent_runs.run_id carried a GLOBAL unique constraint — 0001's inline
-- `run_id TEXT NOT NULL UNIQUE` (the Postgres-default constraint name
-- agent_runs_run_id_key). AG-UI clients may legitimately supply their own
-- run ids, and a client that reused a run_id on a second run — on another
-- thread, or after the first run's row was deleted — hit 23505 on the
-- INSERT: the run was silently dropped from history (storeRun's failure
-- path logs and completes the stream without a persisted row).
--
-- Scope the uniqueness to what the runner actually keys history by: the
-- (thread_id, run_id) pair. The same run_id within ONE thread remains a
-- hard duplicate (rejected — the duplicate-detection semantics are
-- unchanged); the same run_id on a DIFFERENT thread is a legitimate client
-- choice and now persists. storeRun's INSERT is unchanged — only the
-- constraint moves. Strictly weaker than the old constraint, so existing
-- data cannot violate the new index.
--
-- Both statements are idempotent (safe on re-run and on schemas whose
-- constraint was already dropped).

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_thread_run_uniq
  ON agent_runs (thread_id, run_id);

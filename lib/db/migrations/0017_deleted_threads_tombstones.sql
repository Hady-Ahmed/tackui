-- Tombstones for deleted threads. deleteThread removes agent_runs /
-- run_state / thread_messages / thread_metadata in one transaction, but a
-- run on the same thread id could still resurrect it afterwards:
--
--   - a run that acquired its lock and registered its connection only
--     AFTER the delete transaction read ACTIVE_CONNECTIONS never receives
--     the in-memory threadDeleted marker, so its persistence window
--     (storeRun + captureThreadData) wrote fresh rows unimpeded; and
--   - a run that STARTED after the delete committed passed startRun's
--     ownership gate as a "creatable" brand-new thread (a deleted thread
--     and a never-existing thread are indistinguishable in the remaining
--     tables) and re-created thread_metadata + agent_runs from scratch —
--     a zombie thread holding only that run's data.
--
-- The tombstone row, written in the SAME transaction as the deletes, is
-- the DB-level fact every path can check against the committed state:
-- startRun refuses a tombstoned thread id ("Thread not found") right after
-- the lock claim, storeRun's INSERT is conditional on the tombstone's
-- absence, and captureThreadData skips entirely. The in-memory marker
-- stays as the first line of defense for runs registered before the
-- delete; the tombstone covers the registration window the marker cannot
-- see. Thread ids are client-generated UUIDs, so no legitimate flow
-- re-creates a deleted id; retention (pruned opportunistically inside
-- deleteThread's transaction — no background timer) exists to bound the
-- table, not to re-enable ids.

CREATE TABLE IF NOT EXISTS deleted_threads (
  thread_id   TEXT        PRIMARY KEY,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 0002_org_id_not_null.sql — make org_id NOT NULL (wipe-and-restart policy).
--
-- For existing deploys that already ran 0001_init.sql with nullable org_id:
-- deletes all rows with NULL org_id, then sets the column to NOT NULL.
--
-- For new deploys: 0001_init.sql already creates the column as NOT NULL,
-- so this migration is a no-op (SET NOT NULL is idempotent on an already-
-- NOT-NULL column, and there are no NULL rows to delete).
--
-- Wipe-and-restart: existing NULL rows are DELETED, not backfilled. Re-add
-- agents via the admin UI after the first user signs up and gets a personal
-- org. See AGENTS.md for the full multi-tenant migration plan.

DELETE FROM agents WHERE org_id IS NULL;

-- Clean up orphaned rows in dependent tables (thread_metadata with NULL
-- org_id, plus agent_runs/run_state/thread_messages keyed by those threads).
DELETE FROM thread_metadata WHERE org_id IS NULL;
DELETE FROM agent_runs WHERE thread_id NOT IN (SELECT thread_id FROM thread_metadata);
DELETE FROM run_state WHERE thread_id NOT IN (SELECT thread_id FROM thread_metadata);
DELETE FROM thread_messages WHERE thread_id NOT IN (SELECT thread_id FROM thread_metadata);

-- Set NOT NULL (idempotent — no-op if already NOT NULL).
ALTER TABLE agents ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE thread_metadata ALTER COLUMN org_id SET NOT NULL;

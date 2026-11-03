-- Concurrent installs of the same catalog template raced find-then-insert:
-- both requests observed "not installed", both INSERTed an agents row
-- stamped with the same source_template_id, and the org got two rows for
-- one install (duplicate sidebar entries; findInstalledAgentId's
-- oldest-wins tiebreak made later re-syncs update only one of them).
--
-- The DB-level guarantee: at most one installed copy per (org, template).
-- Partial (source_template_id IS NOT NULL) because manually-created
-- agents carry NULL there — NULLs are distinct in Postgres unique
-- indexes, so manual agents are unaffected.
--
-- installTemplate catches the 23505 violation and falls back to the
-- re-sync path (the winner's row gets refreshed instead of duplicated).

CREATE UNIQUE INDEX IF NOT EXISTS agents_org_template_uniq
  ON agents (org_id, source_template_id)
  WHERE source_template_id IS NOT NULL;

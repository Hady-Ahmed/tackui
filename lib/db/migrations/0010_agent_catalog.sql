-- 0010_agent_catalog.sql — curated agent catalog ("agent templates").
--
-- Adds the `agent_templates` table: global, platform-admin-curated agent
-- entries that any org can one-click install into its own `agents` table.
-- Templates are creation templates, NOT live references — installing copies
-- the config into an org-scoped agent row (org scoping, plan agent-count
-- caps, encryption-at-rest, JWT minting, and the runtime all keep working
-- unchanged; `getAgents()` reads the `agents` table, so installed catalog
-- agents are ordinary agents).
--
-- Monetization fields (enforced SaaS-only by lib/plans/enforcement.ts):
--   required_plan     — when set ('pro'|'team'), only orgs on that plan or
--                       higher can install/run the agent. NULL = all plans.
--   free_daily_quota  — when set (int), free-plan users get a rolling-24h
--                       per-user run cap on the installed agent (paid plans
--                       unlimited). NULL = unlimited.
--
-- agents table gains two provenance columns:
--   source_template_id            — the template the agent was installed
--                                   from (nullable, no FK: deleting a
--                                   template leaves installed copies
--                                   working — they are the org's property).
--   installed_template_updated_at — snapshot of the template's updated_at
--                                   at install/last-sync time, used to
--                                   detect "Update available" (the install
--                                   endpoint is an idempotent upsert).

CREATE TABLE IF NOT EXISTS agent_templates (
  id                TEXT        PRIMARY KEY,
  slug              TEXT        NOT NULL UNIQUE,
  name              TEXT        NOT NULL,
  tagline           TEXT        NOT NULL DEFAULT '',
  description       TEXT        NOT NULL DEFAULT '',
  category          TEXT,
  icon              TEXT,
  endpoint          TEXT        NOT NULL,
  auth_mode         TEXT        NOT NULL DEFAULT 'none',
  jwt_secret        TEXT,
  jwt_scopes        TEXT,
  required_plan     TEXT,
  free_daily_quota  INTEGER,
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_templates_sort ON agent_templates (sort_order);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS source_template_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS installed_template_updated_at TIMESTAMPTZ;

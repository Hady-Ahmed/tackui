-- 0001_init.sql — initial schema for agent-front-end (Postgres)
-- Tables:
--   agents              — agent registry (CRUD via /agents admin UI + /api/agents REST)
--   thread_messages     — snapshot of latest messages per thread (useThreads)
--   thread_metadata     — per-thread title/owner/agent_id (useThreads + thread API)
--   agent_runs          — raw event log per run (AgentRunner persistence)
--   run_state           — is_running/current_run_id per thread (AgentRunner)
--   schema_migrations   — tracks applied .sql files (managed by lib/db/migrate.ts)
--
-- Note: Better Auth tables (user, session, account, verification) are created
-- separately by `npx @better-auth/cli migrate --config lib/auth/auth.ts`.
-- The schema_migrations tracking table is created by lib/db/migrate.ts itself.

CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT        PRIMARY KEY,
  name                TEXT        NOT NULL,
  description         TEXT        NOT NULL DEFAULT '',
  kind                TEXT        NOT NULL,
  endpoint            TEXT        NOT NULL,
  graph_id            TEXT,
  langsmith_api_key   TEXT,
  org_id              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agents_org_id ON agents (org_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id              BIGSERIAL    PRIMARY KEY,
  thread_id       TEXT         NOT NULL,
  run_id          TEXT         NOT NULL UNIQUE,
  parent_run_id   TEXT,
  events          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  input           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  version         INTEGER      NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_id     ON agent_runs (thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_run_id ON agent_runs (parent_run_id);

CREATE TABLE IF NOT EXISTS run_state (
  thread_id       TEXT         PRIMARY KEY,
  is_running      BOOLEAN      NOT NULL DEFAULT FALSE,
  current_run_id  TEXT,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS thread_messages (
  thread_id   TEXT         PRIMARY KEY,
  messages    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS thread_metadata (
  thread_id   TEXT         PRIMARY KEY,
  agent_id    TEXT         NOT NULL,
  title       TEXT,
  user_id     TEXT,
  org_id      TEXT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_thread_metadata_user_id ON thread_metadata (user_id);
CREATE INDEX IF NOT EXISTS idx_thread_metadata_org_id ON thread_metadata (org_id);

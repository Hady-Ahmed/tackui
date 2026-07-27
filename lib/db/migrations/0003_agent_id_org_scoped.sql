-- 0003_agent_id_org_scoped.sql — make agent ids unique per-org, not globally.
--
-- Previously `agents.id` was the sole PRIMARY KEY, which made agent ids
-- globally unique across all orgs. That contradicts the app-level scoping
-- (every query filters by org_id) and caused a real bug: an agent created
-- under one org (e.g. an auth-on personal org) blocked creating an agent
-- with the same id under a different org (e.g. the solo-mode org after
-- flipping AUTH_DISABLED=true). The 409 "already exists" fired even though
-- the requesting org had no such agent.
--
-- Fix: composite PRIMARY KEY (id, org_id). Same id can now exist in
-- different orgs — matching what every caller already assumes. Agent ids
-- are now server-generated (12-char random hex, see lib/agents/agent-store.ts
-- generateAgentId), so intra-org collisions are effectively impossible.
--
-- Safe for all current deploys:
--   - Single-org deploys cannot have intra-org id collisions, so the new
--     constraint introduces no new uniqueness violations.
--   - The auth-on → auth-off phantom-collision scenario (the bug this fixes)
--     is resolved — the two rows live in different orgs.
--   - No data is deleted or rewritten; only the PK constraint changes.
--
-- `idx_agents_org_id` (created by 0001_init.sql) remains in place for the
-- `WHERE org_id = $1` query path used by listAgents / getAgent / etc.

ALTER TABLE agents DROP CONSTRAINT agents_pkey;
ALTER TABLE agents ADD PRIMARY KEY (id, org_id);

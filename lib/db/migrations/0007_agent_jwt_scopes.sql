-- 0007_agent_jwt_scopes.sql — optional JWT scopes claim.
--
-- Adds an optional `jwt_scopes` column to the agents table so the
-- runtime can include a `scopes` claim in the JWT payload when the
-- agent's backend has `authorization=True` enabled (e.g. Agno's
-- AuthMiddleware checks the `scopes` claim for RBAC gatekeeping).
--
-- Stored as a comma-separated TEXT string (e.g. "agents:run,app:superadmin")
-- — scope names never contain commas, so this is safe and human-readable.
-- Parsed to a `string[]` on read by `rowToEntry` in agent-store.ts.
--
-- Nullable: when NULL, the runtime omits the `scopes` claim from the JWT
-- entirely (the default — works fine when the backend's authorization
-- is off). Set it only when the backend requires specific scopes.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS jwt_scopes TEXT;

-- 0005_agent_auth.sql — per-agent JWT authentication.
--
-- Adds optional per-agent HS256 JWT auth so the CopilotKit runtime can
-- mint a short-lived bearer token per run, signed with a secret shared
-- between tackui and the agent's backend. The backend verifies the
-- signature (proving tackui minted it) and uses the `sub` claim (the
-- authenticated Better Auth user id) to identify the caller. tackui
-- only vouches for *who* the user is — authorization (what they can do)
-- stays the backend's job.
--
-- `auth_mode` defaults to 'none' so existing agents keep working with
-- no change (anonymous endpoint + forwardedProps.user_id fallback).
-- Set `auth_mode = 'jwt'` + a ≥32-char `jwt_secret` (matching the
-- backend's verification key) to opt in.
--
-- `jwt_secret` is stored in plaintext, matching the langsmith_api_key
-- pattern. Write-only in API responses (PublicAgent.hasJwtSecret boolean
-- replaces the raw value). Future hardening: encrypt both secrets at
-- rest with a DB_ENCRYPTION_KEY (separate task).

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS auth_mode  TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS jwt_secret TEXT;

-- 0013_agent_builder.sql — builder-created agents + per-user credentials.
--
-- Foundation for "create-your-own agents": users build agents through the
-- builder; the definitions live on the shared multi-tenant AgentOS
-- (platform-os) as versioned component configs, and tackui keeps a normal
-- agent row that resolves to the AgentOS at run time.
--
-- agents additions:
--   origin            'manual' | 'template' | 'builder' — provenance.
--                     'builder' marks agents created through the builder;
--                     their runtime config (endpoint resolution, JWT secret,
--                     scope) comes from platform env, not per-agent values.
--   author_user_id    the member who created it (attribution survives
--                     membership changes). Null for manual/template rows.
--   remote_agent_id   the AgentOS-side component id. tackui ids stay
--                     server-generated; the AgentOS returns its own id on
--                     create. Run/edit requests to the AgentOS use this id.
--   requirements      JSON snapshot of what a RUNNER needs to run the agent:
--                     { model: {provider, id, platformTier},
--                       tools: [{name, requiresKey?, provider?,
--                                platformFallback?}],
--                       connectors: [names] }. Written at create/update
--                     from the definition tackui itself built (source of
--                     truth is the AgentOS config; this snapshot only
--                     powers the pre-run gate so run requests need no
--                     AgentOS round-trip).
--
-- credentials: per-user BYOK keys for LLM + tool providers. Keys are
-- write-only — GET responses return existence booleans only (same pattern
-- as agents.jwtSecret). Encrypted at rest (AES-256-GCM via lib/crypto).
-- Delivered per-run via AG-UI context (never stored AgentOS-side).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS author_user_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS remote_agent_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS requirements JSONB;

CREATE INDEX IF NOT EXISTS agents_remote_id_idx ON agents (remote_agent_id) WHERE remote_agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  -- No FK: "user" is a Better Auth runtime table (same convention as
  -- agents.org_id); user deletion cleanup is handled app-side.
  user_id TEXT NOT NULL,
  -- 'openai' | 'openrouter' | 'tavily' (validated app-side by zod).
  provider TEXT NOT NULL,
  -- 'llm' | 'tool' — which role the provider plays (drives the run gate).
  kind TEXT NOT NULL,
  -- AES-256-GCM ciphertext (enc:v1:... via lib/crypto/encrypt.ts).
  secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- connectors: org-level MCP servers (admin-managed). Name/URL/token are
-- resolved per run and delivered via AG-UI context; nothing is stored on
-- the AgentOS. UI + routes land with the MCP palette step.
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  -- AES-256-GCM ciphertext (enc:v1:...), empty string = no auth.
  token TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

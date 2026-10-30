-- 0014_credential_fields.sql — multi-field credentials per provider.
--
-- The platform catalog now derives full credential CONTRACTS per tool —
-- multi-credential toolkits exist (the X toolkit needs a consumer key +
-- consumer secret + access token + access token secret), so a provider's
-- saved credential is no longer one secret but a named field map. Field
-- names are the toolkit constructor arguments the AgentOS per-run delivery
-- fills; the wire dep key is <provider>_<field> — one convention end to
-- end (catalog → key UI → run-gate 402 → per-run delivery → constructor).
--
-- Single-key providers keep working unchanged: their one field is
-- "api_key" (the universal constructor argument for LLM providers and
-- single-key toolkits), backfilled here from the old secret column.

ALTER TABLE credentials ADD COLUMN IF NOT EXISTS fields JSONB NOT NULL DEFAULT '{}';

UPDATE credentials SET fields = jsonb_build_object('api_key', secret) WHERE fields = '{}';

ALTER TABLE credentials DROP COLUMN secret;

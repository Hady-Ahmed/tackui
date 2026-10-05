-- 0009_drop_agent_kind.sql — remove the agent `kind` field entirely.
--
-- With the `langgraph` kind gone (migration 0008), `kind` had exactly one
-- legal value ('agui'): a constant column, a single-value zod enum, and a
-- one-case switch in the registry. Speculative extension points don't pay
-- (see 0008) — when a second kind is actually demanded, re-adding the
-- column belongs in the same migration as that kind's config fields.
--
-- 0008 already deleted the non-'agui' rows, so nothing is preserved: the
-- column is uniformly 'agui'. POST/PATCH bodies that still send `kind`
-- are accepted and the field is discarded (zod strips unknown keys).

ALTER TABLE agents DROP COLUMN IF EXISTS kind;

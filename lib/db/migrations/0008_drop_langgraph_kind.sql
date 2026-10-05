-- 0008_drop_langgraph_kind.sql — remove the untested `langgraph` agent kind.
--
-- The `langgraph` kind (LangGraphAgent + LangGraph Platform API) shipped
-- without ever being smoke-tested against a real deployment. Rather than
-- present an option in the admin UI that may silently not work, it is
-- removed; LangGraph users are served by the `agui` kind via
-- `ag-ui-langgraph` instead. Restore from git history when there's real
-- demand (plus the missing smoke test).
--
-- The DELETE is load-bearing: `rowToEntry` casts `kind` without
-- validating on read, and with the registry's `langgraph` case removed a
-- stale row would throw `Unknown agent kind` inside `getAgents()` —
-- breaking ALL agents for the org, not just the langgraph one.
--
-- Also drops the kind's two columns (`graph_id`, `langsmith_api_key`).
-- Both existed solely for the `langgraph` kind; `langsmith_api_key` is
-- the write-only LangSmith tracing secret whose entire stripping surface
-- (PublicAgent.hasLangsmithApiKey) existed for this kind. Re-adding the
-- kind later re-adds the columns in a new migration.

DELETE FROM agents WHERE kind = 'langgraph';

ALTER TABLE agents DROP COLUMN IF EXISTS graph_id;
ALTER TABLE agents DROP COLUMN IF EXISTS langsmith_api_key;

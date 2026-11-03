# platform-os

The multi-tenant AgentOS that remotely-created agents run on. Runs beside the
frontend (same host or docker network); the frontend proxies two
service-token endpoints from it to render the agent builder:

- `GET /platform/models` — the model picker catalog
- `GET /platform/tools` — the tool palette + BYOK provider list

plus an admin-scope catalog API (`/platform/available`,
`GET|PUT /platform/catalog/{models,tools}`, `POST /platform/test/model`)
that the frontend's admin page (`/admin/platform`) proxies.

## Configure the catalog

**The catalog is data, not code.** The platform admin ticks checkboxes
(providers, toolkits) and types model ids in the frontend's admin page; the
change goes live on the next request — no code, no env edits, no redeploy.
Everything else (credential contracts, function lists, env keys) is
derived automatically.

There is **no seed**: the catalog tables start EMPTY on a fresh deployment.
A freshly deployed service offers nothing until the admin enables entries —
an operator who configures nothing gets a builder that offers nothing,
rather than one that silently spends keys or reaches the internet. After
deploying, tick the boxes once; the rows persist in the service's Postgres
(`DATABASE_URL` — the catalog's `public`-schema tables beside agno's `ai`
schema; agno creates its schema and tables on demand, the catalog's DDL
runs at boot).

### Where offerings come from (discovery)

At boot the service scans everything agno ships on THIS deployment
(`agno.models.*`, `agno.tools.*`). The scan is fail-closed:

- A module that cannot import (its pip package isn't installed) does not
  exist here: not in the menu, one boot-log line. `uv add` the package and
  restart to offer it.
- A class that cannot be constructed does not appear either.
- A module that exports several model classes offers EACH one — no
  canonical pick. agno's `openai` module ships the chat-completions and
  Responses API doors (plus the generic `OpenAILike`/`OpenResponses`
  adapters a self-hoster can point at their own server); each becomes its
  own provider with its own slug, derived from where agno defines the
  class — the module's own file keeps the bare module slug
  (`openrouter`, `xai`, `deepseek` — the class in
  `deepseek/deepseek.py`), any other file gets
  `<module>-<file>` (`openai-chat`, `openai-responses`,
  `azure-openai-responses`). Nothing is hand-picked and nothing can flip:
  no "primary class" heuristic exists. One vendor's doors share the
  vendor's single credential — dep keys derive from the agno module,
  not the slug — and the registry binds component configs by
  `(id, class name)`, so the same model id under two doors resolves
  exactly.
- Toolkits are constructed once with throwaway dummy credentials purely to
  read their identity, function list, and json-schema parameters; the
  dummies never reach the network.

So the admin menu shows exactly what this deployment can actually serve —
nothing dead is ever offered.

### Model entries

One per line in the provider's textarea:

```
provider:model-id[:tier][:key=value ...]
```

Inside a provider's own block the prefix may be omitted
(`gpt-4o-mini:tier`, `z-ai/glm-5.3-flash:max_tokens=8192`). The provider
prefix is split off once; the remaining tokens are read right-to-left —
trailing `tier` flags and `key=value` pairs are popped from the end and
whatever is left joined by ":" is the model id, so ids may contain colons
themselves (`openrouter:meta-llama/llama-3.1-8b-instruct:free`,
`openai-chat:llama3:8b`) and round-trip exactly what the frontend's admin page sends.
Ids never carry `=`: an attribute token must come after the id — an entry
like `openrouter:…:max_tokens=100:free` (attribute typed before the
`:free` suffix) is rejected rather than glued into a bogus id that would
mutate on the next save. A `tier` token typed mid-id
(`openai-chat:model:tier:free`) is rejected the same way: the flag belongs after
the id, and the old parse silently glued `tier` into the id while dropping
the flag. Empty segments are rejected too — a doubled colon
(`openai-chat::gpt-4o`) is a 400, not a silently repaired entry (the client's
`modelEntryText` rebuilds entries from parsed rows, so it can never emit
either shape; the guards catch hand-typed and hand-edited input).
Attributes are validated against the provider class's own dataclass fields
at save time — an unknown or mistyped attribute is rejected, never served.
Credential-shaped attributes (`api_key`, tokens, secrets) are rejected
outright: entries carry no secrets — model keys come from the platform's
own env vars or the run's BYOK delivery. The same rejection is re-applied
at rebuild time to rows written by other means (direct DB edits), so a
hand-inserted secret row is skipped, never served. The `:tier`
flag marks platform-key-eligible models (dormant for builder runs, which
are 100% BYOK; it wakes with Phase 3 publishing).

The same model id may exist under **different providers** — that is the
doors feature (one vendor's chat-completions and Responses API doors both
serve `gpt-5.6-luna`). What must stay unique is the registry **binding
pair** `(id, effective name)`: the registry resolves a config by
`get_model(id, name)`, so two rows sharing both would be
indistinguishable and one would silently win. The save rejects a binding
collision naming both providers (one vendor's doors bind under distinct
class names, so they never collide; a hand-set `name=` attribute or two
same-named classes across modules would). The same id twice under ONE
provider is rejected too — the composite PK would reject it anyway, but
the 400 names the duplicate.

Key-independence still holds: an enabled model is listed and servable
whether or not its platform key is set — the platform key only decides
`platform_tier` ("the platform key pays for this"), which requires the
tier flag AND the provider's env key actually set.

### Tool credential contracts

Derived from each toolkit's own source: `<slug>_<constructor-arg>` —
`tavily_api_key`, `x_consumer_key`. Runners' keys arrive per run under
those dep keys; the platform env key (the same one the toolkit itself
would read, e.g. `TAVILY_API_KEY`) is the fallback. Keyless toolkits
(calculator, duckduckgo) work for everyone.

Keyed toolkits are NEVER shared registry instances — they are constructed
fresh per run with the run's resolved credentials passed to the stock
constructor. A missing credential skips that toolkit's functions for the
run (the client's pre-run gate is the real guard). A toolkit that reads a
credential-shaped env var with no constructor argument has no delivery
path: it shows in the admin list but cannot be enabled.

### Disabling stops agents

Disabling a model or toolkit does not just hide it from the picker — the
registry loses it, so EXISTING agents referencing it stop running it (the
run fails closed). The same applies when a row becomes unconstructible
after an agno upgrade: warned and skipped at rebuild, never served dead.
Rows for offerings this deployment can no longer produce stay visible in
the admin page so they can be cleared.

### Model test button

`POST /platform/test/model` sends one `"hi"` completion straight to the
provider through the platform's own env key — the model object only, no
agent, no tools. It answers one question: does this id exist and does the
platform key work? Green before enabling; runners still bring their own
keys for BYOK runs. The probe is capped wherever the model class accepts
it (30s timeout, a small `max_tokens` budget) so one bad id cannot hold
the request — the frontend's proxy already times out at 10s, and the OpenAI
SDK's own default is ~10 minutes. An explicitly typed attribute keeps its
value.

### Storage

Both stores live in the one Postgres `DATABASE_URL`: agno's `ai` schema
(components + sessions; schema and tables are created by agno on demand)
and the catalog's `public`-schema tables (DDL runs at boot, idempotent).
Model `attrs` are a native JSONB column — malformed JSON is rejected by the
database at write time, so an unparseable-attrs row cannot exist (the old
sqlite TEXT column needed a skip-on-read guard for that; JSONB is the
stronger guarantee).

## Known limitations

**MCP connector attach URLs resolve from the platform registry, not the
wire.** (This section previously described the opposite design — URL +
Authorization taken from the client's wire payload, an SSRF primitive —
as current. That shipped closed: the connector registry below is the
mechanism.) The run request carries `{connector_id: {token}}` only; the
dispatcher resolves each id's attach URL from the `platform_connector`
registry table, refuses any id the component's stored config doesn't
declare (fail-closed: warn + skip), and never takes a URL or a header
value from the wire. Tokens are the only secret that transits the wire,
and they are never persisted platform-side.

**Model-entry attribute values cannot contain `:`.** Entries are single
lines tokenized on `:` — the same delimiter separates the provider prefix,
the id, the tier flag, and the `key=value` attributes — so a value that
itself contains a colon (a URL like `base_url=http://localhost:11434`, a
JSON object) cannot be typed inline. The parse splits it at the colon and
rejects the entry with a 400 naming the attribute and stating the rule —
nothing truncated is ever stored. Attributes that need such values can
only be set by editing the catalog row directly (the rebuild
construct-checks every row before serving it).

## Configuration

`DATABASE_URL` is required (Neon for prod, a local Postgres for dev — same
pattern as the two sibling chat agents): it backs BOTH the agno db (components +
sessions, `ai` schema) and the catalog (admin decisions + revision counter,
`public` schema). The remaining environment variables are listed in
`.env.example` (copy to `.env`; per-service on Railway). The server binds
`AGENT_OS_HOST` (default `0.0.0.0`) on port **7778** by default
(`AGENT_OS_PORT`, or Railway's injected `PORT`, override it) — note this
differs from the chat agents' 7777 default so platform-os and an agent can
run side by side.

## Dead mechanisms

`PLATFORM_MODELS`, `PLATFORM_TOOLS`, `PLATFORM_TIER_MODELS` are gone and
nothing reads them — if still set they are silently ignored (no boot
warning; the warn block was removed). Manage the catalog via the admin
page (or the `/platform/catalog` API directly).

## Layout

| File | Role |
| --- | --- |
| `discovery.py` | Boot scan of agno models + toolkits (cached for the process lifetime) |
| `catalog.py` | Postgres catalog store (psycopg, JSONB attrs): enabled rows + revision counter |
| `catalog_state.py` | Live registry built from rows; revision-checked rebuild; entry grammar |
| `admin_api.py` | Admin CRUD + model test endpoints |
| `models.py` | Generic per-run-key mixin + wrapper-class factory |
| `dispatcher.py` | Stored-component runs; per-run keyed-toolkit delivery |
| `credentials.py` | Per-run credential resolution (runner key wins, env falls back) |
| `main.py` | Wiring, scope policy, the builder-facing endpoints |

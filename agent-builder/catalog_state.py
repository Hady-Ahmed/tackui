"""Live catalog state — the registry built from the admin's decisions, rebuilt
when they change.

The registry (the model/toolkit objects runs are built from) is constructed
from the ENABLED catalog rows and kept in memory. Every request checks the
catalog's revision counter — one integer read — and rebuilds lazily when the
admin has changed anything since this process built it. Checkbox flips go
live without restart or redeploy.

Fail-closed everywhere: an enabled row whose class cannot be constructed is
skipped with a loud warning, never served dead. Disabling a row does not
just hide it from the picker — existing agents referencing it stop running
it (the operator withdrew the offering; documented in the README).

Grammar for the admin's model-id textarea (one entry per line):

    provider:model-id[:tier][:key=value ...]

e.g. ``openrouter:z-ai/glm-5.3-flash:max_tokens=8192`` or
``openai-chat:gpt-4o-mini:tier``. Model ids may themselves contain colons
(OpenRouter ``:free`` variants, ollama ``llama3:8b``) — the provider prefix
is split off once and trailing tier/attribute tokens are read from the
right. Attributes are validated against the provider
class's own dataclass fields — an unknown or mistyped attribute is rejected
at save time, never at run time. Nothing here is ever executed: values are
parsed, type-checked strings that only ever reach constructor kwargs.
"""
import dataclasses
import json
import math
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

from agno.registry import Registry
from agno.utils.log import log_warning

import discovery
from catalog import CatalogDB, CatalogSnapshot, ModelRow
from discovery import Discovery, ModelProvider, ToolEntry
from models import platform_model_class

# Generated wrapper classes, cached per provider class — rebuilds reuse them
# instead of accumulating fresh types on every admin save. The key is the
# provider CLASS (not the module): one module ships several API doors
# (openai-chat + openai-responses) sharing module/dep_key/env — keying by
# module would hand every door of the vendor the FIRST door's wrapper, and
# a responses run would silently go out as chat completions without the
# row's attrs.
_wrapper_cache: Dict[Tuple[type, str, Optional[str]], type] = {}


def _wrapper_for(entry: ModelProvider) -> Optional[type]:
    key = (entry.cls, entry.dep_key or "", entry.platform_env_key)
    cls = _wrapper_cache.get(key)
    if cls is None:
        cls = platform_model_class(entry.cls, entry.dep_key or "", entry.platform_env_key)
        _wrapper_cache[key] = cls
    return cls


def effective_model_name(entry: ModelProvider, attrs: Any) -> str:
    """The name agno's registry binds this row's instance under — the value
    a component config's ``model.name`` must match.

    A ``name`` attr (a real Model dataclass field) overrides the default;
    an instance with no ``name`` set binds under its class name (agno
    derives it in ``__post_init__``). The PUT's binding-uniqueness check
    and the request-path model_index MUST agree on this — they share this
    helper so they cannot drift.
    """
    candidate = attrs.get("name") if isinstance(attrs, dict) else None
    return candidate if isinstance(candidate, str) and candidate else entry.class_name


class CatalogState:
    """Per-app live catalog: discovery + durable rows + the built registry."""

    def __init__(self, discovery: Discovery, db: CatalogDB):
        self.discovery = discovery
        self.db = db
        self.revision: int = -1
        self.registry: Optional[Registry] = None
        # Serializes the staleness-check → rebuild → registry-swap sequence.
        # FastAPI runs sync endpoints in a threadpool, so two requests can be
        # inside ensure_current() concurrently; without the lock both could
        # see a stale revision, both rebuild (wasted work), and race the
        # in-place registry swap (a threading.Lock, not an asyncio one — the
        # code here is sync; the swap mutates plain lists).
        self._rebuild_lock = threading.Lock()
        # Enabled model ids -> (provider entry, tier flag); enabled function
        # names -> their toolkit entry (keyed toolkits included — they are
        # constructed per run, never registered).
        self.model_index: Dict[Tuple[str, str], Tuple[ModelProvider, bool, str]] = {}
        self.fn_index: Dict[str, ToolEntry] = {}
        # Registered MCP connector endpoints (id → (url, label)). Written by
        # the run client's server via the admin API; the dispatcher resolves
        # attach URLs from HERE, never from the run wire — a wire URL is not
        # an input the platform ever acts on.
        self.connector_index: Dict[str, Tuple[str, Optional[str]]] = {}

    # -- rebuild -------------------------------------------------------------

    def ensure_current(self, agent_os=None) -> None:
        """Rebuild when the admin has changed anything since the last build."""
        revision = self.db.get_revision()
        if self.registry is None or revision != self.revision:
            with self._rebuild_lock:
                # Double-checked locking: a concurrent requester may have
                # rebuilt while we waited for the lock — re-check before
                # rebuilding so exactly one stale-seeing requester rebuilds
                # and the others reuse its result. The common (current) path
                # never takes the lock.
                revision = self.db.get_revision()
                if self.registry is None or revision != self.revision:
                    self._rebuild(agent_os)

    def refresh(self, agent_os=None) -> None:
        """Force a rebuild from the current rows and update the live registry.

        Takes the same lock as ensure_current(): an admin save's forced
        rebuild must not interleave with a concurrent request's rebuild —
        the swap below mutates the LIVE registry's lists in place.

        The rebuilt registry is transplanted INTO the existing Registry
        object rather than swapped: agno's routers capture the registry
        reference at app build time, so replacing the attribute alone would
        leave them serving a stale registry. The transplant bulk-assigns
        the fresh lists and drops the entrypoint lookup cache directly
        (see ``_rebuild``).
        """
        with self._rebuild_lock:
            self._rebuild(agent_os)

    def _rebuild(self, agent_os=None) -> None:
        """The refresh body — callers hold ``_rebuild_lock`` (a plain Lock is
        NOT reentrant, so ensure_current's double-check calls this directly).

        The revision is captured BEFORE the rows (they arrive together, over
        one transaction — see ``CatalogDB.snapshot``) and THAT captured value
        is stamped at the end. Reading the revision again after the row reads
        would stamp a concurrent writer's NEW revision onto a registry built
        from OLD rows: ``ensure_current`` would then see "current" until the
        next write — a permanently stale registry for every non-self writer.
        """
        snapshot = self.db.snapshot()
        fresh, model_index = self._build_registry(snapshot)
        if self.registry is None:
            self.registry = fresh
        else:
            live = self.registry
            # READERS are not serialized here (only writers hold the lock):
            # build the complete fresh lists first, then bulk-assign, so the
            # window in which a concurrent request could observe a partially
            # swapped registry is just the two list assignments — one-request
            # transient at worst (its next request serves the swapped one).
            # The bulk assignment bypasses add_model/add_tool's per-item
            # dedupe (irrelevant — the fresh build is already deduped) and
            # add_tool's entrypoint-cache invalidation, which is redone
            # explicitly below.
            live.models[:] = fresh.models
            live.tools[:] = fresh.tools
            # Mirror add_tool's cache invalidation: rehydration must rebuild
            # its entrypoint lookup from the NEW tools, not reuse a cached
            # map built from the previous generation.
            live.__dict__.pop("_entrypoint_lookup", None)
        # The model index is built INSIDE _build_registry, from the same
        # accepted-rows loop — a row the registry skipped (construct
        # failure, dead provider) can never appear in the builder-facing
        # picker. The old separate _rebuild_indexes recomputed it from the
        # raw snapshot without the construct checks, so picker and registry
        # could diverge: a dead row stayed pickable, agents saved against
        # it, and the run fell into agno's from-dict rebuild (the platform
        # env-key path build_agent_for_run now refuses).
        self.model_index = model_index
        self._rebuild_tool_index(snapshot)
        # Connector registry rows ride the same revision-stamped snapshot:
        # a push-first write bumps the revision, the next run's
        # ensure_current swaps the index atomically with the registry.
        self.connector_index = {
            row.connector_id: (row.url, row.label)
            for row in snapshot.connectors.values()
        }
        self.revision = snapshot.revision
        if agent_os is not None:
            agent_os.registry = self.registry

    def _build_registry(
        self, snapshot: CatalogSnapshot
    ) -> Tuple[Registry, Dict[Tuple[str, str], Tuple[ModelProvider, bool, str]]]:
        """Construct a fresh Registry from one catalog snapshot.

        Fail-closed: rows whose class cannot be constructed (obsolete after
        an agno upgrade, corrupt attrs, provider gone from discovery) are
        skipped with a loud warning — never served dead.

        Returns ``(registry, model_index)``. The index is built from the
        SAME accepted-rows loop as the registry — one source of truth for
        "what this deployment serves": a row excluded here is invisible to
        the builder picker AND absent from the registry, so a saved agent
        referencing it fails at the run gate / dispatcher refusal instead
        of silently rebuilding on the platform env key.
        """
        models: List[Any] = []
        model_index: Dict[Tuple[str, str], Tuple[ModelProvider, bool, str]] = {}
        for row in snapshot.model_rows:
            if not snapshot.providers.get(row.provider_slug, False):
                continue
            entry = self.discovery.model_provider(row.provider_slug)
            if entry is None:
                log_warning(
                    f"catalog: model provider '{row.provider_slug}' is enabled but not "
                    f"available on this deployment — skipping model '{row.id}'"
                )
                continue
            try:
                _validate_attrs(entry.cls, row.attrs)
                instance = _wrapper_for(entry)(id=row.id, **row.attrs)
            except Exception as e:
                log_warning(
                    f"catalog: model '{row.provider_slug}:{row.id}' does not construct "
                    f"({type(e).__name__}: {str(e)[:120]}) — skipping"
                )
                continue
            models.append(instance)
            # Keyed by (provider_slug, id): one vendor's API doors may offer
            # the same model id (openai chat + openai-responses both serve
            # "gpt-5.6-luna"). The registry binds configs by (id, name) —
            # the effective instance name disambiguates the doors — so
            # cross-provider ids violate nothing. (id, effective name) is
            # globally unique BY CONSTRUCTION: the PUT rejects a binding
            # collision (admin_api uses the same effective_model_name
            # helper), because two same-named classes across modules or a
            # hand-set name= attr would otherwise reintroduce the
            # wrong-door ambiguity id-uniqueness used to prevent.
            model_index[(row.provider_slug, row.id)] = (
                entry,
                row.tier,
                effective_model_name(entry, row.attrs),
            )

        tools: List[Any] = []
        for slug, enabled in snapshot.tools.items():
            if not enabled:
                continue
            entry = self.discovery.tool(slug)
            if entry is None:
                log_warning(
                    f"catalog: tool '{slug}' is enabled but not available on this "
                    f"deployment — skipping"
                )
                continue
            if entry.keyed:
                # Keyed toolkits are constructed fresh PER RUN with the run's
                # credentials (a shared instance cannot serve many runners'
                # keys). They never enter the registry; the dispatcher
                # installs their functions per run (see dispatcher.py).
                continue
            try:
                instance = entry.cls()
            except Exception as e:
                log_warning(
                    f"catalog: tool '{slug}' does not construct "
                    f"({type(e).__name__}: {str(e)[:120]}) — skipping"
                )
                continue
            tools.append(instance)

        return (
            Registry(
                name="platform-os-registry",
                description="Shared toolkits + models for remotely-created agents.",
                models=models,
                tools=tools,
            ),
            model_index,
        )

    def _rebuild_tool_index(self, snapshot: CatalogSnapshot) -> None:
        """Recompute the tool function index from the same catalog snapshot
        the registry was built from. (The MODEL index is not rebuilt here —
        it is built inside _build_registry from the same accepted-rows loop,
        so the picker can never offer a row the registry refused.)"""
        fn_index: Dict[str, ToolEntry] = {}
        for slug, enabled in snapshot.tools.items():
            if not enabled:
                continue
            entry = self.discovery.tool(slug)
            if entry is None:
                continue
            # Keyed toolkits are indexed too — the dispatcher constructs them
            # per run; keyless ones are additionally registered above.
            for fn in entry.functions:
                existing = fn_index.get(fn["name"])
                if existing is not None and existing.module != slug:
                    # OVERLAP (not identity — _dedupe_tools already collapsed
                    # identical sets at discovery): two toolkits expose the
                    # same function NAME. The two resolution paths disagree
                    # on who wins: this index is last-writer-wins (dict
                    # assignment), while the registry's keyless rehydration
                    # resolves by name with first-instance-wins. A future
                    # agno toolkit overlapping an existing one would then
                    # resolve differently per path. Warn loudly so the
                    # overlap is a decision, not a silent shadow.
                    log_warning(
                        f"catalog: function '{fn['name']}' is exposed by both "
                        f"'{existing.module}' and '{slug}' — the index binds "
                        f"'{slug}' but registry rehydration may resolve "
                        f"'{existing.module}' (first-instance-wins)"
                    )
                fn_index[fn["name"]] = entry

        self.fn_index = fn_index


# -- model entry grammar -----------------------------------------------------


# Attribute keys that are credentials. Mirrors discovery._CRED_ENV_RE (the
# env-var family the scan treats as credentials: API_KEY / TOKEN / SECRET /
# PASSWORD), lowercased for attribute identifiers. Model keys come from the
# platform's own env vars or the run's per-run BYOK delivery — never from a
# catalog attribute, which would persist a plaintext secret into the shared
# catalog db and serve it to every runner.
_CRED_ATTR_RE = re.compile(r"(?:^|_)(?:api_?key|token|secret|password)(?:_|$)")


def parse_model_entry(
    raw: str, discovery: Discovery, default_provider: Optional[str] = None
) -> Tuple[str, str, Dict[str, Any], bool]:
    """Parse ``provider:id[:tier][:k=v ...]`` and validate against the class.

    Inside a provider's own block the prefix may be omitted (the admin types
    bare model ids into that provider's textarea) — pass the block's slug as
    ``default_provider``; an entry that names a DIFFERENT provider is
    rejected rather than silently re-homed.

    The provider prefix is split off ONCE (the first colon); the remaining
    tokens are parsed right-to-left — ``key=value`` pairs and the literal
    ``tier`` flag are popped from the end, and whatever is left joined by
    ":" is the model id. Model ids may therefore contain colons themselves
    (OpenRouter ``:free`` variants, ollama ``llama3:8b``): the client's admin
    page rebuilds entries as ``id[:tier][:k=v ...]``, so the round-trip must
    survive any id. Ids never carry ``=``: a ``k=v``-shaped token that is
    not trailing (an attribute typed before a further suffix, e.g.
    ``...:max_tokens=100:free``) is rejected rather than glued into the id,
    where it would persist as a bogus entry and mutate on the next
    round-trip. A mid-id ``tier`` token is rejected the same way
    (``...:model:tier:free`` would otherwise glue ``tier`` into the id and
    silently drop the flag), and empty segments — a doubled colon — are
    rejected rather than silently filtered (``openai::gpt-4o`` would
    otherwise parse as ``openai:gpt-4o``). The client's modelEntryText rebuilds
    entries from parsed rows (non-empty id + attrs), so it can never emit
    either shape; the guards catch hand-typed and hand-edited input.

    Attribute values cannot contain ``:`` (the entry delimiter): a value
    like ``base_url=http://host:11434`` is tokenized at every colon and the
    tail is misread as part of the id. When the fragment reconstructs into
    a type-valid value for a declared attribute, the error names the key
    and states the rule — nothing truncated is ever stored; otherwise the
    generic misplaced-attribute error applies.

    Raises ValueError with an admin-readable message on any problem. The
    returned attrs are coercion-checked against the provider class's
    dataclass fields; unknown or mistyped attributes are rejected here, at
    save time — never at run time. Credential-shaped attributes are rejected
    outright: entries carry no secrets.
    """
    split = [t.strip() for t in raw.split(":")]
    if any(not t for t in split):
        # Grammar guard: empty segments are rejected, not silently filtered.
        # `openai::gpt-4o` used to parse as `openai:gpt-4o` — the admin's
        # typo changed the meaning of nothing and disappeared. (A wholly
        # empty/whitespace line lands here too; the old filter produced an
        # empty token list and, in block context, indexed into it — a 500.)
        raise ValueError(
            f"'{raw}' has an empty segment — entries are "
            f"provider:id[:tier][:key=value ...]; check for doubled colons"
        )
    tokens = split

    if default_provider and tokens and tokens[0] in discovery.models and tokens[0] != default_provider:
        # A full entry naming a DIFFERENT provider pasted into this block.
        raise ValueError(
            f"entry '{raw}' names provider '{tokens[0]}' but was submitted under '{default_provider}'"
        )
    if default_provider and (len(tokens) == 1 or tokens[0] not in discovery.models):
        # Block context: the first token is not a provider slug (or there is
        # only one token), so this is a bare model id — colons in it belong
        # to the id, not to a provider prefix.
        provider = default_provider
        rest = tokens
    elif len(tokens) >= 2:
        # Full grammar — provider prefix, then the id (which may itself
        # contain colons) followed by trailing tier/attribute tokens.
        provider = tokens[0]
        rest = tokens[1:]
    else:
        raise ValueError(f"'{raw}' is not provider:model-id")
    entry = discovery.model_provider(provider)
    if entry is None:
        raise ValueError(f"provider '{provider}' is not available on this deployment")
    tier = False
    attrs: Dict[str, Any] = {}
    index = len(rest) - 1
    while index >= 0:
        token = rest[index]
        if token == "tier":
            tier = True
            index -= 1
            continue
        if "=" not in token:
            break  # not a trailing modifier — the id starts here
        key, _, value = token.partition("=")
        if not key or not value:
            raise ValueError(f"'{token}' is not key=value")
        if key == "id":
            raise ValueError("'id' is the model id itself — it cannot be an attribute")
        if _CRED_ATTR_RE.search(key):
            raise ValueError(
                f"attribute '{key}' is a credential — models are keyed by the "
                f"platform's own env vars, not per-entry secrets"
            )
        field = _find_field(entry.cls, key)
        if field is None:
            raise ValueError(
                f"'{key}' is not an attribute of {entry.class_name} — "
                f"accepted attributes: {', '.join(sorted(_attr_names(entry.cls))) or 'none'}"
            )
        attrs[key] = _coerce(key, value, field)
        index -= 1
    model_id = ":".join(rest[: index + 1])
    if not model_id:
        raise ValueError(f"'{raw}' is missing a model id")
    # Grammar guards: ids never carry '=' or a 'tier' token. A k=v-shaped
    # or 'tier' token that survived the right-to-left scan is not a trailing
    # modifier (e.g. an attribute typed BEFORE a ``:free`` suffix, or a tier
    # flag typed mid-id like ``model:tier:free``). Left unchecked either
    # would be glued into the id, construct-check fine, get persisted — and
    # then silently mutate on the client's next round-trip (its rebuild drops
    # the token, turning it back into an attribute of a shorter id, or
    # dropping the tier flag the admin meant to set).
    for pos, token in enumerate(rest[: index + 1]):
        if "=" in token:
            key = token.partition("=")[0]
            field = _find_field(entry.cls, key)
            if field is not None:
                # A DECLARED attribute's token landed in the id region. Two
                # readings: (a) the attribute was typed before a further
                # suffix (the pinned `max_tokens=100:free` typo) — the
                # fragment's reconstructed value then fails the field's type;
                # (b) the value itself contained ':' (a URL like
                # `base_url=http://host:11434`) and the entry tokenizer split
                # the VALUE at each colon — the reconstructed value then
                # type-checks, so the whole fragment WAS a valid assignment
                # and the delimiter is the only problem. Coercing the
                # reconstruction distinguishes the two; (b) gets an error
                # that names the key and states the rule instead of the
                # generic misplaced-attribute message.
                joined = ":".join(rest[pos : index + 1])
                try:
                    _coerce(key, joined.partition("=")[2], field)
                except ValueError:
                    raise ValueError(
                        f"model id '{model_id}' contains an attribute token — attributes "
                        f"must come after the id as key=value pairs"
                    )
                raise ValueError(
                    f"'{joined}' — the value of '{key}' contains ':' — attribute "
                    f"values cannot contain the entry delimiter ':'"
                )
            raise ValueError(
                f"model id '{model_id}' contains an attribute token — attributes "
                f"must come after the id as key=value pairs"
            )
        if token == "tier":
            raise ValueError(
                f"model id '{model_id}' contains a 'tier' token — the tier flag "
                f"comes after the id (provider:id[:tier][:key=value ...]), "
                f"not inside it"
            )
    return provider, model_id, attrs, tier


def _find_field(cls: type, name: str):
    if dataclasses.is_dataclass(cls):
        for f in dataclasses.fields(cls):
            if f.name == name:
                return f
    return None


def _validate_attrs(cls: type, attrs: Dict[str, Any]) -> None:
    """Defensive re-check of stored attrs against the class's dataclass fields.

    The admin PUT already validates at save time; this guards rows written
    by other means (direct DB edits, downgrades) so a bad row is skipped
    with a warning instead of served dead. That includes the credential-
    attribute rejection: a hand-inserted ``api_key`` would otherwise be
    served as a shared platform fallback key through PlatformMixin.
    """
    if not dataclasses.is_dataclass(cls):
        return
    fields = {f.name: f for f in dataclasses.fields(cls) if f.init}
    for key, value in attrs.items():
        if _CRED_ATTR_RE.search(key):
            raise ValueError(
                f"attribute '{key}' is a credential — models are keyed by the "
                f"platform's own env vars, not per-entry secrets"
            )
        field = fields.get(key)
        if field is None:
            raise ValueError(f"unknown attribute '{key}' for {cls.__name__}")
        ann = field.type
        args = getattr(ann, "__args__", None)
        if args and type(None) in args:
            non_none = [a for a in args if a is not type(None)]
            ann = non_none[0] if len(non_none) == 1 else ann
        if ann is bool:
            if not isinstance(value, bool):
                raise ValueError(f"'{key}' expects bool — got {type(value).__name__}")
        elif ann is int:
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"'{key}' expects int — got {type(value).__name__}")
        elif ann is float:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"'{key}' expects float — got {type(value).__name__}")
        elif ann is str:
            if not isinstance(value, str):
                raise ValueError(f"'{key}' expects str — got {type(value).__name__}")
        # Complex fields (Dict/List/objects) accept any JSON-decoded value.


def _attr_names(cls: type) -> List[str]:
    if not dataclasses.is_dataclass(cls):
        return []
    return [f.name for f in dataclasses.fields(cls) if f.init]


def _coerce(key: str, raw: str, field) -> Any:
    """Coerce a typed attribute value; reject mismatches (dataclasses don't)."""
    ann = field.type
    # Unwrap Optional[...] / unions with None.
    args = getattr(ann, "__args__", None)
    if args and type(None) in args:
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            ann = non_none[0]
        else:
            # A genuine multi-member Union (e.g. base_url:
            # Union[str, httpx.URL, None]): try each member — the first that
            # coerces wins. The old code fell through to json.loads for every
            # multi-member union, rejecting even plain-string values with an
            # opaque "expects Union" (which made URL-typed attributes
            # un-settable through the grammar outright).
            for member in non_none:
                try:
                    return _coerce_typed(key, raw, member)
                except ValueError:
                    continue
            raise ValueError(
                f"'{key}' expects "
                f"{' or '.join(getattr(m, '__name__', str(m)) for m in non_none)}"
                f" — got '{raw}'"
            )
    return _coerce_typed(key, raw, ann)


def _coerce_typed(key: str, raw: str, ann) -> Any:
    """Coerce against one resolved annotation; raises ValueError on mismatch."""
    try:
        if ann is bool:
            if raw.lower() in ("true", "1", "yes"):
                return True
            if raw.lower() in ("false", "0", "no"):
                return False
            raise ValueError(f"'{key}' expects true/false")
        if ann is int:
            return int(raw)
        if ann is float:
            value = float(raw)
            if not math.isfinite(value):
                # nan/inf are accepted by float() but are never sane catalog
                # attribute values (a typo like "nan" or "1e999" would
                # otherwise persist and poison every construction).
                raise ValueError
            return value
        if ann is str:
            return raw
        # Complex fields (Dict/List/objects) accept JSON. Colon-free JSON
        # values DO reach this through the PUT path (a list like [1,2,3]
        # survives the ``:`` tokenization); dict literals cannot — their
        # ``:`` gets split into separate tokens. Direct-DB rows bypass
        # _coerce entirely (_validate_attrs accepts any complex value).
        return json.loads(raw)
    except (ValueError, TypeError, json.JSONDecodeError):
        raise ValueError(f"'{key}' expects {getattr(ann, '__name__', ann)} — got '{raw}'")


# -- endpoint payloads -------------------------------------------------------


def platform_models_payload(state: CatalogState, env: Dict[str, str]) -> dict:
    """GET /platform/models — the builder-facing picker.

    ``provider`` is the catalog SLUG (a door slug like ``openai-responses``,
    not the agno module) — agent configs reference the door, and the run
    gate resolves keys through ``dep_key`` (both openai doors share
    ``openai_api_key``). ``name`` is the registry binding name: component
    configs carry ``model: {id, name}`` and agno's registry disambiguates
    same-id doors by it.

    ``platform_tier`` marks the subset the platform key pays for: the row's
    tier flag AND the provider's platform env key actually set on this
    deployment. Dormant for builder runs (BYOK-only); wakes at Phase 3
    publishing.
    """
    models = []
    for (provider_slug, mid), (entry, tier, name) in sorted(state.model_index.items()):
        env_key = entry.platform_env_key
        tiered = bool(tier and env_key and env.get(env_key))
        models.append(
            {
                "provider": provider_slug,
                "id": mid,
                "name": name,
                "dep_key": entry.dep_key,
                "platform_tier": tiered,
                "requires_key": entry.has_api_key_field,
            }
        )
    return {"models": models}


def _tool_label(name: str) -> str:
    return name.replace("_", " ").strip().capitalize()


def platform_tools_payload(state: CatalogState, env: Dict[str, str]) -> dict:
    """GET /platform/tools — the builder-facing palette (shape preserved; a
    ``credentials`` array added for multi-credential toolkits)."""
    tools: List[dict] = []
    seen: set = set()
    for fn_name, entry in sorted(state.fn_index.items()):
        if fn_name in seen:
            continue
        seen.add(fn_name)
        fn = next(f for f in entry.functions if f["name"] == fn_name)
        creds = entry.credentials
        fallback_env = creds[0].env if creds else None
        tools.append(
            {
                "name": fn_name,
                "label": _tool_label(fn_name),
                "description": fn.get("description"),
                "requires_key": creds[0].dep_key if creds else None,
                "fallback_env": fallback_env,
                "platform_fallback": bool(creds) and all(env.get(c.env) for c in creds),
                "parameters": fn.get("parameters"),
                "toolkit": entry.module,
                "credentials": [
                    {"dep_key": c.dep_key, "label": c.label} for c in creds
                ],
            }
        )
    return {"tools": tools}

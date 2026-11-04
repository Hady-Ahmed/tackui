"""The platform catalog's admin API — the operator's only configuration surface.

All routes are admin-scope (the scope mappings' catch-alls already reject
anything less; the tests pin it). The frontend's admin page is the only client:
it proxies these with its service token; users never see this API.

The admin's actions, in full: tick provider/toolkit checkboxes, type model
ids (one per line, ``provider:id[:tier][:key=value]``), and test a model
entry with one "hi" completion through the platform's own env key. Key
names, labels, and env references are derived from the discovery scan and
rendered read-only — nothing editable here can desynchronize the stack.

Writes are FULL-STATE replaces (the page edits everything and sends it all)
followed by a revision bump; the in-memory registry notices the new revision
on the next request and rebuilds.
"""
import dataclasses
import os
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from agno.models.message import Message

from catalog import ModelRow
from catalog_state import CatalogState, effective_model_name, parse_model_entry


class ProviderUpdate(BaseModel):
    slug: str
    enabled: bool = False
    models: List[str] = Field(default_factory=list)  # grammar entries, one per line


class ModelsUpdate(BaseModel):
    providers: List[ProviderUpdate]


class ToolUpdate(BaseModel):
    slug: str
    enabled: bool = False


class ToolsUpdate(BaseModel):
    tools: List[ToolUpdate]


class ModelTestRequest(BaseModel):
    entry: str


class ConnectorUpsert(BaseModel):
    """One MCP connector endpoint registration. The URL is validated for
    SHAPE here (absolute http(s)); the SSRF decision belongs to the run
    client's create-time guard, and this service never fetches a connector
    URL outside the MCP handshake the run client already authorized."""
    url: str = Field(..., min_length=1, max_length=2000)
    label: Optional[str] = Field(None, max_length=200)


def _state(request: Request) -> CatalogState:
    state = getattr(request.app.state, "catalog", None)
    if state is None:  # pragma: no cover — build_app always installs it
        raise HTTPException(status_code=503, detail="catalog not ready")
    state.ensure_current(request.app.state.agent_os)
    return state


def _model_providers_payload(state: CatalogState, env: Dict[str, str]) -> dict:
    """Discovery ∪ durable rows — everything the admin page renders."""
    rows_by_provider: Dict[str, List[ModelRow]] = {}
    for row in state.db.model_rows():
        rows_by_provider.setdefault(row.provider_slug, []).append(row)
    provider_enabled = state.db.enabled_providers()
    slugs = sorted(set(state.discovery.models) | set(rows_by_provider))
    providers = []
    for slug in slugs:
        entry = state.discovery.model_provider(slug)
        rows = rows_by_provider.get(slug, [])
        providers.append(
            {
                "slug": slug,
                "available": entry is not None,
                "enabled": bool(entry is not None and provider_enabled.get(slug)),
                "class_name": entry.class_name if entry else None,
                "requires_key": entry.has_api_key_field if entry else True,
                "platform_env_key": entry.platform_env_key if entry else None,
                # The DECLARED dependency key — clients must deliver/consume
                # this, not derive it from the slug (a door slug like
                # "openai-responses" shares the "openai_api_key" key).
                "dep_key": entry.dep_key if entry else None,
                "env_key_set": bool(entry and entry.platform_env_key and env.get(entry.platform_env_key)),
                "models": [
                    {"id": r.id, "attrs": r.attrs, "tier": r.tier} for r in rows
                ],
            }
        )
    return {"providers": providers}


def _tools_payload(state: CatalogState) -> dict:
    """The admin page's tools view. Unlike the models payload, no env lookup:
    a toolkit's enabled state is key-independent (keyed toolkits are enabled
    keyless too — runners bring their own)."""
    enabled = state.db.enabled_tools()
    slugs = sorted(set(state.discovery.tools) | set(enabled))
    tools = []
    for slug in slugs:
        entry = state.discovery.tool(slug)
        if entry is None:
            # A row for a toolkit this deployment can no longer offer
            # (agno changed). Visible so the admin can clear it.
            tools.append(
                {
                    "slug": slug,
                    "available": False,
                    "enabled": bool(enabled.get(slug)),
                    "class_name": None,
                    "label": slug,
                    "functions": [],
                    "credentials": [],
                    "deliverable": False,
                }
            )
            continue
        tools.append(
            {
                "slug": slug,
                "available": True,
                "enabled": bool(enabled.get(slug)),
                "class_name": entry.class_name,
                "label": entry.label,
                "functions": [f["name"] for f in entry.functions],
                "credentials": [
                    {"dep_key": c.dep_key, "env": c.env, "arg": c.arg, "label": c.label}
                    for c in entry.credentials
                ],
                "deliverable": entry.deliverable,
            }
        )
    return {"tools": tools}


def _apply_models_update(state: CatalogState, update: ModelsUpdate, request: Request) -> Dict[str, Any]:
    """Validate + persist the full provider/model state; bump the revision."""
    warnings: List[str] = []
    providers: List[tuple] = []
    rows: List[ModelRow] = []
    seen: set = set()
    seen_model_ids: set = set()  # (provider_slug, model id) pairs seen so far
    seen_bindings: Dict[Tuple[str, str], str] = {}  # (id, effective name) -> provider slug
    for provider in update.providers:
        if provider.slug in seen:
            raise HTTPException(status_code=400, detail=f"provider '{provider.slug}' listed twice")
        seen.add(provider.slug)
        entry = state.discovery.model_provider(provider.slug)
        if entry is None:
            if provider.enabled:
                raise HTTPException(
                    status_code=400,
                    detail=f"provider '{provider.slug}' is not available on this deployment",
                )
            # Disabling a provider this deployment can no longer produce =
            # clearing a dead row (an agno upgrade dropped it). Like the
            # tools path, nothing is persisted — absence from the provider
            # list IS disabled — so the dead row (and its model rows) vanish
            # on this save instead of being re-inserted on every save.
            # Surface the vanish in `warnings`: without it the provider would
            # silently disappear from the catalog with no record of why.
            warnings.append(
                f"provider '{provider.slug}' is not available on this deployment "
                f"— its catalog row (if any) was cleared"
            )
            continue
        providers.append((provider.slug, provider.enabled))
        if not provider.enabled:
            if provider.models:
                warnings.append(f"provider '{provider.slug}' is disabled — its model ids were ignored")
            continue
        if not provider.models:
            # An enabled provider with no ids is a dead row in the making:
            # nothing would show in the picker, and the state is easy to
            # create by accident (tick the box, forget the textarea).
            raise HTTPException(
                status_code=400,
                detail=f"provider '{provider.slug}' is enabled but lists no model ids "
                "— an enabled provider needs at least one (one per line)",
            )
        for raw in provider.models:
            try:
                _, model_id, attrs, tier = parse_model_entry(raw, state.discovery, default_provider=provider.slug)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"'{raw}': {e}")
            if (provider.slug, model_id) in seen_model_ids:
                # Per-provider uniqueness — the composite PK (provider_slug,
                # id) would reject it anyway, but the 400 here names the
                # duplicate instead of surfacing an IntegrityError. The same
                # id under DIFFERENT providers is now fine: one provider =
                # one class, so the registry binding (id + effective name)
                # stays globally unique even across the openai-chat /
                # openai-responses doors — and the binding check below
                # ENFORCES that invariant (it is not free: two modules can
                # define same-named classes, and name= is a settable attr).
                raise HTTPException(
                    status_code=400,
                    detail=f"model id '{model_id}' is listed twice under provider '{provider.slug}'",
                )
            seen_model_ids.add((provider.slug, model_id))
            # The registry binding pair: get_model(id, name) must resolve to
            # exactly one instance. Two rows sharing BOTH would reintroduce
            # the silent wrong-door ambiguity the old global id-uniqueness
            # rule prevented — reject with the collision named.
            binding = (model_id, effective_model_name(state.discovery.model_provider(provider.slug), attrs))
            if binding in seen_bindings:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"model '{model_id}' under provider '{provider.slug}' would register twice "
                        f"under binding name '{binding[1]}' (also listed under provider "
                        f"'{seen_bindings[binding]}') — the registry could not tell the two apart; "
                        "give one of them a distinct name= attribute"
                    ),
                )
            seen_bindings[binding] = provider.slug
            # Construct-check the exact entry (keyless — membership is
            # key-independent; the platform key is never needed to offer).
            try:
                _wrapper_probe(state, provider.slug, model_id, attrs)
            except HTTPException:
                # _wrapper_probe raises deliberate 4xx HTTPExceptions (its
                # unavailable-provider guard); re-raise as-is — re-wrapping
                # would convert a clean 400 into a bogus
                # "does not construct (HTTPException: …)" 400.
                raise
            except Exception as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{raw}' does not construct ({type(e).__name__}: {str(e)[:200]})",
                )
            rows.append(ModelRow(provider_slug=provider.slug, id=model_id, attrs=attrs, tier=tier))
    state.db.replace_providers_and_models(providers, rows)
    # Eagerly refresh so the write is immediately visible on this app
    # (the lazy revision check still covers staleness from other writers).
    state.refresh(request.app.state.agent_os)
    return {"ok": True, "revision": state.revision, "warnings": warnings}


def _wrapper_probe(state: CatalogState, provider: str, model_id: str, attrs: Dict[str, Any]):
    from catalog_state import _wrapper_for

    entry = state.discovery.model_provider(provider)
    if entry is None:
        # Callers validate the slug before probing; kept explicit (never an
        # assert — asserts vanish under `python -O`) so the invariant
        # surfaces as a clean 400 instead of an AttributeError.
        raise HTTPException(
            status_code=400,
            detail=f"provider '{provider}' is not available on this deployment",
        )
    return _wrapper_for(entry)(id=model_id, **attrs)


def _class_field_names(cls: type) -> set:
    if dataclasses.is_dataclass(cls):
        return {f.name for f in dataclasses.fields(cls)}
    return set()


def _apply_tools_update(state: CatalogState, update: ToolsUpdate, request: Request) -> Dict[str, Any]:
    seen: set = set()
    enabled_slugs: List[str] = []
    for tool in update.tools:
        if tool.slug in seen:
            raise HTTPException(status_code=400, detail=f"toolkit '{tool.slug}' listed twice")
        seen.add(tool.slug)
        entry = state.discovery.tool(tool.slug)
        if entry is None:
            if tool.enabled:
                raise HTTPException(
                    status_code=400,
                    detail=f"toolkit '{tool.slug}' is not available on this deployment",
                )
            # Disabling an unavailable toolkit = clearing a dead row;
            # absence from the enabled list IS disabled, nothing to persist.
            continue
        if tool.enabled:
            if not entry.deliverable:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"toolkit '{tool.slug}' has no key delivery path "
                        f"(env vars read without a constructor argument: "
                        f"{', '.join(entry.undeliverable_envs)}) — it needs code"
                    ),
                )
            enabled_slugs.append(tool.slug)
    state.db.replace_tools(enabled_slugs)
    state.refresh(request.app.state.agent_os)
    # ``warnings`` is always empty here — a tool row carries no inline data
    # (unlike the models PUT, where a disabled provider's typed ids are
    # silently ignored), so there is nothing to warn about. The key stays
    # for response-shape parity with the models PUT.
    return {"ok": True, "revision": state.revision, "warnings": []}


def _test_model(state: CatalogState, env: Dict[str, str], entry: str) -> Dict[str, Any]:
    """One 'hi' completion straight to the provider — the model object only.

    This is not an agent test: no agent, no tools, no instructions. It
    answers exactly one question — does this id exist and does the
    platform's key work? The full end-to-end test is chatting with a real
    agent after building one.
    """
    try:
        # No ``default_provider`` here, unlike the models PUT (which resolves
        # bare ids against the provider block they were typed under): this
        # request body carries a single standalone entry with no block
        # context, so the full grammar (provider:id ...) is required and an
        # explicit provider prefix is honored exactly as typed — there is no
        # fallback to silently re-home a bare id under.
        provider, model_id, attrs, _tier = parse_model_entry(entry, state.discovery)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    provider_entry = state.discovery.model_provider(provider)
    if provider_entry is None:
        # parse_model_entry already rejects unavailable providers; kept
        # explicit (never an assert — asserts vanish under `python -O`).
        raise HTTPException(
            status_code=400,
            detail=f"provider '{provider}' is not available on this deployment",
        )
    env_key = provider_entry.platform_env_key
    if not env_key or not env.get(env_key):
        raise HTTPException(
            status_code=400,
            detail=(
                f"no platform key for '{provider}' on this deployment "
                f"(env {env_key or '— none derived'} is not set) — the entry can still be "
                f"enabled; runners must bring their own key"
            ),
        )
    test_attrs = dict(attrs)
    # Cap the probe wherever the class accepts it: without a timeout the
    # OpenAI SDK's default (~10 min) applies, and an unbounded completion
    # would hold the request far past the client's own 10s proxy timeout. One
    # "hi" completion needs only a small token budget; an explicitly typed
    # attribute (max_tokens=100) keeps its value (setdefault). Fields the
    # class does not declare cannot be passed — construction would reject
    # them — so the caps are applied per declared field.
    for cap, value in (("timeout", 30), ("max_tokens", 64)):
        if cap in _class_field_names(provider_entry.cls):
            test_attrs.setdefault(cap, value)
    try:
        model = _wrapper_probe(state, provider, model_id, test_attrs)
        response = model.response(messages=[Message(role="user", content="hi")])
    except HTTPException:
        # Same rule as the PUT's probe caller: deliberate 4xx HTTPExceptions
        # pass through — the broad wrapper below is for genuine unexpected
        # errors only ("test failed: HTTPException: 400: …" helps nobody).
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"test failed: {str(e)[:300]}")
    content = getattr(response, "content", None) or ""
    return {"ok": True, "reply": str(content)[:200]}


def attach_admin_routes(app: FastAPI) -> None:
    @app.get("/platform/available", name="platform_available")
    def get_available(request: Request):
        """The discovery menu — everything this deployment COULD offer.

        Unimportable or unconstructible entries are absent (they do not
        exist here); this is the enable-able universe.
        """
        state = _state(request)
        return {
            "models": [
                {
                    "slug": e.slug,
                    "class_name": e.class_name,
                    "requires_key": e.has_api_key_field,
                    "platform_env_key": e.platform_env_key,
                    "dep_key": e.dep_key,
                }
                for e in sorted(state.discovery.models.values(), key=lambda m: m.slug)
            ],
            "tools": [
                {
                    "slug": e.module,
                    "class_name": e.class_name,
                    "label": e.label,
                    "functions": [f["name"] for f in e.functions],
                    "credentials": [
                        {"dep_key": c.dep_key, "env": c.env, "label": c.label}
                        for c in e.credentials
                    ],
                    "deliverable": e.deliverable,
                }
                for e in sorted(state.discovery.tools.values(), key=lambda t: t.module)
            ],
        }

    @app.get("/platform/catalog/models", name="platform_catalog_models_get")
    def get_catalog_models(request: Request):
        return _model_providers_payload(_state(request), dict(os.environ))

    @app.put("/platform/catalog/models", name="platform_catalog_models_put")
    def put_catalog_models(update: ModelsUpdate, request: Request):
        return _apply_models_update(_state(request), update, request)

    @app.get("/platform/catalog/tools", name="platform_catalog_tools_get")
    def get_catalog_tools(request: Request):
        return _tools_payload(_state(request))

    @app.put("/platform/catalog/tools", name="platform_catalog_tools_put")
    def put_catalog_tools(update: ToolsUpdate, request: Request):
        return _apply_tools_update(_state(request), update, request)

    @app.get("/platform/connectors", name="platform_connectors_get")
    def get_connectors(request: Request):
        """The registered MCP connector endpoints — admin/debug surface.

        URLs only, never tokens: connector credentials are per-run deps
        delivered by the run client, they never touch this service's
        storage. Rows are written by the run client's server (push-first),
        and the dispatcher resolves attach URLs from here — a wire URL is
        never an input the platform acts on."""
        state = _state(request)
        return {
            "connectors": [
                {"connectorId": cid, "url": url, "label": label}
                for cid, (url, label) in sorted(state.connector_index.items())
            ]
        }

    @app.put("/platform/connectors/{connector_id}", name="platform_connector_put")
    def put_connector(connector_id: str, body: ConnectorUpsert, request: Request):
        """Upsert one connector endpoint (idempotent — the run client
        pushes on connector create/edit AND at agent save)."""
        if not connector_id or len(connector_id) > 200:
            raise HTTPException(status_code=400, detail="connector id must be 1-200 characters")
        parsed = urlparse(body.url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise HTTPException(status_code=400, detail="url must be an absolute http(s) URL")
        revision = _state(request).db.upsert_connector(connector_id, body.url, body.label)
        return {"ok": True, "revision": revision}

    @app.delete("/platform/connectors/{connector_id}", name="platform_connector_delete")
    def delete_connector_route(connector_id: str, request: Request):
        """Remove one connector endpoint. Idempotent: deleting an unknown
        id still bumps the revision (the delete is the state)."""
        if not connector_id or len(connector_id) > 200:
            raise HTTPException(status_code=400, detail="connector id must be 1-200 characters")
        revision = _state(request).db.delete_connector(connector_id)
        return {"ok": True, "revision": revision}

    @app.post("/platform/test/model", name="platform_model_test")
    def test_model(body: ModelTestRequest, request: Request):
        return _test_model(_state(request), dict(os.environ), body.entry)

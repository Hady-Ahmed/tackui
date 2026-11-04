"""DB-backed catalog + admin API coverage:

1. Tables auto-create on boot; empty catalog serves nothing (no seed).
2. Discovery shapes: providers, toolkits, credential contracts, dedupe.
3. Admin CRUD authz (admin scope only) and validation failures.
4. Revision-bump rebuild: admin writes go live without restart.
5. Fail-closed rebuild: unconstructible/obsolete rows are warned and skipped
   (JSONB makes unparseable attrs structurally impossible, so there is no
   corrupt-attrs decode path anymore).
6. Model test endpoint behavior.
"""
import dataclasses
import json
import logging
import threading
import time

import catalog
import psycopg
import pytest

from catalog import CatalogDB, ModelRow
from catalog import _pool_for
from catalog_state import CatalogState, parse_model_entry, platform_models_payload
from discovery import discover, discover_models

from conftest import seed_catalog
from platform_test_helpers import admin_headers, user_headers


# ---------------------------------------------------------------------------
# Boot + tables
# ---------------------------------------------------------------------------


def test_catalog_tables_auto_created_on_boot(bare_app, postgres_dsn):
    with psycopg.connect(postgres_dsn) as conn:
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
            ).fetchall()
        }
    assert {
        "platform_provider",
        "platform_model",
        "platform_tool",
        "platform_catalog_version",
    } <= tables


def test_empty_catalog_serves_nothing(bare_client, bare_app):
    # No seed: tables start empty — the picker and palette expose nothing.
    res = bare_client.get("/platform/models", headers=admin_headers(sub="frontend-service"))
    assert res.status_code == 200
    assert res.json() == {"models": []}
    res = bare_client.get("/platform/tools", headers=admin_headers(sub="frontend-service"))
    assert res.status_code == 200
    assert res.json() == {"tools": []}
    # The registry exists but holds no offerings.
    registry = bare_app.state.agent_os.registry
    assert registry.models == [] and registry.tools == []


# ---------------------------------------------------------------------------
# Discovery shapes
# ---------------------------------------------------------------------------


def test_discovery_models_shape():
    disc = discover()
    assert "openai-chat" in disc.models
    openai = disc.models["openai-chat"]
    assert openai.class_name == "OpenAIChat"
    assert openai.platform_env_key == "OPENAI_API_KEY"
    assert openai.has_api_key_field is True
    assert openai.dep_key == "openai_api_key"
    assert "openrouter" in disc.models
    # Every surviving provider constructs keyless by construction of the scan.
    for entry in disc.models.values():
        assert entry.cls is not None


def test_discovery_exposes_every_concrete_door():
    """No canonical picks: every class a module defines is an offering. The
    openai module ships its two API doors AND its generic adapters, each
    under its own derived slug — the admin decides what to enable."""
    disc = discover()
    # openai's doors and adapters, distinct slugs, shared credential. The
    # slug mirrors agno's file layout: chat.py → openai-chat,
    # responses.py → openai-responses.
    assert disc.models["openai-chat"].class_name == "OpenAIChat"
    assert disc.models["openai-responses"].class_name == "OpenAIResponses"
    assert disc.models["openai-like"].class_name == "OpenAILike"
    assert disc.models["openai-open-responses"].class_name == "OpenResponses"
    for slug in (
        "openai-chat",
        "openai-responses",
        "openai-like",
        "openai-open-responses",
    ):
        entry = disc.models[slug]
        assert entry.module == "openai"
        assert entry.dep_key == "openai_api_key"  # one vendor key, all doors
        assert entry.platform_env_key == "OPENAI_API_KEY"
    # agno's vendor/vendor.py convention keeps the bare module slug; the
    # distinct files get suffixed:
    assert disc.models["openrouter"].class_name == "OpenRouter"
    assert disc.models["openrouter-responses"].class_name == "OpenRouterResponses"
    assert disc.models["openrouter-responses"].dep_key == "openrouter_api_key"
    assert disc.models["xai"].class_name == "xAI"
    assert disc.models["xai-responses"].class_name == "xAIResponses"
    assert disc.models["azure-openai-chat"].class_name == "AzureOpenAI"
    assert disc.models["azure-openai-responses"].class_name == "AzureOpenAIResponses"
    assert disc.models["azure-openai-responses"].dep_key == "azure_api_key"


def test_discovery_slug_derivation_is_derived_not_picked():
    """The slug mirrors agno's file layout — no hand-written map, no
    primary-class heuristic. Pin the derivation helper directly: the
    module's own file keeps the bare module slug; a distinct submodule
    suffixes it."""
    from discovery import _offering_slug

    class FakeChat:
        __module__ = "agno.models.openai.chat"

    class FakeResponses:
        __module__ = "agno.models.openai.responses"

    class FakeUnderscored:
        __module__ = "agno.models.azure.openai_responses"

    class FakeVendorFile:
        __module__ = "agno.models.openrouter.openrouter"

    class FakeSingleFile:
        __module__ = "agno.models.somevendor"

    assert _offering_slug("openai", FakeChat) == "openai-chat"
    assert _offering_slug("openai", FakeResponses) == "openai-responses"
    assert (
        _offering_slug("azure", FakeUnderscored)
        == "azure-openai-responses"
    )
    assert _offering_slug("openrouter", FakeVendorFile) == "openrouter"
    assert _offering_slug("somevendor", FakeSingleFile) == "somevendor"


def test_model_env_scan_requires_assignment_shape():
    """The model env scan matches only ASSIGNMENT-SHAPED lines (like the
    tools scanner) — a docstring that merely MENTIONS another *_API_KEY
    (prose around the call, no assignment on the line) must not misderive
    the provider's platform_env_key. The agno idioms all still match; the
    full derivation over the shipped providers is pinned by
    test_discovery_models_shape."""
    from discovery import _MODEL_ENV_RE

    # agno's value-position idioms all match:
    assert _MODEL_ENV_RE.search('self.api_key = getenv("OPENAI_API_KEY")').group(1) == "OPENAI_API_KEY"
    assert (
        _MODEL_ENV_RE.search('self.api_key = self.api_key or getenv("AZURE_API_KEY")').group(1)
        == "AZURE_API_KEY"
    )
    assert (
        _MODEL_ENV_RE.search('api_key: Optional[str] = field(default_factory=lambda: getenv("NEBIUS_API_KEY"))').group(1)
        == "NEBIUS_API_KEY"
    )
    assert _MODEL_ENV_RE.search('params["api_key"] = os.environ.get("MINE_API_KEY")').group(1) == "MINE_API_KEY"
    # Prose mentions do NOT match:
    assert _MODEL_ENV_RE.search('Reads the key via getenv("SOMEWHERE_API_KEY") when unset.') is None
    assert _MODEL_ENV_RE.search('Uses SOMEWHERE_API_KEY from the environment.') is None


def test_discovery_tools_shape_and_contracts():
    disc = discover()
    tavily = disc.tool("tavily")
    assert tavily is not None and tavily.class_name == "TavilyTools"
    assert tavily.keyed and tavily.deliverable
    assert [c.dep_key for c in tavily.credentials] == ["tavily_api_key"]
    assert [c.env for c in tavily.credentials] == ["TAVILY_API_KEY"]
    assert [c.arg for c in tavily.credentials] == ["api_key"]
    fn_names = {f["name"] for f in tavily.functions}
    assert "web_search_using_tavily" in fn_names
    # Function schemas are processed at scan time.
    schema = next(f for f in tavily.functions if f["name"] == "web_search_using_tavily")
    assert schema["parameters"]["properties"]["query"]["type"] == "string"

    # Keyless toolkit: DuckDuckGo carries no credential contract.
    ddg = disc.tool("duckduckgo")
    assert ddg is not None and not ddg.keyed and ddg.deliverable
    assert {"web_search", "search_news"} <= {f["name"] for f in ddg.functions}


def test_discovery_dedupes_identical_function_sets():
    # duckduckgo.DuckDuckGoTools and websearch.WebSearchTools expose the same
    # function set under the same toolkit name — only one is offered.
    disc = discover()
    assert ("duckduckgo" in disc.tools) != ("websearch" in disc.tools)
    assert any("duplicates an already-scanned function set" in s for s in disc.skipped)


def test_dedupe_tools_surfaces_same_module_collision():
    """Two Toolkit subclasses in the SAME module with different function
    sets both pass the function-set dedupe; the slug key can hold only one
    and the later entry overwrites the first. The overwrite is surfaced in
    `skipped` like the cross-module dedupe does — which one wins is
    unchanged (the later class keeps the slug)."""
    from discovery import ToolEntry, _dedupe_tools

    def entry(class_name: str, fn: str) -> ToolEntry:
        return ToolEntry(
            module="duo",
            class_name=class_name,
            cls=type(class_name, (), {}),
            toolkit_name=class_name,
            functions=[{"name": fn, "description": None, "parameters": {}}],
            credentials=[],
        )

    skipped: list = []
    out = _dedupe_tools(
        [("duo", entry("First", "fn_a")), ("duo", entry("Second", "fn_b"))], skipped
    )
    assert set(out) == {"duo"}
    assert out["duo"].class_name == "Second"  # outcome unchanged (later wins)
    assert any("overwrites the earlier" in s and "duo" in s for s in skipped)

    # Identical function sets still dedupe across modules as before.
    skipped2: list = []
    out2 = _dedupe_tools(
        [("mod_a", entry("A", "fn_x")), ("mod_b", entry("B", "fn_x"))], skipped2
    )
    assert set(out2) == {"mod_a"}
    assert any("duplicates an already-scanned function set" in s for s in skipped2)


def test_unavailable_modules_are_skipped_not_served():
    disc = discover()
    # This deployment lacks the apify/tweepy SDKs: those toolkits are absent.
    assert "apify" not in disc.tools and "x" not in disc.tools
    assert any("'apify' did not import" in s for s in disc.skipped)


def test_discovery_is_cached_per_process():
    assert discover() is discover()


# ---------------------------------------------------------------------------
# Admin CRUD: authz + validation
# ---------------------------------------------------------------------------


def test_admin_routes_reject_user_tokens(bare_client):
    h = user_headers()
    assert bare_client.get("/platform/available", headers=h).status_code == 403
    assert bare_client.get("/platform/catalog/models", headers=h).status_code == 403
    assert bare_client.put("/platform/catalog/models", headers=h, json={"providers": []}).status_code == 403
    assert bare_client.get("/platform/catalog/tools", headers=h).status_code == 403
    assert bare_client.put("/platform/catalog/tools", headers=h, json={"tools": []}).status_code == 403
    assert (
        bare_client.post("/platform/test/model", headers=h, json={"entry": "openai-chat:gpt-4o-mini"}).status_code
        == 403
    )


def test_put_models_rejects_unknown_provider(bare_client):
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin_headers(sub="frontend-service"),
        json={"providers": [{"slug": "not-a-provider", "enabled": True, "models": ["x:y"]}]},
    )
    assert res.status_code == 400
    assert "not available" in res.json()["detail"]


def test_put_models_rejects_enabled_without_ids(bare_client):
    admin = admin_headers(sub="frontend-service")
    # Tick the box, forget the textarea — the state the UI must not be able
    # to save: an enabled provider with nothing in the picker.
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": []}]},
    )
    assert res.status_code == 400
    assert "no model ids" in res.json()["detail"]
    # A disabled provider with no ids stays legal (the clear-a-dead-row path).
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": False, "models": []}]},
    )
    assert res.status_code == 200


def test_put_models_rejects_bad_entry_grammar_and_attrs(bare_client):
    admin = admin_headers(sub="frontend-service")
    # An entry naming a DIFFERENT provider inside another provider's block.
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openrouter:some-model"]}]},
    )
    assert res.status_code == 400
    assert "openrouter" in res.json()["detail"]
    # Unknown attribute on the provider class.
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini:bogus_attr=1"]}]},
    )
    assert res.status_code == 400
    assert "bogus_attr" in res.json()["detail"]
    # Mistyped attribute value.
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini:max_tokens=abc"]}]},
    )
    assert res.status_code == 400
    assert "max_tokens" in res.json()["detail"]
    # The 'id' attribute is reserved.
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini:id=other"]}]},
    )
    assert res.status_code == 400


def test_put_models_warns_on_disabled_provider_with_ids(bare_client, bare_app):
    """The `warnings` path: a disabled provider's typed ids are ignored (the
    row is not persisted) — the response must say so instead of silently
    swallowing the text the admin typed."""
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": False, "models": ["openai-chat:gpt-4o-mini"]}]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["warnings"] == ["provider 'openai-chat' is disabled — its model ids were ignored"]
    assert bare_app.state.catalog.db.model_rows() == []


def test_put_models_rejects_duplicate_provider(bare_client):
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin_headers(sub="frontend-service"),
        json={
            "providers": [
                {"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini"]},
                {"slug": "openai-chat", "enabled": False},
            ]
        },
    )
    assert res.status_code == 400
    assert "twice" in res.json()["detail"]


def test_put_tools_rejects_unknown_and_undeliverable(bare_client):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/tools", headers=admin, json={"tools": [{"slug": "ghost", "enabled": True}]}
    )
    assert res.status_code == 400
    # An unimportable toolkit is not a menu entry → unknown → 400.
    res = bare_client.put(
        "/platform/catalog/tools", headers=admin, json={"tools": [{"slug": "apify", "enabled": True}]}
    )
    assert res.status_code == 400


def test_put_tools_rejects_undeliverable_toolkit(bare_client, bare_app, monkeypatch):
    """A toolkit that reads a credential-shaped env var with no constructor
    argument has no per-run delivery path — enabling it must 400. The scan
    currently finds no undeliverable toolkit on this deployment, so one is
    faked onto the (process-cached) discovery."""
    import dataclasses

    state = bare_app.state.catalog
    broken = dataclasses.replace(
        state.discovery.tool("calculator"), undeliverable_envs=["CALCULATOR_GHOST_TOKEN"]
    )
    monkeypatch.setitem(state.discovery.tools, "calculator", broken)
    res = bare_client.put(
        "/platform/catalog/tools",
        headers=admin_headers(sub="frontend-service"),
        json={"tools": [{"slug": "calculator", "enabled": True}]},
    )
    assert res.status_code == 400
    assert "no key delivery path" in res.json()["detail"]
    assert "CALCULATOR_GHOST_TOKEN" in res.json()["detail"]
    assert bare_app.state.catalog.db.enabled_tools() == {}


def test_put_tools_accepts_keyless_and_keyed_deliverable(bare_client):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/tools",
        headers=admin,
        json={"tools": [{"slug": "duckduckgo", "enabled": True}, {"slug": "tavily", "enabled": True}]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["revision"] >= 1


# ---------------------------------------------------------------------------
# Revision-bump rebuild (live updates, no restart)
# ---------------------------------------------------------------------------


def test_concurrent_stale_rebuild_happens_once(bare_app, monkeypatch):
    """Two threads that both see a stale registry must not both rebuild: the
    rebuild lock serializes check→rebuild→swap with a staleness re-check
    inside the lock, so exactly one rebuild runs and the second thread
    reuses its result. FastAPI's sync endpoints run in a threadpool, so
    this race is real, not hypothetical."""
    state = bare_app.state.catalog
    state.db.replace_providers_and_models(
        [("openai-chat", True)], [ModelRow("openai-chat", "gpt-4o-mini", {}, False)]
    )
    # Force the stale path for every caller: registry absent, revision behind.
    state.registry = None
    state.revision = -1
    calls: list = []
    real_build = CatalogState._build_registry

    def slow_build(self, snapshot):
        calls.append(threading.get_ident())
        # Hold the lock long enough that the second thread is guaranteed to
        # be waiting on it before the first finishes.
        time.sleep(0.2)
        return real_build(self, snapshot)

    monkeypatch.setattr(CatalogState, "_build_registry", slow_build)
    barrier = threading.Barrier(2, timeout=5)

    def worker():
        barrier.wait()
        state.ensure_current(bare_app.state.agent_os)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert not any(t.is_alive() for t in threads)
    assert len(calls) == 1
    assert [m.id for m in state.registry.models] == ["gpt-4o-mini"]
    assert state.revision == state.db.get_revision()


def test_write_during_rebuild_is_not_swallowed(bare_app, monkeypatch):
    """A write committing while a rebuild is in flight must not be stamped
    as 'already built'.

    The rebuild reads revision + rows over ONE transaction and stamps the
    revision it captured — so a write landing after the snapshot leaves
    ``state.revision`` behind the catalog's and the next ``ensure_current``
    rebuilds again. The old code re-read the revision AFTER the row reads
    (spanning several connections): a write committing in between stamped
    its NEW revision onto a registry built from OLD rows, ``ensure_current``
    then saw "current" until the NEXT write — a missed wakeup that left
    every non-self writer's change permanently unserved."""
    state = bare_app.state.catalog
    state.db.replace_providers_and_models(
        [("openai-chat", True)], [ModelRow("openai-chat", "gpt-4o-mini", {}, False)]
    )
    # Force the rebuild path: registry absent, revision behind.
    state.registry = None
    state.revision = -1

    real_build = CatalogState._build_registry
    builds: list = []

    def counting_build(self, snapshot):
        builds.append("build")
        return real_build(self, snapshot)

    def build_then_write(self, snapshot):
        registry = counting_build(self, snapshot)
        # A concurrent admin write commits while the rebuild is finishing —
        # after the snapshot the build consumed, before the (old) final
        # revision read it could absorb.
        state.db.replace_tools(["calculator"])
        return registry

    monkeypatch.setattr(CatalogState, "_build_registry", build_then_write)
    state.refresh()

    # The stamped revision is the snapshot's (pre-write): the concurrent
    # write's bump is still pending, NOT absorbed into the rebuild.
    assert state.revision != state.db.get_revision()

    # The next ensure_current therefore REBUILDS again (the stale stamp
    # cannot happen) and the registry picks up the concurrent write.
    monkeypatch.setattr(CatalogState, "_build_registry", counting_build)
    state.ensure_current(bare_app.state.agent_os)
    assert len(builds) == 2
    assert state.revision == state.db.get_revision()
    # The rebuilt registry now serves the concurrent write (the calculator
    # toolkit's "add" function is indexed).
    assert "add" in state.fn_index


def test_put_models_goes_live_without_restart(bare_client, bare_app):
    admin = admin_headers(sub="frontend-service")
    before = bare_client.get("/platform/models", headers=admin).json()
    assert before == {"models": []}

    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openrouter", "enabled": True, "models": ["openrouter:z-ai/glm-5.3-flash:max_tokens=8192"]}]},
    )
    assert res.status_code == 200, res.text

    after = bare_client.get("/platform/models", headers=admin).json()
    assert [m["id"] for m in after["models"]] == ["z-ai/glm-5.3-flash"]
    assert after["models"][0]["platform_tier"] is False
    # The AgentOS registry was swapped to the rebuilt instance.
    assert [m.id for m in bare_app.state.agent_os.registry.models] == ["z-ai/glm-5.3-flash"]


def test_put_models_disable_stops_existing_agents(bare_client, bare_app):
    """The documented semantic change: disabling a model row does not just
    hide it from the picker — the registry loses the instance, so existing
    agents referencing it stop running it."""
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini"]}]},
    )
    assert res.status_code == 200
    assert [m.id for m in bare_app.state.agent_os.registry.models] == ["gpt-4o-mini"]

    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": False}]},
    )
    assert res.status_code == 200
    assert bare_app.state.agent_os.registry.models == []
    assert bare_client.get("/platform/models", headers=admin).json() == {"models": []}


def test_put_tools_goes_live_without_restart(bare_client, bare_app):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/tools", headers=admin, json={"tools": [{"slug": "calculator", "enabled": True}]}
    )
    assert res.status_code == 200
    registry_tools = bare_app.state.agent_os.registry.tools
    assert [t.name for t in registry_tools] == ["calculator"]
    assert "add" in bare_app.state.catalog.fn_index


def test_repeated_put_without_changes_is_idempotent_state_wise(bare_client, bare_app):
    admin = admin_headers(sub="frontend-service")
    body = {"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini"]}]}
    assert bare_client.put("/platform/catalog/models", headers=admin, json=body).status_code == 200
    rev1 = bare_app.state.catalog.db.get_revision()
    assert bare_client.put("/platform/catalog/models", headers=admin, json=body).status_code == 200
    rev2 = bare_app.state.catalog.db.get_revision()
    assert rev2 == rev1 + 1
    # Same rows → an identical registry rebuild (ids unchanged).
    bare_app.state.catalog.ensure_current(bare_app.state.agent_os)
    assert [m.id for m in bare_app.state.agent_os.registry.models] == ["gpt-4o-mini"]


def test_put_clears_rows_for_unavailable_offerings(bare_client, bare_app):
    """Disabling a provider/toolkit this deployment can no longer produce is
    the legit way to clear a dead row; enabling one still 400s."""
    admin = admin_headers(sub="frontend-service")
    db = bare_app.state.catalog.db
    # Dead rows, written directly (as an agno upgrade would leave behind).
    db.replace_providers_and_models(
        [("ghost", True)],
        [ModelRow("ghost", "phantom-model", {}, False)],
    )
    db.replace_tools(["ghosttool"])
    # Enabled → 400 (offering something the deployment cannot produce).
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "ghost", "enabled": True, "models": []}]},
    )
    assert res.status_code == 400
    res = bare_client.put(
        "/platform/catalog/tools", headers=admin, json={"tools": [{"slug": "ghosttool", "enabled": True}]}
    )
    assert res.status_code == 400
    # Disabled → the dead rows are cleared. Like the tools path, nothing is
    # persisted for unavailable slugs: the provider row itself is gone, not
    # re-inserted as an enabled=0 husk on every save. The vanish is surfaced
    # in `warnings` so the operator can see why the provider disappeared.
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "ghost", "enabled": False, "models": []}]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["warnings"] == [
        "provider 'ghost' is not available on this deployment — its catalog row (if any) was cleared"
    ]
    res = bare_client.put(
        "/platform/catalog/tools", headers=admin, json={"tools": [{"slug": "ghosttool", "enabled": False}]}
    )
    assert res.status_code == 200, res.text
    assert res.json()["warnings"] == []  # tool rows carry no inline data to warn about
    assert db.model_rows() == []
    assert db.enabled_providers() == {}
    assert db.enabled_tools() == {}


# ---------------------------------------------------------------------------
# Fail-closed rebuild (corrupt/obsolete rows bypassing PUT validation)
# ---------------------------------------------------------------------------


def test_rebuild_skips_unconstructible_rows_with_warning(bare_app, caplog, monkeypatch):
    # agno's logger does not propagate; mirror it into the capture handler.
    monkeypatch.setattr(logging.getLogger("agno"), "propagate", True)
    db = bare_app.state.catalog.db
    # Bypass the admin API: write a row the scan cannot construct.
    db.replace_providers_and_models(
        [("openai-chat", True), ("ghost", True)],
        [
            ModelRow("openai-chat", "gpt-4o-mini", {"max_tokens": 8192}, False),
            ModelRow("ghost", "phantom-model", {}, False),
        ],
    )
    with caplog.at_level(logging.WARNING, logger="agno"):
        bare_app.state.catalog.refresh()
    ids = [m.id for m in bare_app.state.catalog.registry.models]
    assert ids == ["gpt-4o-mini"]  # the ghost provider's row was skipped
    assert any("not available on this deployment" in r.message for r in caplog.records)


def test_rebuild_skips_models_with_invalid_attrs(bare_app):
    db = bare_app.state.catalog.db
    db.replace_providers_and_models(
        [("openai-chat", True)],
        [
            ModelRow("openai-chat", "good", {}, False),
            ModelRow("openai-chat", "bad", {"max_tokens": "not-a-number"}, False),
        ],
    )
    bare_app.state.catalog.refresh()
    ids = [m.id for m in bare_app.state.catalog.registry.models]
    assert ids == ["good"]


def test_jsonb_attrs_round_trip_dicts(postgres_dsn):
    """attrs is a native JSONB column: the dict written comes back as the
    same dict (psycopg decodes JSONB straight to Python) — nested shapes
    included. The old sqlite TEXT column needed a json.loads decode plus a
    skip-on-read guard for unparseable rows; JSONB makes a corrupt row
    structurally impossible (Postgres rejects malformed JSON at write
    time), so there is no decode and no guard to test."""
    db = CatalogDB(postgres_dsn)
    attrs = {"max_tokens": 8192, "nested": {"list": [1, "two", None]}}
    db.replace_providers_and_models(
        [("openai-chat", True)],
        [ModelRow("openai-chat", "gpt-4o-mini", attrs, False)],
    )
    rows = db.model_rows()
    assert len(rows) == 1
    assert isinstance(rows[0].attrs, dict)
    assert rows[0].attrs == attrs
    assert rows[0].tier is False


def test_reinit_preserves_revision(postgres_dsn):
    """The version-row bootstrap is INSERT ... ON CONFLICT (id) DO NOTHING:
    re-initializing CatalogDB (a second app boot against the same db) must
    never reset the revision counter — in-memory registries in other
    processes compare revisions to detect changes."""
    db = CatalogDB(postgres_dsn)
    db.replace_tools(["calculator"])
    revision = db.get_revision()
    assert revision >= 1
    CatalogDB(postgres_dsn)  # re-init: the DO NOTHING upsert must not clobber
    assert db.get_revision() == revision


def test_schema_version_stamped_on_fresh_and_tolerated_on_reinit(postgres_dsn):
    """A fresh database gets the marker stamped at the column default; a
    re-init against the SAME version boots normally (the check is about
    mismatched shapes, not repeat boots)."""
    CatalogDB(postgres_dsn)
    with _pool_for(postgres_dsn).connection() as conn:
        stored = conn.execute(
            "SELECT schema_version FROM platform_catalog_version WHERE id = 1"
        ).fetchone()[0]
    assert stored == catalog._SCHEMA_VERSION
    CatalogDB(postgres_dsn)  # same version → boots fine


def test_schema_version_mismatch_refuses_to_serve(postgres_dsn):
    """Code and tables disagreeing about the platform_* shapes must fail
    LOUDLY at boot, not serve rows it misreads. Simulate an older code
    version's database by stamping a lower marker."""
    CatalogDB(postgres_dsn)
    with _pool_for(postgres_dsn).connection() as conn:
        conn.execute(
            "UPDATE platform_catalog_version SET schema_version = 0 WHERE id = 1"
        )
    with pytest.raises(RuntimeError, match="schema version mismatch"):
        CatalogDB(postgres_dsn)


def test_on_conflict_upsert_writes_win(postgres_dsn):
    """Pinned Postgres behavior under the new layer: conflicting writes go
    through ON CONFLICT paths rather than raising IntegrityError — a
    re-seeded row keeps its identity and reflects the latest write."""
    db = CatalogDB(postgres_dsn)
    db.replace_providers_and_models(
        [("openai-chat", True)],
        [ModelRow("openai-chat", "gpt-4o-mini", {}, False)],
    )
    # Full-state replace over the same PKs: DELETE + INSERT, no constraint
    # violation, and the last write wins.
    db.replace_providers_and_models(
        [("openai-chat", True)],
        [ModelRow("openai-chat", "gpt-4o-mini", {"max_tokens": 100}, True)],
    )
    rows = db.model_rows()
    assert len(rows) == 1
    assert rows[0].attrs == {"max_tokens": 100}
    assert rows[0].tier is True


def test_rebuild_skips_rows_with_credential_attrs(bare_app, caplog, monkeypatch):
    """_validate_attrs re-applies the credential-attribute rejection to rows
    written by other means (direct DB edits, downgrades): a row carrying a
    plaintext secret is skipped with a warning instead of being served as a
    shared platform fallback key through PlatformMixin."""
    monkeypatch.setattr(logging.getLogger("agno"), "propagate", True)
    db = bare_app.state.catalog.db
    db.replace_providers_and_models(
        [("openai-chat", True)],
        [
            ModelRow("openai-chat", "good", {}, False),
            ModelRow("openai-chat", "leaky", {"api_key": "sk-leaked"}, False),
        ],
    )
    with caplog.at_level(logging.WARNING, logger="agno"):
        bare_app.state.catalog.refresh()
    ids = [m.id for m in bare_app.state.catalog.registry.models]
    assert ids == ["good"]
    assert any("credential" in r.message for r in caplog.records)
    assert any("api_key" in r.message for r in caplog.records)


def test_rebuild_skips_enabled_tools_no_longer_available(bare_app, caplog, monkeypatch):
    monkeypatch.setattr(logging.getLogger("agno"), "propagate", True)
    db = bare_app.state.catalog.db
    db.replace_tools(["calculator", "ghost_tool"])
    with caplog.at_level(logging.WARNING, logger="agno"):
        bare_app.state.catalog.refresh()
    names = [t.name for t in bare_app.state.catalog.registry.tools]
    assert "calculator" in names
    assert all("ghost" not in n for n in names)
    assert any("tool 'ghost_tool'" in r.message for r in caplog.records)


def test_disabled_keyed_tool_is_not_in_fn_index(bare_app):
    bare_app.state.catalog.db.replace_tools(["tavily"])
    bare_app.state.catalog.refresh()
    assert "web_search_using_tavily" in bare_app.state.catalog.fn_index
    bare_app.state.catalog.db.replace_tools([])
    bare_app.state.catalog.ensure_current(bare_app.state.agent_os)
    assert "web_search_using_tavily" not in bare_app.state.catalog.fn_index


# ---------------------------------------------------------------------------
# Model entry grammar
# ---------------------------------------------------------------------------


def test_parse_model_entry_full_grammar():
    disc = discover()
    provider, model_id, attrs, tier = parse_model_entry(
        "openai-chat:gpt-4o-mini:tier:max_tokens=100:temperature=0.5", disc
    )
    assert (provider, model_id, tier) == ("openai-chat", "gpt-4o-mini", True)
    assert attrs == {"max_tokens": 100, "temperature": 0.5}


def test_parse_model_entry_colon_in_model_id():
    """Model ids may contain colons: OpenRouter ``:free`` variants, ollama
    ``llama3:8b``. The provider prefix is split off once; trailing tier/attr
    tokens are read right-to-left, and whatever remains joined by ":" is the
    id — matching the frontend's modelEntryText round-trip exactly."""
    disc = discover()
    provider, model_id, attrs, tier = parse_model_entry(
        "openrouter:meta-llama/llama-3.1-8b-instruct:free", disc
    )
    assert (provider, model_id, attrs, tier) == (
        "openrouter",
        "meta-llama/llama-3.1-8b-instruct:free",
        {},
        False,
    )
    # Colon id + tier + attrs, in either trailing order.
    provider, model_id, attrs, tier = parse_model_entry(
        "openrouter:meta-llama/llama-3.1-8b-instruct:free:tier:max_tokens=100", disc
    )
    assert (provider, model_id, tier) == ("openrouter", "meta-llama/llama-3.1-8b-instruct:free", True)
    assert attrs == {"max_tokens": 100}
    provider, model_id, attrs, tier = parse_model_entry(
        "openrouter:meta-llama/llama-3.1-8b-instruct:free:max_tokens=100:tier", disc
    )
    assert (provider, model_id, tier) == ("openrouter", "meta-llama/llama-3.1-8b-instruct:free", True)
    assert attrs == {"max_tokens": 100}
    # Bare colon id inside a provider's own block (the admin textarea form).
    provider, model_id, attrs, tier = parse_model_entry("llama3:8b", disc, default_provider="openai-chat")
    assert (provider, model_id, attrs, tier) == ("openai-chat", "llama3:8b", {}, False)
    # Bare colon id + attrs inside a block.
    provider, model_id, attrs, tier = parse_model_entry(
        "llama3:8b:max_tokens=100", disc, default_provider="openai-chat"
    )
    assert (provider, model_id, attrs, tier) == ("openai-chat", "llama3:8b", {"max_tokens": 100}, False)


def test_parse_model_entry_colon_id_round_trips_through_put(bare_client, bare_app):
    """The admin API accepts a colon-containing id and the GET payload keeps
    it intact — what the client sent is what the client rebuilds."""
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {
                    "slug": "openrouter",
                    "enabled": True,
                    "models": ["openrouter:meta-llama/llama-3.1-8b-instruct:free:tier"],
                }
            ]
        },
    )
    assert res.status_code == 200, res.text
    rows = bare_app.state.catalog.db.model_rows()
    assert [(r.id, r.tier) for r in rows] == [("meta-llama/llama-3.1-8b-instruct:free", True)]


def test_parse_model_entry_rejects_attr_before_suffix():
    """Ids never carry ``=``. An attribute typed BEFORE a non-attribute
    suffix — the natural ``...:max_tokens=100:free`` OpenRouter typo — must
    not glue the ``k=v`` token into the model id: the right-to-left scan
    pops nothing after ``free``, so the bogus id would construct-check
    fine, get persisted, and silently mutate on the client's next round-trip
    (its rebuild drops the ``k=v`` token, flipping the row into a
    different id + attr)."""
    disc = discover()
    with pytest.raises(ValueError) as exc:
        parse_model_entry(
            "openrouter:meta-llama/llama-3.1-8b-instruct:max_tokens=100:free", disc
        )
    assert "contains an attribute token" in str(exc.value)
    assert "max_tokens=100" in str(exc.value)
    # Colon-bearing ids that LOOK similar but carry no '=' still parse.
    provider, model_id, attrs, tier = parse_model_entry(
        "openai-chat:ft:gpt-4o-mini:org:suffix:ab12", disc
    )
    assert (provider, model_id, attrs, tier) == (
        "openai-chat",
        "ft:gpt-4o-mini:org:suffix:ab12",
        {},
        False,
    )


def test_parse_model_entry_rejects_colon_in_value():
    """Attribute values cannot contain ':' (the entry delimiter): a URL
    value is tokenized at every colon and the tail is misread as part of
    the id. When the fragment reconstructs into a type-valid value for a
    declared attribute, the error names the key and states the rule — the
    value is never silently truncated. A misplaced attribute whose
    reconstruction does NOT type-check keeps the generic message."""
    disc = discover()
    with pytest.raises(ValueError) as exc:
        parse_model_entry("openai-chat:gpt-4o-mini:base_url=http://localhost:11434", disc)
    assert "base_url" in str(exc.value)
    assert "cannot contain" in str(exc.value)
    assert "':'" in str(exc.value)
    # The pinned misplacement typo (reconstructed value fails the int field)
    # keeps the generic misplaced-attribute message.
    with pytest.raises(ValueError) as exc:
        parse_model_entry("openrouter:m:model:max_tokens=100:free", disc)
    assert "contains an attribute token" in str(exc.value)


def test_parse_model_entry_accepts_union_typed_string_attrs():
    """Union-typed attributes (e.g. base_url: Union[str, httpx.URL, None])
    accept plain strings — the first union member that coerces wins. The
    old _coerce fell through to json.loads for ANY multi-member union and
    rejected every string value with an opaque 'expects Union', which made
    such attributes un-settable through the grammar outright."""
    disc = discover()
    provider, model_id, attrs, tier = parse_model_entry("openai-chat:gpt-4o-mini:base_url=local", disc)
    assert (provider, model_id, attrs, tier) == ("openai-chat", "gpt-4o-mini", {"base_url": "local"}, False)


def test_coerce_rejects_nonfinite_floats():
    """float() accepts 'nan'/'inf', but a non-finite attribute value is a
    typo (or a hand-edited row), never a sane catalog entry — rejected with
    the same error style as any other type mismatch."""
    from dataclasses import dataclass

    from catalog_state import _coerce

    @dataclass
    class _Holder:
        ratio: float

    field = _Holder.__dataclass_fields__["ratio"]
    assert _coerce("ratio", "1.5", field) == 1.5
    assert _coerce("ratio", "-0.25", field) == -0.25
    for bad in ("nan", "inf", "-inf", "1e999"):
        with pytest.raises(ValueError, match="'ratio' expects float"):
            _coerce("ratio", bad, field)


def test_put_models_rejects_colon_in_value(bare_client, bare_app):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {
                    "slug": "openai-chat",
                    "enabled": True,
                    "models": ["openai-chat:gpt-4o-mini:base_url=http://localhost:11434"],
                }
            ]
        },
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "base_url" in detail
    assert "cannot contain" in detail
    # Nothing was persisted — no truncated value in the catalog.
    assert bare_app.state.catalog.db.model_rows() == []


def test_put_models_rejects_attr_before_suffix(bare_client, bare_app):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {
                    "slug": "openrouter",
                    "enabled": True,
                    "models": ["openrouter:meta-llama/llama-3.1-8b-instruct:max_tokens=100:free"],
                }
            ]
        },
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "contains an attribute token" in detail
    # Nothing was persisted — no bogus id in the catalog.
    assert bare_app.state.catalog.db.model_rows() == []


def test_parse_model_entry_rejects_mid_id_tier_token():
    """A `tier` token followed by a non-modifier suffix is mid-id: the
    right-to-left scan pops nothing after it, so the old parse silently
    glued `tier` into the id (`openai:model:tier:free` → id
    `model:tier:free`, tier flag dropped without error). Rejected with a
    clear message, like the misplaced-attribute guard."""
    disc = discover()
    with pytest.raises(ValueError) as exc:
        parse_model_entry("openai-chat:model:tier:free", disc)
    assert "'tier'" in str(exc.value)
    assert "comes after the id" in str(exc.value)
    # The legit trailing orders still parse (tier flag before or after attrs).
    for entry, want_tier in (
        ("openai-chat:gpt-4o-mini:tier", True),
        ("openai-chat:gpt-4o-mini:max_tokens=100", False),
        ("openai-chat:gpt-4o-mini:tier:max_tokens=100", True),
        ("openai-chat:gpt-4o-mini:max_tokens=100:tier", True),
    ):
        provider, model_id, attrs, tier = parse_model_entry(entry, disc)
        assert (provider, model_id, tier) == ("openai-chat", "gpt-4o-mini", want_tier)
    # Colon-bearing ids without a literal `tier` token still parse.
    provider, model_id, _, _ = parse_model_entry(
        "openrouter:meta-llama/llama-3.1-8b-instruct:free", disc
    )
    assert model_id == "meta-llama/llama-3.1-8b-instruct:free"
    provider, model_id, _, _ = parse_model_entry("openai-chat:ft:gpt-4o-mini:org:suffix:ab12", disc)
    assert model_id == "ft:gpt-4o-mini:org:suffix:ab12"


def test_parse_model_entry_rejects_empty_segments():
    """Empty tokens used to be silently filtered (`openai::gpt-4o` parsed
    as `openai:gpt-4o`) — the admin's typo changed nothing and disappeared.
    Rejected with a clear message, consistent with the other grammar
    guards. The frontend's modelEntryText rebuilds entries from parsed rows
    (non-empty id + attrs), so it can never emit an empty segment."""
    disc = discover()
    for raw in ("openai-chat::gpt-4o", "openai-chat:gpt-4o:", ":openai-chat:gpt-4o", "  "):
        with pytest.raises(ValueError) as exc:
            parse_model_entry(raw, disc)
        assert "empty segment" in str(exc.value)
    # Block context rejects it too — and a whitespace-only line no longer
    # 500s (the old filter produced an empty token list and indexed into it).
    with pytest.raises(ValueError) as exc:
        parse_model_entry("gpt-4o::mini", disc, default_provider="openai-chat")
    assert "empty segment" in str(exc.value)


def test_put_models_rejects_empty_segments_and_mid_id_tier(bare_client, bare_app):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai::gpt-4o-mini"]}]},
    )
    assert res.status_code == 400
    assert "empty segment" in res.json()["detail"]
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai:model:tier:free"]}]},
    )
    assert res.status_code == 400
    assert "tier" in res.json()["detail"]
    # Nothing was persisted by either rejection.
    assert bare_app.state.catalog.db.model_rows() == []


def test_parse_model_entry_rejects_credential_attrs():
    """`api_key` (and any credential-shaped attribute) never reaches the
    catalog: it would persist a plaintext secret into the shared db and bake
    it into the registry as a platform fallback key."""
    disc = discover()
    for key in ("api_key", "zoom_jwt_token", "client_secret"):
        with pytest.raises(ValueError) as exc:
            parse_model_entry(f"openai-chat:gpt-4o-mini:{key}=leaked", disc)
        assert "credential" in str(exc.value)
        assert key in str(exc.value)


def test_put_models_rejects_credential_attribute(bare_client, bare_app):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini:api_key=sk-leaked"]}
            ]
        },
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "credential" in detail and "api_key" in detail
    # Nothing was persisted — no plaintext secret in the catalog.
    assert bare_app.state.catalog.db.model_rows() == []


def test_put_models_rejects_duplicate_model_id(bare_client):
    """Model ids must be unique WITHIN a provider: the composite PK
    (provider_slug, id) would reject a repeat, but the 400 here names the
    duplicate instead of surfacing an IntegrityError."""
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {
                    "slug": "openai-chat",
                    "enabled": True,
                    "models": ["openai-chat:gpt-4o-mini", "gpt-4o-mini"],  # same id, two spellings
                }
            ]
        },
    )
    assert res.status_code == 400
    assert "gpt-4o-mini" in res.json()["detail"]
    assert "twice" in res.json()["detail"]


def test_put_models_allows_same_id_across_doors(bare_client, bare_app):
    """The same model id under two DIFFERENT providers is the doors feature:
    one vendor's API doors (openai chat + openai-responses) both serve
    "gpt-5.6-luna". The registry binds configs by (id, effective name), and
    one provider = one class, so (id, name) stays globally unique — the old
    resolve-by-id-alone shadowing hazard is gone. The builder-facing payload
    must list BOTH rows, each with its own slug, binding name, and the
    vendor's shared dep key."""
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini"]},
                {"slug": "openai-responses", "enabled": True, "models": ["gpt-4o-mini"]},
            ]
        },
    )
    assert res.status_code == 200, res.text
    rows = {(r.provider_slug, r.id) for r in bare_app.state.catalog.db.model_rows()}
    assert ("openai-chat", "gpt-4o-mini") in rows
    assert ("openai-responses", "gpt-4o-mini") in rows
    # Builder-facing payload: both doors, each carrying its binding name and
    # the vendor's single dep key.
    payload = platform_models_payload(bare_app.state.catalog, {})
    by_pair = {(m["provider"], m["id"]): m for m in payload["models"]}
    chat = by_pair[("openai-chat", "gpt-4o-mini")]
    responses = by_pair[("openai-responses", "gpt-4o-mini")]
    assert chat["name"] == "OpenAIChat"
    assert responses["name"] == "OpenAIResponses"
    assert chat["dep_key"] == responses["dep_key"] == "openai_api_key"


def test_registry_builds_one_wrapper_per_door_not_per_module(bare_client, bare_app):
    """REGRESSION: the wrapper cache keyed on (module, dep_key, env) —
    identical for every door of one vendor — handed the responses row the
    CHAT wrapper. The registry then held two same-named chat instances for
    one id: a chat run bound the mis-wrapped instance and lost the row's
    attrs (the reasoning_effort fix silently gone), and a responses run
    matched nothing and fell back to a from-dict rebuild on the platform
    env key — a silent BYOK bypass. The cache keys on the provider CLASS
    now: one door, one wrapper, and (id, name) binds each door to ITS
    instance."""
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {
                    "slug": "openai-chat",
                    "enabled": True,
                    "models": ["openai-chat:gpt-4o-mini:reasoning_effort=none"],
                },
                {"slug": "openai-responses", "enabled": True, "models": ["gpt-4o-mini"]},
            ]
        },
    )
    assert res.status_code == 200, res.text
    reg = bare_app.state.catalog.registry
    by_name: Dict[str, list] = {}
    for m in reg.models:
        by_name.setdefault(m.name, []).append(m)
    chat_instances = by_name["OpenAIChat"]
    responses_instances = by_name["OpenAIResponses"]
    assert len(chat_instances) == 1
    assert len(responses_instances) == 1
    # Each door got ITS OWN class, and the chat row's attrs ride the chat
    # class only.
    assert type(chat_instances[0]).__name__ == "PlatformOpenAIChat"
    assert chat_instances[0].reasoning_effort == "none"
    assert type(responses_instances[0]).__name__ == "PlatformOpenAIResponses"
    # The (id, name) binding resolves each door to exactly its instance —
    # the contract the component config relies on.
    assert reg.get_model("gpt-4o-mini", provider=None, name="OpenAIChat") is chat_instances[0]
    assert (
        reg.get_model("gpt-4o-mini", provider=None, name="OpenAIResponses")
        is responses_instances[0]
    )
    # The wrapper cache is actually REUSED across rebuilds — the same
    # wrapper TYPES come back (identity, not equality), so repeated admin
    # saves don't accumulate fresh classes. A cache silently defeated
    # (e.g. by a future key change) would still pass every behavioral
    # assertion above; only identity catches it.
    reg2, reg2_index = bare_app.state.catalog._build_registry(
        bare_app.state.catalog.db.snapshot()
    )
    assert {type(m) for m in reg2.models} == {type(m) for m in reg.models}
    # The index rides the same build — derived from the SAME accepted rows.
    assert set(reg2_index) == {(row.provider_slug, row.id) for row in
                               bare_app.state.catalog.db.model_rows()}


def test_put_rejects_a_cross_provider_binding_collision(bare_client, bare_app):
    """The registry binds configs by (id, effective name) — that pair must
    stay globally unique. The per-provider id rule allows the same id under
    two providers (the doors feature), but if BOTH rows would bind under
    the same name (a hand-set name= attribute, or two same-named classes
    across modules), get_model could not tell them apart and one would
    silently win. The save rejects with the collision named."""
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {
                    "slug": "openai-chat",
                    "enabled": True,
                    "models": ["openai-chat:gpt-4o-mini:name=Door"],
                },
                {
                    "slug": "openai-responses",
                    "enabled": True,
                    "models": ["openai-responses:gpt-4o-mini:name=Door"],
                },
            ]
        },
    )
    assert res.status_code == 400, res.text
    detail = res.json()["detail"]
    assert "binding name 'Door'" in detail
    assert "openai-chat" in detail and "openai-responses" in detail
    # Nothing was persisted — the save is all-or-nothing.
    assert bare_app.state.catalog.db.model_rows() == []
    # The doors case proper stays legal: same id, DISTINCT binding names.
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={
            "providers": [
                {
                    "slug": "openai-chat",
                    "enabled": True,
                    "models": ["openai-chat:gpt-4o-mini:name=Door"],
                },
                {"slug": "openai-responses", "enabled": True, "models": ["gpt-4o-mini"]},
            ]
        },
    )
    assert res.status_code == 200, res.text


def test_picker_and_registry_share_one_accepted_rows_loop(bare_client, bare_app):
    """A row the registry refuses (fails attr validation / does not
    construct) must ALSO be absent from the builder-facing picker. The old
    _rebuild_indexes recomputed the model index from the raw snapshot
    WITHOUT the construct checks: the picker offered the dead row, agents
    got saved against it, and the run fell into agno's from-dict rebuild —
    the platform env-key path the dispatcher now refuses."""
    admin = admin_headers(sub="frontend-service")
    db = bare_app.state.catalog.db
    # Written directly (as a hand edit or older schema would leave behind):
    # an attribute the provider class does not have.
    db.replace_providers_and_models(
        [("openai-chat", True)],
        [ModelRow("openai-chat", "gpt-4o-mini", {"bogus_attr": 1}, False)],
    )
    bare_app.state.catalog.ensure_current(bare_app.state.agent_os)
    # Registry: refused.
    assert bare_app.state.agent_os.registry.models == []
    # Picker: refused by the SAME loop — one source of truth.
    res = bare_client.get("/platform/models", headers=admin)
    assert res.status_code == 200
    assert res.json()["models"] == []


def test_admin_get_renders_a_dead_model_provider_unavailable(bare_client, bare_app):
    """An ENABLED durable row whose slug this deployment can no longer
    produce (an agno file reorganization renamed the slug) renders on the
    admin page as unavailable — visible so the admin can clear and
    re-enable it under the new slug, never silently served."""
    db = bare_app.state.catalog.db
    db.replace_providers_and_models(
        [("ghost", True)],
        [ModelRow("ghost", "phantom-model", {"max_tokens": 8}, False)],
    )
    res = bare_client.get("/platform/catalog/models", headers=admin_headers(sub="frontend-service"))
    assert res.status_code == 200
    ghost = next(p for p in res.json()["providers"] if p["slug"] == "ghost")
    assert ghost["available"] is False
    assert ghost["enabled"] is False  # cannot stay enabled — nothing to enable
    assert ghost["class_name"] is None
    assert ghost["dep_key"] is None
    assert ghost["models"] == [{"id": "phantom-model", "attrs": {"max_tokens": 8}, "tier": False}]


def test_platform_available_declares_dep_keys(bare_client, bare_app):
    """/platform/available is the enable-able universe — each entry must
    declare its dep key (clients deliver/consume the DECLARED key, never a
    slug derivation) and its platform env var."""
    res = bare_client.get("/platform/available", headers=admin_headers(sub="frontend-service"))
    assert res.status_code == 200
    models = {m["slug"]: m for m in res.json()["models"]}
    # Both openai doors: distinct slugs and classes, ONE shared dep key.
    assert models["openai-chat"]["class_name"] == "OpenAIChat"
    assert models["openai-responses"]["class_name"] == "OpenAIResponses"
    assert models["openai-chat"]["dep_key"] == "openai_api_key"
    assert models["openai-responses"]["dep_key"] == "openai_api_key"
    assert models["openai-chat"]["platform_env_key"] == "OPENAI_API_KEY"
    # Every entry carries the fields — the shape is total, not per-provider.
    assert all(
        {"slug", "class_name", "requires_key", "platform_env_key", "dep_key"} <= set(m)
        for m in models.values()
    )


def test_discovery_slug_collision_skips_loudly(monkeypatch):
    """Two Model classes defined in the SAME file derive the SAME slug —
    the second is skipped with a logged line, never silently served under
    the other's identity. The real agno layout never triggers this branch
    (no current provider file defines two classes), which is exactly why
    it is pinned here: the pin is the only guard."""
    import importlib as _importlib
    import pkgutil as _pkgutil
    import types

    import agno.models as agno_models
    from agno.models.base import Model as AgnoModel

    @dataclasses.dataclass
    class FirstThing(AgnoModel):
        pass

    @dataclasses.dataclass
    class SecondThing(AgnoModel):
        pass

    # Both classes "defined" in dupevendor/thing.py — same file, same slug.
    FirstThing.__module__ = "agno.models.dupevendor.thing"
    SecondThing.__module__ = "agno.models.dupevendor.thing"
    # Model is abstract; the fakes only need to CONSTRUCT (the discovery
    # probe) and carry a dataclass-fields view — clear the abstract set so
    # instantiation succeeds without implementing the provider API.
    FirstThing.__abstractmethods__ = frozenset()
    SecondThing.__abstractmethods__ = frozenset()
    fake_module = types.ModuleType("agno.models.dupevendor")
    fake_module.FirstThing = FirstThing
    fake_module.SecondThing = SecondThing

    monkeypatch.setattr(
        _pkgutil,
        "iter_modules",
        lambda path: iter([types.SimpleNamespace(name="dupevendor", ispkg=True)]),
    )
    real_import = _importlib.import_module

    def fake_import(name, *args, **kwargs):
        if name == "agno.models.dupevendor":
            return fake_module
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(_importlib, "import_module", fake_import)

    models_out, skipped = discover_models()
    # FirstThing survives (alphabetical order breaks the tie); SecondThing
    # is skipped WITH a line naming both.
    assert set(models_out) == {"dupevendor-thing"}
    assert models_out["dupevendor-thing"].class_name == "FirstThing"
    assert len(skipped) == 1
    assert "SecondThing" in skipped[0]
    assert "already taken" in skipped[0]


def test_parse_model_entry_rejects_unknown_provider_and_attr():
    disc = discover()
    with pytest.raises(ValueError):
        parse_model_entry("nope:model", disc)
    with pytest.raises(ValueError):
        parse_model_entry("openai-chat:gpt-4o-mini:not_a_field=1", disc)
    with pytest.raises(ValueError):
        # A bare provider token with no model id — even a VALID slug.
        parse_model_entry("openai-chat", disc)


def test_tier_flag_requires_platform_env_key_at_serve_time(bare_client, bare_app, monkeypatch):
    admin = admin_headers(sub="frontend-service")
    res = bare_client.put(
        "/platform/catalog/models",
        headers=admin,
        json={"providers": [{"slug": "openai-chat", "enabled": True, "models": ["openai-chat:gpt-4o-mini:tier"]}]},
    )
    assert res.status_code == 200
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    body = bare_client.get("/platform/models", headers=admin).json()
    assert body["models"][0]["platform_tier"] is False
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    body = bare_client.get("/platform/models", headers=admin).json()
    assert body["models"][0]["platform_tier"] is True


# ---------------------------------------------------------------------------
# Model test endpoint
# ---------------------------------------------------------------------------


def test_model_test_requires_platform_key(bare_client, bare_app, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    res = bare_client.post(
        "/platform/test/model",
        headers=admin_headers(sub="frontend-service"),
        json={"entry": "openai-chat:gpt-4o-mini"},
    )
    assert res.status_code == 400
    assert "no platform key" in res.json()["detail"]


def test_model_test_rejects_invalid_entries(bare_client, bare_app):
    res = bare_client.post(
        "/platform/test/model",
        headers=admin_headers(sub="frontend-service"),
        json={"entry": "ghost-provider:some-model"},
    )
    assert res.status_code == 400


def test_model_test_happy_path(bare_client, monkeypatch):
    """The green path: the platform key is set and the model answers the one
    'hi' completion. The wrapper construction is stubbed — no network."""
    from types import SimpleNamespace

    captured = {}

    class FakeModel:
        def __init__(self, id, **attrs):
            self.id = id

        def response(self, messages):
            assert [m.role for m in messages] == ["user"]
            return SimpleNamespace(content=f"echo:{self.id}")

    def fake_wrapper_for(entry):
        def make(id, **attrs):
            captured["id"] = id
            captured["attrs"] = attrs
            return FakeModel(id, **attrs)

        return make

    monkeypatch.setattr("catalog_state._wrapper_for", fake_wrapper_for)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    res = bare_client.post(
        "/platform/test/model",
        headers=admin_headers(sub="frontend-service"),
        json={"entry": "openai-chat:gpt-4o-mini"},
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"ok": True, "reply": "echo:gpt-4o-mini"}
    assert captured["id"] == "gpt-4o-mini"


def test_model_test_caps_timeout_and_max_tokens(bare_client, monkeypatch):
    """The probe is one 'hi' completion: the timeout cap must not depend on
    attrs the admin happened to type, and a small max_tokens budget goes
    with it. The client's proxy times out at 10s — the OpenAI SDK's ~10-min
    default timeout (or an unbounded completion) would strand the request
    server-side. Explicitly typed attributes keep their values."""
    from types import SimpleNamespace

    captured = {}

    class FakeModel:
        def __init__(self, id, **attrs):
            self.id = id
            captured["attrs"] = attrs

        def response(self, messages):
            assert [m.role for m in messages] == ["user"]
            return SimpleNamespace(content="hi")

    def fake_wrapper_for(entry):
        def make(id, **attrs):
            return FakeModel(id, **attrs)

        return make

    monkeypatch.setattr("catalog_state._wrapper_for", fake_wrapper_for)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    res = bare_client.post(
        "/platform/test/model",
        headers=admin_headers(sub="frontend-service"),
        json={"entry": "openai-chat:gpt-4o-mini:max_tokens=100"},
    )
    assert res.status_code == 200, res.text
    assert captured["attrs"]["timeout"] == 30
    # The admin's explicit max_tokens wins over the probe's budget.
    assert captured["attrs"]["max_tokens"] == 100


# ---------------------------------------------------------------------------
# Seed helper sanity (used by the main suite)
# ---------------------------------------------------------------------------


def test_seed_catalog_helper(app):
    state = app.state.catalog
    assert [m.id for m in state.registry.models] == ["gpt-4o-mini", "z-ai/glm-5.3-flash"]
    assert "web_search" in state.fn_index and "add" in state.fn_index
    assert "tavily" not in [slug for slug, en in state.db.enabled_tools().items() if en]

"""The dispatcher's per-run knowledge attach (#234): strip pre-rehydrate, attach post-rehydrate.

Two test layers:

- **Unit shape (the fake factory seam):** most tests stand in a fake
  ``knowledge.build_knowledge_for`` — the ONE entry point both halves share —
  and pin the dispatcher's decisions without any vector store: per-run key
  resolution (runner wins, deps-only), the pre-``from_dict`` strip (observable
  through an ``Agent.from_dict`` spy), the strip+warn degradation postures, and
  the stored-name threading on drift.
- **Real retrieval (integration):** one test builds the REAL Knowledge
  instance (FakeEmbedder swapped in at the ``knowledge._provider_embedder``
  provider seam — the same seam the #233 tests use) against the pgvector
  testcontainer, proving the attach lands on the same corpus the uploads were
  stamped into.

No OpenAI calls anywhere: the embedder is always the offline fake. The
platform ``OPENAI_API_KEY`` is deliberately SET for the whole module
(``pin_platform_env_key``) so every missing-key test simultaneously proves the
resolution is deps-only — the env fallback must never fire for the embedder.
"""
import asyncio
import logging
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import pytest
from agno.agent import Agent
from agno.knowledge.content import Content, ContentStatus, FileData
from agno.knowledge.knowledge import Knowledge
from agno.models.openai import OpenAIChat
from agno.os.routers.knowledge.knowledge import process_content
from agno.utils.string import generate_id
from sqlalchemy.exc import OperationalError

import knowledge as knowledge_store
from knowledge_test_helpers import FakeEmbedder, build_fake_knowledge
from models import platform_model_class
from platform_test_helpers import admin_headers, agui_body, component_payload, user_headers

# The platform env key, asserted NEVER to reach the embedder (BYOK-only: the
# env key is the platform's; conftest sets a placeholder for the model
# wrappers and this module pins its own to make the no-fallback proof explicit).
PLATFORM_OPENAI_KEY = "sk-platform-key-must-never-embed"

BANANA_DOC = "The banana harvest ripens in the orchard every summer."


class FakeKnowledgeFactory:
    """Stands in for ``knowledge.build_knowledge_for`` at the dispatcher's seam.

    Records every call's arguments and hands back a DISTINCT sentinel object
    per call, so attach tests can pin which component id / per-run key /
    corpus name / DSN each construction received — and that a second run
    built a second instance (no shared embedder) — with no network and no
    vector store.
    """

    def __init__(self) -> None:
        """Start with an empty call record."""
        self.calls: List[Dict[str, Any]] = []

    def __call__(
        self,
        component_id: str,
        db,
        api_key: Optional[str] = None,
        *,
        db_url: Optional[str] = None,
        name: Optional[str] = None,
    ):
        """The factory signature mirror — returns a fresh sentinel per call.

        Args:
            component_id: The component whose corpus the dispatcher resolved.
            db: The contents db handed over (expected: the AgentOS's agno db).
            api_key: The per-run embedding key the dispatcher resolved.
            db_url: The vector-store DSN threaded from the run route.
            name: The corpus name the dispatcher decided on (the stored name).

        Returns:
            A distinct sentinel per call (``is not``-comparable across runs).
        """
        sentinel = SimpleNamespace(name=name, api_key=api_key)
        self.calls.append(
            {
                "component_id": component_id,
                "db": db,
                "api_key": api_key,
                "db_url": db_url,
                "name": name,
                "knowledge": sentinel,
            }
        )
        return sentinel

    def install(self, monkeypatch) -> "FakeKnowledgeFactory":
        """Patch the module attribute the dispatcher resolves at call time.

        Args:
            monkeypatch: pytest's monkeypatch (auto-restored).

        Returns:
            ``self`` — the recording factory now installed at the seam.
        """
        monkeypatch.setattr(knowledge_store, "build_knowledge_for", self)
        return self


@pytest.fixture(autouse=True)
def pin_platform_env_key(monkeypatch):
    """Pin the platform's ``OPENAI_API_KEY`` for every test in this module.

    Args:
        monkeypatch: pytest's monkeypatch (restores the env after each test).
    """
    monkeypatch.setenv("OPENAI_API_KEY", PLATFORM_OPENAI_KEY)


@pytest.fixture
def from_dict_spy(monkeypatch) -> List[Dict[str, Any]]:
    """Capture the config dict every ``Agent.from_dict`` receives.

    The strip is observable exactly here: after ``plan_per_run_knowledge``,
    the dict reaching agno's rehydration must carry NO ``knowledge`` key —
    otherwise agno's registry lookup would run and, this service registering
    no knowledge instances, fail open by skipping.

    Args:
        monkeypatch: pytest's monkeypatch (restores ``from_dict`` after the test).

    Returns:
        The list of ``data`` dicts, appended in call order.
    """
    captured: List[Dict[str, Any]] = []
    original = Agent.from_dict.__func__

    def spy(cls, data, **kwargs):
        """Delegate to the real rehydration, recording the config first.

        Args:
            cls: The Agent class (classmethod binding).
            data: The config dict about to be rehydrated.
            **kwargs: The remaining ``from_dict`` arguments.

        Returns:
            The real ``Agent.from_dict`` result.
        """
        captured.append(data)
        return original(cls, data, **kwargs)

    monkeypatch.setattr(Agent, "from_dict", classmethod(spy))
    return captured


@pytest.fixture
def offline_embedder(monkeypatch):
    """Swap the provider-dispatch seam for the deterministic fake embedder.

    The #233 seam, reused verbatim: ``build_knowledge_for`` runs its REAL
    construction (env parse, shared table, isolation flag) with the embedder
    swapped — no network, real pgvector container.

    Args:
        monkeypatch: pytest's monkeypatch (restores the seam after the test).
    """
    monkeypatch.setattr(
        knowledge_store,
        "_provider_embedder",
        lambda provider, model, api_key: FakeEmbedder(),
    )


# -- wiring helpers -----------------------------------------------------------


def _create_component(client, component_id: str, knowledge: Optional[dict]) -> str:
    """Create a published component, optionally declaring a knowledge ref.

    Args:
        client: The TestClient (the ``client`` fixture).
        component_id: The component's handle (the run route's path id).
        knowledge: The ``knowledge`` config entry (``{"name": ...}``), or
            ``None`` for a knowledge-less component.

    Returns:
        The stored component's id.
    """
    payload = component_payload(component_id=component_id, knowledge=knowledge)
    res = client.post("/components", headers=admin_headers(sub="frontend-service"), json=payload)
    assert res.status_code in (200, 201), res.text
    return res.json()["component_id"]


def _fake_knowledge_entry(component_id: str) -> dict:
    """The config's knowledge reference exactly as tackui writes it.

    Args:
        component_id: The component's handle.

    Returns:
        ``{"name": "kb-<component_id>"}``.
    """
    return {"name": f"kb-{component_id}"}


def _build_for_run(app, component_id: str, deps: Optional[Dict[str, Any]], db_url: Optional[str] = None):
    """Call ``build_agent_for_run`` the way the run route does.

    Args:
        app: The platform app fixture.
        component_id: The component's handle.
        deps: The run's dependency dict (or ``None`` — anonymous callers).
        db_url: The vector-store DSN to thread (defaults to the app's own —
            the route's shape; unit tests pass a distinctive one to observe it).

    Returns:
        The ``build_agent_for_run`` result tuple.
    """
    from dispatcher import build_agent_for_run

    return build_agent_for_run(
        app.state.agent_os,
        component_id,
        catalog=app.state.catalog,
        deps=deps,
        db_url=db_url if db_url is not None else app.state.db_url,
    )


AbortOpenAIChat = platform_model_class(OpenAIChat, "openai_api_key", "OPENAI_API_KEY")


class AbortModel(AbortOpenAIChat):
    """A model stub that aborts at the provider call — proving the run reached
    ``arun`` (so the attach happened before it) with no network."""

    def get_async_client(self):
        """Return a stub client whose ``create()`` raises — the abort.

        Returns:
            The stub client (``chat.completions.create`` raises RuntimeError).
        """
        stub = MagicMock()
        stub.chat.completions.create.side_effect = RuntimeError("recorded — abort run")
        return stub


@pytest.fixture
def abort_registry(app):
    """Swap the registry's OpenAI model for an AbortModel (same id).

    Args:
        app: The platform app fixture.

    Yields:
        The registry (the original model restored after the test).
    """
    registry = app.state.agent_os.registry
    abort = AbortModel(id="gpt-4o-mini")
    original = registry.models[0]
    registry.models[0] = abort
    yield registry
    registry.models[0] = original


# -- unit shape: the attach decisions through build_agent_for_run -------------


def test_attach_with_runner_key_and_strip_before_rehydration(app, client, from_dict_spy, monkeypatch):
    """Config WITH a knowledge ref + the runner's key in deps: the agent carries
    the built Knowledge instance, the factory received the RUNNER's key (not the
    platform env key), the corpus name and contents db match, and the config
    handed to ``Agent.from_dict`` carries no ``knowledge`` key — the strip is
    observable, so agno's registry fail-open path is unreachable."""
    component_id = _create_component(client, "kb-attach-agent", _fake_knowledge_entry("kb-attach-agent"))
    factory = FakeKnowledgeFactory().install(monkeypatch)

    agent, stored_config, _fresh_fns = _build_for_run(
        app, component_id, deps={"openai_api_key": "sk-runner"}, db_url="postgresql://vector-store.example/vectors"
    )

    assert len(factory.calls) == 1
    call = factory.calls[0]
    assert call["component_id"] == component_id
    assert call["api_key"] == "sk-runner"
    assert call["api_key"] != PLATFORM_OPENAI_KEY, "the platform env key must never embed"
    assert call["name"] == f"kb-{component_id}"
    assert call["db"] is app.state.agent_os.db, "the corpus's contents db is the AgentOS's db"
    assert call["db_url"] == "postgresql://vector-store.example/vectors", "the route-threaded DSN"
    assert agent.knowledge is call["knowledge"], "the built instance is the one attached"
    # The strip, observable: agno's rehydration never saw the reference.
    assert "knowledge" not in from_dict_spy[-1]
    # The original stored config is untouched (the run route still reads it
    # for the connectors allowlist).
    assert stored_config["knowledge"] == _fake_knowledge_entry(component_id)


def test_missing_key_strips_warns_and_run_proceeds(app, client, from_dict_spy, monkeypatch, caplog):
    """Config WITH a knowledge ref, NO key in the run's deps (the platform env
    key deliberately SET — proving no env fallback): no Knowledge is built, the
    strip still happened, a warning names the component and the dep key, and the
    build returns normally — the run proceeds without retrieval."""
    component_id = _create_component(client, "kb-nokey-agent", _fake_knowledge_entry("kb-nokey-agent"))
    factory = FakeKnowledgeFactory().install(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="agno"):
        agent, _stored, _fns = _build_for_run(app, component_id, deps=None)

    assert factory.calls == [], "no embedder construction without a key"
    assert agent.knowledge is None
    assert "knowledge" not in from_dict_spy[-1], "stripped even when degraded"
    assert any(
        f"component '{component_id}'" in r.message and "openai_api_key" in r.message
        for r in caplog.records
    )


def test_empty_deps_dict_is_the_same_missing_key_posture(app, client, monkeypatch, caplog):
    """An EMPTY deps dict (context delivered, no key in it) degrades identically
    to no deps at all — the posture keys off the resolved value, not the
    container."""
    component_id = _create_component(client, "kb-emptydeps-agent", _fake_knowledge_entry("kb-emptydeps-agent"))
    factory = FakeKnowledgeFactory().install(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="agno"):
        agent, _stored, _fns = _build_for_run(app, component_id, deps={})

    assert factory.calls == []
    assert agent.knowledge is None
    assert any("openai_api_key" in r.message for r in caplog.records)


def test_vector_store_failure_degrades_to_run_without_retrieval(app, client, monkeypatch, caplog):
    """A vector store that fails to INITIALIZE (unreachable — OperationalError
    from the construction round-trip) degrades: strip + warn naming the
    component + the build returns normally. The liveness of this branch
    depends on agno swallowing inside ``table_exists`` but NOT inside
    ``create()`` — if an agno patch ever broadens that swallow, this test
    flags that the degrade path went dead."""
    component_id = _create_component(client, "kb-unreach-agent", _fake_knowledge_entry("kb-unreach-agent"))

    def unreachable(component_id, db, api_key=None, *, db_url=None, name=None):
        """The construction round-trip failing (vector store down)."""
        raise OperationalError(
            statement=None, params=None, orig=RuntimeError("connection refused")
        )

    monkeypatch.setattr(knowledge_store, "build_knowledge_for", unreachable)
    with caplog.at_level(logging.WARNING, logger="agno"):
        agent, _stored, _fns = _build_for_run(app, component_id, deps={"openai_api_key": "sk-runner"})

    assert agent.knowledge is None
    assert any(
        f"component '{component_id}'" in r.message and "unreachable" in r.message
        for r in caplog.records
    )


def test_any_construction_failure_degrades_the_same_way(app, client, monkeypatch, caplog):
    """A construction failure that is NOT an OperationalError (a reachable
    store whose first-use table creation fails — permission denied, a plain
    Postgres without pgvector, a cold-start DuplicateTable race) degrades
    IDENTICALLY: strip + warn (type name only) + run proceeds. The run must
    never 500 on retrieval-optional infrastructure."""
    component_id = _create_component(client, "kb-tblfail-agent", _fake_knowledge_entry("kb-tblfail-agent"))

    def table_create_fails(component_id, db, api_key=None, *, db_url=None, name=None):
        """A sibling DBAPI failure (e.g. DuplicateTable/ProgrammingError)."""
        raise RuntimeError("simulated CREATE TABLE race")

    monkeypatch.setattr(knowledge_store, "build_knowledge_for", table_create_fails)
    with caplog.at_level(logging.WARNING, logger="agno"):
        agent, _stored, _fns = _build_for_run(app, component_id, deps={"openai_api_key": "sk-runner"})

    assert agent.knowledge is None
    assert any(
        f"component '{component_id}'" in r.message and "failed to initialize" in r.message
        for r in caplog.records
    )


def test_non_dict_knowledge_value_is_stripped_and_warned(app, client, from_dict_spy, monkeypatch, caplog):
    """A corrupted knowledge value (a string instead of the {name} dict) never
    reaches Agent.knowledge raw — stripped + warned, run proceeds. agno's
    loader only understands the dict form; passing it through would surface
    as a run-time tool failure instead of the strip+warn posture."""
    component_id = _create_component(client, "kb-corrupt-agent", "not-a-dict")
    factory = FakeKnowledgeFactory().install(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="agno"):
        agent, _stored, _fns = _build_for_run(app, component_id, deps={"openai_api_key": "sk-runner"})

    assert factory.calls == [], "a non-dict reference cannot address a corpus"
    assert agent.knowledge is None
    assert "knowledge" not in from_dict_spy[-1], "stripped even when corrupted"
    assert any(
        f"component '{component_id}'" in r.message and "str" in r.message
        for r in caplog.records
    )


def test_no_knowledge_ref_is_a_passthrough(app, client, from_dict_spy, monkeypatch):
    """Config WITHOUT a knowledge ref: the factory is never called, the config
    passes through untouched (zero behavior change — the plan_per_run_tools
    passthrough path), and the rehydrated agent has no knowledge."""
    component_id = _create_component(client, "kb-plain-agent", None)
    factory = FakeKnowledgeFactory().install(monkeypatch)

    agent, stored_config, _fns = _build_for_run(app, component_id, deps={"openai_api_key": "sk-runner"})

    assert factory.calls == []
    assert agent.knowledge is None
    assert "knowledge" not in stored_config
    assert "knowledge" not in from_dict_spy[-1]


def test_stored_name_mismatch_warns_and_uses_stored_name(app, client, monkeypatch, caplog):
    """A stored knowledge name that does NOT match the ``kb-<component_id>``
    derivation is used VERBATIM (the corpus was uploaded and linked_to-stamped
    under it) — after a warning naming both names."""
    component_id = _create_component(client, "kb-drift-agent", {"name": "kb-legacy-corpus"})
    factory = FakeKnowledgeFactory().install(monkeypatch)

    with caplog.at_level(logging.WARNING, logger="agno"):
        agent, _stored, _fns = _build_for_run(app, component_id, deps={"openai_api_key": "sk-runner"})

    assert len(factory.calls) == 1
    assert factory.calls[0]["name"] == "kb-legacy-corpus", "the STORED name wins"
    assert factory.calls[0]["component_id"] == component_id
    assert agent.knowledge is factory.calls[0]["knowledge"]
    assert any(
        "kb-legacy-corpus" in r.message and f"kb-{component_id}" in r.message
        for r in caplog.records
    )


def test_malformed_embedder_env_strips_and_warns(app, client, monkeypatch, caplog):
    """A malformed KNOWLEDGE_EMBEDDER (parse fails at use time) degrades the
    same way as a missing key: strip + warn + run without retrieval — knowledge
    is optional infrastructure and must not fail runs."""
    component_id = _create_component(client, "kb-badenv-agent", _fake_knowledge_entry("kb-badenv-agent"))
    factory = FakeKnowledgeFactory().install(monkeypatch)
    monkeypatch.setenv(knowledge_store.EMBEDDER_ENV_VAR, "sk-pasted-secret-like-value")

    with caplog.at_level(logging.WARNING, logger="agno"):
        agent, _stored, _fns = _build_for_run(app, component_id, deps={"openai_api_key": "sk-runner"})

    assert factory.calls == []
    assert agent.knowledge is None
    assert any(
        f"component '{component_id}'" in r.message and "misconfigured" in r.message
        for r in caplog.records
    )


def test_two_runs_get_independent_knowledge_instances(app, client, monkeypatch):
    """The concurrency shape: two builds for two different dep dicts produce two
    DISTINCT Knowledge objects (pinned with ``is not``) — each factory call
    received its OWN run's key (per-run resolution; a shared instance would
    race embedder keys across concurrent runs)."""
    component_id = _create_component(client, "kb-conc-agent", _fake_knowledge_entry("kb-conc-agent"))
    factory = FakeKnowledgeFactory().install(monkeypatch)

    agent_one, _s1, _f1 = _build_for_run(app, component_id, deps={"openai_api_key": "sk-run-one"})
    agent_two, _s2, _f2 = _build_for_run(app, component_id, deps={"openai_api_key": "sk-run-two"})

    assert agent_one.knowledge is not agent_two.knowledge, "no shared instance between runs"
    assert agent_one.knowledge.api_key == "sk-run-one"
    assert agent_two.knowledge.api_key == "sk-run-two"


# -- wire level: the run route's wiring ---------------------------------------


def test_wire_run_resolves_the_runner_key_and_threads_the_dsn(client, app, abort_registry, monkeypatch):
    """Over ``POST /agui/{agent_id}``: the attach receives the key resolved from
    the run's AG-UI context and the SAME DSN the knowledge routes resolve
    (``app.state.db_url`` — the route threading this issue wires). The aborting
    model stub keeps the run network-free; the sentinel knowledge never reaches
    a search."""
    component_id = _create_component(client, "kb-wire-agent", _fake_knowledge_entry("kb-wire-agent"))
    factory = FakeKnowledgeFactory().install(monkeypatch)

    body = agui_body(thread_id="t-kb-wire", context=[{"description": "openai_api_key", "value": "sk-wire-runner"}])
    res = client.post(f"/agui/{component_id}", headers=user_headers(), json=body)
    assert res.status_code == 200, res.text

    assert len(factory.calls) == 1
    assert factory.calls[0]["api_key"] == "sk-wire-runner"
    assert factory.calls[0]["db_url"] == app.state.db_url
    assert factory.calls[0]["name"] == f"kb-{component_id}"


def test_wire_run_without_key_still_streams(client, app, abort_registry, caplog):
    """Wire-level missing-key posture: a knowledge-attached component run with
    NO context still streams (RUN_STARTED present — the run proceeds; the
    aborting model stub turns the stream into RUN_ERROR after, proving arun was
    reached) with the degradation warning logged."""
    component_id = _create_component(client, "kb-wire-nokey", _fake_knowledge_entry("kb-wire-nokey"))

    with caplog.at_level(logging.WARNING, logger="agno"):
        res = client.post(f"/agui/{component_id}", headers=user_headers(), json=agui_body(thread_id="t-kb-nokey"))
    assert res.status_code == 200, res.text
    assert "RUN_STARTED" in res.text
    assert any(
        f"component '{component_id}'" in r.message and "openai_api_key" in r.message
        for r in caplog.records
    )


# -- real retrieval: the attach lands on the uploads' corpus (integration) ----


def test_attached_knowledge_searches_the_component_corpus(client, app, offline_embedder):
    """The two halves' name agreement, pinned against real storage: a document
    uploaded into the corpus the attach DERIVES (``kb-<component_id>``) is
    retrievable through the Knowledge instance the run attach built — with the
    REAL ``build_knowledge_for`` (FakeEmbedder at the provider seam, the
    pgvector container serving the shared table)."""
    component_id = _create_component(client, "kb-real-agent", _fake_knowledge_entry("kb-real-agent"))

    # Upload into the derived corpus first — the same construction the upload
    # route performs (fake embedder; the processing flow is agno's stock).
    upload_kb = build_fake_knowledge(component_id, app.state.agent_os.db, app.state.db_url)
    content = Content(
        name="orchard-notes.txt",
        metadata=knowledge_store.corpus_stamp(upload_kb.name),
        file_data=FileData(content=BANANA_DOC.encode("utf-8"), type="manual"),
        size=len(BANANA_DOC.encode("utf-8")),
        user_id=None,
    )
    content.content_hash = upload_kb._build_content_hash(content)
    content.id = generate_id(content.content_hash)
    # The service's background-task discipline (knowledge_api mirrors agno's
    # stock flow this way): the async processing to completion on its own loop.
    asyncio.run(process_content(upload_kb, content))
    assert upload_kb.get_content_by_id(content.id).status == ContentStatus.COMPLETED

    # The run-side attach: the REAL factory, the FakeEmbedder swapped in at
    # the provider seam, the same DSN the route threads.
    agent, _stored, _fns = _build_for_run(app, component_id, deps={"openai_api_key": "sk-runner"})
    assert isinstance(agent.knowledge, Knowledge)
    assert agent.knowledge.name == f"kb-{component_id}"
    assert agent.knowledge.isolate_vector_search is True

    hits = agent.knowledge.search("banana harvest orchard", max_results=2)
    assert hits, "the attached corpus must be the one the uploads landed in"
    assert "banana" in hits[0].content

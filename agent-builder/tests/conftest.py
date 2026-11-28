"""Test fixtures: the REAL platform-os app against a throwaway Postgres.

The platform-os tests exercise the real machinery: component CRUD, the
dynamic AG-UI dispatcher, and per-run credential resolution. Model HTTP
calls are cut off by a RecordingModel whose stub client records the
resolved API key and raises — proving the credential path without network
access.

Storage: a session-scoped testcontainers Postgres serves BOTH the agno db
(components/sessions, `ai` schema) and the catalog (`public` schema). The
suite requires a running Docker daemon — the container fixture fails fast
with a clear message when it is not.
"""
import os
import sys
from pathlib import Path

AG_DIR = Path(__file__).resolve().parent.parent
TESTS_DIR = Path(__file__).resolve().parent
# The tests dir goes on sys.path so `import helpers` binds to THIS suite's
# helpers (all agents' tests dirs are namespace packages named "tests" — a
# relative import would bind to whichever suite pytest loaded first).
for p in (TESTS_DIR, AG_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

# Env BEFORE importing the service modules: model construction and build_app
# read these at import/boot time.
os.environ.setdefault("OPENAI_API_KEY", "test-dummy-openai-key")
os.environ.setdefault("JWT_SECRET", "test-secret-32-chars-min-please-xx")

import psycopg
import pytest
from fastapi.testclient import TestClient

from catalog import CatalogDB, ModelRow

import knowledge as knowledge_store

# Default test catalog mirroring the pre-DB offering: both model providers
# enabled with today's ids, plus the two keyless toolkits. Keyed toolkits
# are never registry members (per-run delivery), so only keyless ones are
# enabled here. Catalog tests that need a different state build their own
# app via `bare_app`.
DEFAULT_PROVIDERS = [("openai-chat", True), ("openrouter", True)]
DEFAULT_MODELS = [
    ModelRow(provider_slug="openai-chat", id="gpt-4o-mini", attrs={}, tier=False),
    ModelRow(
        provider_slug="openrouter",
        id="z-ai/glm-5.3-flash",
        attrs={"max_tokens": 8192},
        tier=False,
    ),
]
DEFAULT_TOOLS = ["calculator", "duckduckgo"]


def seed_catalog(app, providers=DEFAULT_PROVIDERS, models=DEFAULT_MODELS, tools=DEFAULT_TOOLS):
    state = app.state.catalog
    state.db.replace_providers_and_models(providers, models)
    state.db.replace_tools(tools)
    state.ensure_current(app.state.agent_os)
    return state


@pytest.fixture(scope="session")
def postgres_dsn():
    """A throwaway Postgres for the whole session (agno db + catalog)."""
    try:  # testcontainers >= 4.13 moved community modules under .community
        from testcontainers.community.postgres import PostgresContainer
    except ImportError:
        from testcontainers.postgres import PostgresContainer

    try:
        # The pgvector image, NOT plain postgres (alpine Postgres has no
        # pgvector extension to install at runtime — the knowledge tests
        # build the shared `builder_knowledge` vector table, whose
        # `CREATE EXTENSION vector` must succeed at first use, #233).
        container = PostgresContainer("pgvector/pgvector:pg16")
        container.start()
    except Exception as e:
        raise RuntimeError(
            "The test suite requires Docker (testcontainers) — start Docker and rerun."
        ) from e
    try:
        # Plain libpq URL (no sqlalchemy dialect suffix): works for psycopg
        # directly and for agno's create_engine (agno rewrites postgresql://
        # to the psycopg3 `postgresql+psycopg` dialect).
        host = container.get_container_host_ip()
        port = container.get_exposed_port(5432)
        user = container.username
        password = container.password
        dbname = container.dbname
        yield f"postgresql://{user}:{password}@{host}:{port}/{dbname}"
    finally:
        container.stop()


@pytest.fixture(autouse=True)
def hermetic_embedder_env(monkeypatch):
    """Scrub the ambient ``KNOWLEDGE_EMBEDDER`` for every test (#240).

    The embedder config is parsed AT CALL TIME from ``os.environ`` — by the
    capability payload, ``build_knowledge_for``, and the dispatcher's per-run
    attach — so a developer shell exporting a malformed value (or a valid
    non-default one) flips every default-config knowledge test onto the
    documented degradation paths (503 / run-without-retrieval) instead of the
    successes they pin. Scrubbing here makes the suite hermetic against the
    developer's shell in one place. Nothing is masked: tests that pin a
    specific value ``setenv`` it explicitly (that runs after this scrub —
    same ``monkeypatch`` instance), and the parse contract's own tests pass
    explicit mappings.

    Args:
        monkeypatch: pytest's patcher (the ambient value is restored after
            the test).
    """
    monkeypatch.delenv(knowledge_store.EMBEDDER_ENV_VAR, raising=False)


@pytest.fixture(autouse=True)
def clean_database(postgres_dsn):
    """Hermetic per-test state: truncate every user table in `public` (the
    catalog + the knowledge vector table) and `ai` (agno
    components/sessions/knowledge contents) before each test. Tables that do
    not exist yet (first use) are simply absent from the list."""
    with psycopg.connect(postgres_dsn) as conn:
        tables = [
            f'"{schema}"."{name}"'
            for schema, name in conn.execute(
                """
                SELECT table_schema, table_name FROM information_schema.tables
                WHERE table_schema IN ('public', 'ai') AND table_type = 'BASE TABLE'
                """
            ).fetchall()
        ]
        if tables:
            conn.execute(f"TRUNCATE TABLE {', '.join(tables)} RESTART IDENTITY CASCADE")
        conn.commit()
    yield


@pytest.fixture(scope="session")
def platform_main(postgres_dsn):
    """The service module, imported once DATABASE_URL points at the container
    (the env must be set before the first import — build_app reads env at
    build time; the module deliberately builds nothing at import)."""
    os.environ["DATABASE_URL"] = postgres_dsn
    # Re-assert our agent dir at the front of sys.path and evict a foreign
    # cached `main`: other suites' test modules prepend their own agent dir
    # to sys.path at collection time, which would make `import main` bind
    # to the WRONG agent's module.
    sys.path.insert(0, str(AG_DIR))
    stale = sys.modules.get("main")
    if stale is not None and Path(getattr(stale, "__file__", "")).resolve() != (AG_DIR / "main.py").resolve():
        del sys.modules["main"]
    import main as platform_main

    return platform_main


@pytest.fixture
def app(platform_main, clean_database):
    application = platform_main.build_app(db_url=os.environ["DATABASE_URL"])
    seed_catalog(application)
    return application


@pytest.fixture
def bare_app(platform_main, clean_database):
    """An app with EMPTY catalog tables — no enabled models or tools."""
    return platform_main.build_app(db_url=os.environ["DATABASE_URL"])


@pytest.fixture
def agno_db(postgres_dsn):
    """A fresh agno PostgresDb over the throwaway container.

    The knowledge store's CONTENTS db (the `ai.agno_knowledge` rows agno keeps
    status/size/dates in) — what the knowledge-layer tests hand to
    ``build_knowledge``/``build_fake_knowledge`` so they exercise the same
    construction the routes perform, without booting the whole app.
    """
    from agno.db.postgres import PostgresDb
    from agno.db.postgres.engine import create_postgres_engine

    return PostgresDb(id="test-agno-db", db_engine=create_postgres_engine(postgres_dsn))


@pytest.fixture
def client(app):
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def bare_client(bare_app):
    return TestClient(bare_app, raise_server_exceptions=False)

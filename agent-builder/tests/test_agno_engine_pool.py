"""The agno db's engine survives a Neon suspend/wake cycle — explicitly.

#129 taught the catalog's psycopg_pool to self-heal a server-terminated
connection (``check=`` at handout, ``max_idle=60``). The agno db is a
SEPARATE SQLAlchemy engine — same Neon exposure, different code path — and
its ``pool_pre_ping`` rests on agno's PRIVATE ``_engine_options()`` default:
``PostgresDb(db_url=...)`` picks it up silently, and a minor agno bump that
dropped the private default would silently re-expose the "SSL connection
has been closed unexpectedly" failure with the suite still green. That
silent-drift class is exactly what #157 closes: the engine must be built
through agno's PUBLIC factory (``create_postgres_engine`` — its docstring
contract is ``pool_pre_ping=True, pool_recycle=3600`` plus agno's JSON
serializer) and handed to ``PostgresDb`` as ``db_engine``, where WE own the
guarantee.

These tests pin both halves of the contract, mirroring
``test_catalog_pool.py``'s wiring assertions:

- the factory engine really carries pre-ping and the recycle bound, and
- ``build_app`` actually routes the factory-built engine to the agno db
  (identity, via a spy on the factory seam ``main.py`` binds at import).

Engine creation is lazy — no connection is opened by the factory test, so
no server is needed. The wiring test boots the real app against the
testcontainer (``catalog.refresh()`` needs a live server), like every
other build_app test.
"""

from agno.db.postgres.engine import create_postgres_engine


def test_factory_engine_pre_pings_and_recycles():
    """The factory's protective defaults are real: a handout probe and the
    idle recycle bound. SQLAlchemy stores both privately on the pool — no
    public property exists. Same discipline as test_catalog_pool.py's
    ``pool._check`` read: an upstream rename fails loudly here rather than
    letting the wiring drift silently."""
    engine = create_postgres_engine("postgresql://agno-engine-pool-test.invalid/db")
    try:
        assert engine.pool._pre_ping is True
        assert engine.pool._recycle == 3600
    finally:
        engine.dispose()


def test_build_app_hands_the_factory_engine_to_agno(platform_main, postgres_dsn, monkeypatch):
    """The service must construct the agno db's engine through the public
    factory — a regression to ``PostgresDb(db_url=...)`` would work today
    (the private default still applies) and fail invisibly on some future
    agno bump. The spy watches the exact seam main.py binds at import;
    passing factory kwargs would also be a red flag: the factory defaults
    ARE the contract."""
    calls = []
    engines: list = []
    real = platform_main.create_postgres_engine

    def spy(db_url, **kwargs):
        calls.append((db_url, kwargs))
        engine = real(db_url, **kwargs)
        engines.append(engine)
        return engine

    monkeypatch.setattr(platform_main, "create_postgres_engine", spy)
    try:
        app = platform_main.build_app(db_url=postgres_dsn)
        assert calls == [(postgres_dsn, {})]
        assert app.state.agent_os.db.db_engine is engines[0]
    finally:
        # Encloses build_app: if it raises after the spy has produced the
        # engine, the engine still gets disposed (no `app` to reach for).
        if engines:
            engines[0].dispose()

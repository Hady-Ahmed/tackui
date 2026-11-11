"""The catalog pool survives a Neon suspend/wake cycle.

Neon suspends its compute after ~5 min of ACTIVITY-based idle — open-but-idle
pooled connections don't count, and suspension kills them server-side. The
pool's ``check=`` callback (the psycopg_pool analog of SQLAlchemy's
``pool_pre_ping``) is the fix: a liveness probe at handout that fails on a
dead connection so the pool discards it and hands out a fresh one instead of
surfacing "SSL connection has been closed unexpectedly" at the first query.

These tests run the REAL psycopg_pool machinery (the pinned 3.3.3) against a
scripted connection class — no server, no Neon. They pin BOTH halves of the
contract:

- the pool's own discard-and-replace semantics (check fails → connection
  counted as lost → replacement created → caller still gets a live one), and
- the production wiring in ``catalog._pool_for`` (check and max_idle actually
  set on the pool the service builds).

Discard-and-replace semantics were verified against the installed pool source
(psycopg_pool 3.3.3): ``_getconn_with_check_loop`` runs ``check`` on handout;
on failure the connection is put back ``from_getconn=True``, which
``_return_connection`` counts as CONNECTIONS_LOST (transaction status
UNKNOWN) and schedules an ``AddConnection`` replacement, while the caller's
retry loop (bounded by the pool timeout) waits for the fresh connection.
"""
import psycopg
from psycopg.pq import TransactionStatus
import psycopg_pool

import catalog


class _ScriptedPgconn:
    """Just the attribute the pool reads: ``pgconn.transaction_status``."""

    def __init__(self, status: int):
        self.transaction_status = status


class _ScriptedConnection:
    """Stand-in for psycopg.Connection at the surface the pool touches.

    Instances are either ``dead`` (the corpse Neon's suspension leaves in the
    pool: every query raises the SSL error, transport status UNKNOWN) or
    ``live`` (the woken compute). What the pool does NOT touch is absent —
    if the pool started needing more of a real connection than this, the
    test fails loudly rather than passing vacuously.
    """

    # Class state set per-test via make_connection_class(): the scripted
    # kinds handed out by connect(), one per pool connection creation, in
    # order. Creation order mirrors the incident: the FIRST connection is
    # the one stranded by the suspend; everything after is the woken compute.
    script: list

    def __init__(self, dead: bool):
        self.dead = dead
        self.pgconn = _ScriptedPgconn(
            TransactionStatus.UNKNOWN if dead else TransactionStatus.IDLE
        )
        self.executed: list = []
        self.closed = False

    @classmethod
    def connect(cls, conninfo=None, **kwargs):
        kind = cls.script.pop(0) if cls.script else "live"
        return cls(dead=(kind == "dead"))

    # -- the surface catalog.py / the pool's check callback uses -------------

    def execute(self, query, params=None, *, prepare=None):
        self.executed.append(query)
        if self.dead:
            raise psycopg.OperationalError(
                "consuming input failed: SSL connection has been closed unexpectedly"
            )
        return None

    # -- transaction/close surface the pool's connection() context expects ---

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False


def make_connection_class(script: list):
    """A ScriptedConnection class whose instances come out in the scripted
    order (the pool creates connections via ``connection_class.connect``)."""
    return type("ScriptedConnection", (_ScriptedConnection,), {"script": script})


def build_incident_pool(connection_class) -> psycopg_pool.ConnectionPool:
    """A pool with the production shape (min 1, check probe) over the
    scripted connections: opened cold, so the first creation is the corpse.

    ``num_workers=1`` makes the pool's background tasks (ReturnConnection /
    AddConnection) execute in strict FIFO order, so the scripted
    dead-then-live handoff is deterministic — with the default 3 workers a
    second worker could serve the replacement before the first worker
    processes the discard, racing the ``connections_lost == 1`` assertion.
    """
    return psycopg_pool.ConnectionPool(
        "postgresql://scripted/test",
        min_size=1,
        max_size=2,
        timeout=10.0,
        check=lambda conn: conn.execute("SELECT 1"),
        connection_class=connection_class,
        open=True,
        num_workers=1,
    )


def test_dead_pooled_connection_is_discarded_and_replaced():
    """Suspend/wake cycle, simulated: the pool opens, Neon suspends (the one
    pooled connection dies), the next request checks it out. The request must
    succeed transparently on a LIVE connection, with exactly one discard."""
    conns = make_connection_class(["dead", "live"])
    pool = build_incident_pool(conns)
    try:
        with pool.connection() as conn:
            # The caller's "query" runs on a live connection — the failure
            # never escaped the pool.
            assert not conn.dead
            conn.execute("SELECT revision FROM platform_catalog_version")

        stats = pool.get_stats()
        # Exactly one discard: the dead handout. Not zero (the check did
        # nothing) and not more (the live replacement was not discarded).
        assert stats["connections_lost"] == 1
        # Two creations at least: the corpse and its replacement.
        assert stats["connections_num"] >= 2
    finally:
        pool.close()


def test_check_probe_runs_on_every_handout():
    """The check is a probe at handout, not a one-off at connect: the live
    replacement is probed with SELECT 1 too (the warm path's ~1ms cost)."""
    conns = make_connection_class(["dead", "live"])
    pool = build_incident_pool(conns)
    try:
        with pool.connection() as conn:
            live = conn
            conn.execute("SELECT revision FROM platform_catalog_version")
        # The live connection was handed out once (check) and used once
        # (our query): its execute log shows the probe + the query.
        assert live.executed == ["SELECT 1", "SELECT revision FROM platform_catalog_version"]
    finally:
        pool.close()


def test_pool_for_wires_check_and_max_idle():
    """The service's pool factory (catalog._pool_for) actually wires the
    liveness probe and the sub-Neon-suspend idle reaper — the fix is in the
    pool the SERVICE builds, not just in pools tests build ad hoc."""
    dsn = "postgresql://pool-for-wiring-test.invalid/db"
    try:
        pool = catalog._pool_for(dsn)
        # `_check` is a psycopg_pool private name — if an upstream rename
        # breaks this line, tests 1-2 above still pin the behavior; this
        # assertion is only for immediate wiring-drift visibility.
        assert pool._check is not None
        assert pool.max_idle == 60
    finally:
        # Close the background reconnection attempts against the bogus DSN
        # and uncache, so the factory's module state stays clean per-test.
        pool = catalog._POOLS.pop(dsn, None)
        if pool is not None:
            pool.close()

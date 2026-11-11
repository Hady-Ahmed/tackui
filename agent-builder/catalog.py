"""The platform catalog — Postgres tables holding the admin's offering decisions.

The catalog is DATA, not code: the admin ticks checkboxes (providers,
toolkits) and types model ids in the frontend's admin UI; this module persists
those decisions and a revision counter that lets the in-memory registry
detect changes cheaply (one integer compare per request — no row diffing,
no rebuild-every-request).

Only DECISIONS live here. Everything derived (credential contracts, function
lists, env keys, classes) comes from the discovery scan — storing it would
invite drift. Tables are created on boot; they start EMPTY by design: a
fresh deployment offers nothing until the admin enables entries.

Storage: the same Postgres DATABASE_URL as the agno db (Neon in prod, local
pg in dev), in the `public` schema beside agno's `ai` schema. `attrs` is a
native JSONB column — psycopg decodes it straight back into the dict the
constructor kwargs need, and an unparseable-attrs row is structurally
impossible (the database rejects malformed JSON at write time), which is a
stronger guarantee than the old TEXT column's skip-on-read guard.
"""
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

import psycopg
import psycopg_pool
from psycopg.types.json import Json

_SCHEMA = """
CREATE TABLE IF NOT EXISTS platform_provider (
    slug     TEXT PRIMARY KEY,
    enabled  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS platform_model (
    provider_slug TEXT NOT NULL,
    id            TEXT NOT NULL,
    attrs         JSONB NOT NULL DEFAULT '{}'::jsonb,
    tier          BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (provider_slug, id)
);
CREATE TABLE IF NOT EXISTS platform_tool (
    slug    TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS platform_connector (
    connector_id TEXT PRIMARY KEY,
    url          TEXT NOT NULL,
    label        TEXT
);
CREATE TABLE IF NOT EXISTS platform_catalog_version (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1
);
"""

# Bump when the platform_* tables' shape changes in a way old code can't
# read or new code can't tolerate (column added/removed/renamed, semantic
# change to an existing column). The marker is checked at boot: a database
# written by a different schema version refuses to serve rather than
# misreading rows silently (an old code + new tables mix could e.g. ignore
# a NOT NULL column and write rows the new code rejects).
_SCHEMA_VERSION = 1


@dataclass
class ModelRow:
    provider_slug: str
    id: str
    attrs: Dict  # constructor kwargs for the model class (validated at write)
    tier: bool  # platform-key eligible flag (dormant for builder runs; Phase 3 wakes it)


@dataclass(frozen=True)
class ConnectorRow:
    """One registered MCP connector endpoint, keyed by the connector's
    tackui-side id (globally unique — connector NAMES are org-scoped and
    collide across orgs; ids don't). Written ONLY by the run client's
    server (push-first-then-commit: the row exists before any local row
    references it). URLs only — tokens never touch this table; they are
    delivered per run from the client."""

    connector_id: str
    url: str
    label: Optional[str] = None


@dataclass(frozen=True)
class CatalogSnapshot:
    """One consistent read of the catalog: the revision counter plus every
    row the rebuild needs, captured in a single transaction."""

    revision: int
    providers: Dict[str, bool]
    model_rows: List[ModelRow]
    tools: Dict[str, bool]
    connectors: Dict[str, ConnectorRow] = field(default_factory=dict)


# One connection pool per DSN, created lazily on first use (never at import —
# the DATABASE_URL does not exist yet at import time in tests) and shared by
# every CatalogDB instance targeting the same URL. A raw connect/close per
# operation cost a full TCP/TLS cycle on every request — including every
# run's revision check — which against Neon's TLS handshake is real latency.
# The pool amortizes it; context-manager semantics (commit/rollback/return)
# stay identical to the old per-call connection, so call sites don't change.
_POOLS: Dict[str, psycopg_pool.ConnectionPool] = {}
_POOL_LOCK = threading.Lock()


def _pool_for(db_url: str) -> psycopg_pool.ConnectionPool:
    pool = _POOLS.get(db_url)
    if pool is None:
        # Double-checked: two threads racing the first use must not build
        # two pools (the loser's would be orphaned with open connections).
        with _POOL_LOCK:
            pool = _POOLS.get(db_url)
            if pool is None:
                pool = psycopg_pool.ConnectionPool(
                    db_url,
                    min_size=1,
                    # 8 concurrent DB connections is deliberate: each is a
                    # real server connection and the deployment shares a
                    # Neon instance with the agno db's own pool.
                    max_size=8,
                    # Bound the WAIT for a connection. The psycopg default
                    # is 30s of silent queuing — under a burst beyond 8
                    # concurrent DB touchers, requests would pile up with
                    # no signal until some downstream timeout fired. A 10s
                    # cap fails fast with a clear PoolTimeout instead (the
                    # route surfaces a 5xx and the client retries).
                    timeout=10.0,
                    # Liveness probe at handout (the psycopg_pool analog of
                    # SQLAlchemy's pool_pre_ping). Neon's compute suspends
                    # after ~5 min of activity-based idle — open-but-idle
                    # connections do NOT count as activity — and suspension
                    # kills every pooled connection. Without a check, the
                    # next request after a quiet gap is handed a corpse and
                    # the first query dies with "SSL connection has been
                    # closed unexpectedly". With it, the ~1ms SELECT 1
                    # fails on the dead conn, the pool discards it and
                    # hands out a fresh one (which wakes the compute) —
                    # the request succeeds and the failure never escapes
                    # the pool. Discard-and-replace semantics verified
                    # against the pinned psycopg_pool 3.3.3 source; the
                    # dead-then-live cycle is pinned by test in
                    # tests/test_catalog_pool.py.
                    check=lambda conn: conn.execute("SELECT 1"),
                    # Complementary knob: proactively close idle pool
                    # connections (down to min_size) before Neon's ~5-min
                    # suspend reaps them server-side, so the check above
                    # rarely has to eat the wake-up latency at all. The
                    # pool's shrinker runs on this interval and closes one
                    # idle connection above min_size per tick; the default
                    # is 10 min — longer than Neon's suspend timeout.
                    max_idle=60,
                    kwargs={"connect_timeout": 5},
                    open=True,
                )
                _POOLS[db_url] = pool
    return pool


class CatalogDB:
    """Durable catalog state. Shares the service's Postgres DATABASE_URL —
    the agno db owns components/sessions (in the `ai` schema); the catalog
    lives in `public` and never touches them."""

    def __init__(self, db_url: str):
        self.db_url = db_url
        with self._conn() as conn:
            conn.execute(_SCHEMA)
            # Pre-existing databases (created before the marker existed)
            # get the column added idempotently — fresh databases already
            # have it from _SCHEMA.
            conn.execute(
                "ALTER TABLE platform_catalog_version ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1"
            )
            # Parity with the old INSERT OR IGNORE: a re-init (second app
            # boot) must never reset the revision counter.
            conn.execute(
                "INSERT INTO platform_catalog_version (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING"
            )
            # Schema-version marker: a fresh database is stamped by the
            # column default; an existing one must MATCH. A mismatch means
            # code and tables disagree about the platform_* shapes — serving
            # would misread or silently corrupt rows, so the boot refuses
            # with the remediation instead. (The tables are rebuilt by the
            # admin from the platform UI after a reset; rows are admin-
            # entered config, not derived state.)
            row = conn.execute(
                "SELECT schema_version FROM platform_catalog_version WHERE id = 1"
            ).fetchone()
            stored = row[0] if row is not None else None
            if stored != _SCHEMA_VERSION:
                raise RuntimeError(
                    f"platform catalog schema version mismatch: database has {stored}, "
                    f"this code expects {_SCHEMA_VERSION}. The platform_* tables and the "
                    "running code disagree — deploy the matching code version, or (if the "
                    "tables are stale) drop the platform_* tables and re-enter the catalog."
                )

    @contextmanager
    def _conn(self):
        """A pooled connection with transactional commit/rollback semantics.

        ``pool.connection()`` commits on clean exit, rolls back on error and
        returns the connection to the pool — the same contract the old
        per-call connect/commit/rollback/close provided."""
        with _pool_for(self.db_url).connection() as conn:
            yield conn

    # -- reads ---------------------------------------------------------------

    def snapshot(self) -> "CatalogSnapshot":
        """Revision + all catalog rows read over ONE connection/transaction.

        The rebuild consumes this so the whole registry build reflects a
        single snapshot: the revision it stamps is the same one the rows it
        read were written under. Reading the revision separately (after the
        row reads) would let a concurrent write's NEW revision be stamped
        onto a registry built from OLD rows — the missed-wakeup that makes
        ``ensure_current`` never rebuild for a non-self writer.
        """
        with self._conn() as conn:
            return CatalogSnapshot(
                revision=self._read_revision(conn),
                providers={
                    slug: bool(en)
                    for slug, en in conn.execute("SELECT slug, enabled FROM platform_provider")
                },
                model_rows=[
                    ModelRow(provider_slug=p, id=i, attrs=a, tier=bool(t))
                    for p, i, a, t in conn.execute(
                        "SELECT provider_slug, id, attrs, tier FROM platform_model ORDER BY provider_slug, id"
                    )
                ],
                tools={
                    slug: bool(en)
                    for slug, en in conn.execute("SELECT slug, enabled FROM platform_tool")
                },
                connectors={
                    row[0]: ConnectorRow(connector_id=row[0], url=row[1], label=row[2])
                    for row in conn.execute(
                        "SELECT connector_id, url, label FROM platform_connector ORDER BY connector_id"
                    )
                },
            )

    def get_revision(self) -> int:
        with self._conn() as conn:
            return self._read_revision(conn)

    @staticmethod
    def _read_revision(conn: psycopg.Connection) -> int:
        row = conn.execute("SELECT revision FROM platform_catalog_version WHERE id = 1").fetchone()
        return int(row[0]) if row else 0

    def enabled_providers(self) -> Dict[str, bool]:
        with self._conn() as conn:
            return {slug: bool(en) for slug, en in conn.execute("SELECT slug, enabled FROM platform_provider")}

    def model_rows(self) -> List[ModelRow]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT provider_slug, id, attrs, tier FROM platform_model ORDER BY provider_slug, id"
            ).fetchall()
        # attrs is JSONB: psycopg already hands back the dict — no decode, no
        # corrupt-row path (malformed JSON cannot exist in the column).
        return [ModelRow(provider_slug=p, id=i, attrs=a, tier=bool(t)) for p, i, a, t in rows]

    def enabled_tools(self) -> Dict[str, bool]:
        with self._conn() as conn:
            return {slug: bool(en) for slug, en in conn.execute("SELECT slug, enabled FROM platform_tool")}

    # -- writes (each bumps the revision) ------------------------------------

    def replace_providers_and_models(
        self, providers: Iterable[Tuple[str, bool]], models: Iterable[ModelRow]
    ) -> int:
        """Full-state write: the admin page edits everything and sends it all."""
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM platform_provider")
                cur.executemany(
                    "INSERT INTO platform_provider (slug, enabled) VALUES (%s, %s)",
                    [(slug, bool(en)) for slug, en in providers],
                )
                cur.execute("DELETE FROM platform_model")
                cur.executemany(
                    "INSERT INTO platform_model (provider_slug, id, attrs, tier) VALUES (%s, %s, %s, %s)",
                    [(m.provider_slug, m.id, Json(m.attrs), m.tier) for m in models],
                )
            return self._bump(conn)

    def replace_tools(self, enabled_slugs: Iterable[str]) -> int:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM platform_tool")
                cur.executemany(
                    "INSERT INTO platform_tool (slug, enabled) VALUES (%s, TRUE)",
                    [(slug,) for slug in enabled_slugs],
                )
            return self._bump(conn)

    def upsert_connector(self, connector_id: str, url: str, label: Optional[str]) -> int:
        """Register/refresh one MCP connector endpoint. Idempotent: the run
        client pushes on connector create/edit AND belt-and-braces at agent
        save, so repeated identical upserts are the normal case."""
        with self._conn() as conn:
            conn.execute(
                """INSERT INTO platform_connector (connector_id, url, label)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (connector_id) DO UPDATE SET
                     url = EXCLUDED.url,
                     label = EXCLUDED.label""",
                (connector_id, url, label),
            )
            return self._bump(conn)

    def delete_connector(self, connector_id: str) -> int:
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM platform_connector WHERE connector_id = %s",
                (connector_id,),
            )
            return self._bump(conn)

    def _bump(self, conn: psycopg.Connection) -> int:
        conn.execute("UPDATE platform_catalog_version SET revision = revision + 1 WHERE id = 1")
        row = conn.execute("SELECT revision FROM platform_catalog_version WHERE id = 1").fetchone()
        return int(row[0])

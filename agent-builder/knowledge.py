"""The knowledge store — per-component document corpora on ONE shared pgvector table.

Phase 2 of the agent builder (#233): every builder component can own a document
corpus (uploaded files, pasted text, URLs). All corpora live in ONE pgvector
table (``public.builder_knowledge`` — beside the catalog's tables in the same
``DATABASE_URL`` Postgres; this is OUR infrastructure, not agno's ``ai``
schema) and isolation between corpora is agno's ``isolate_vector_search``
mechanics:

- Every corpus is a named Knowledge instance, ``name = "kb-<component_id>"``.
- Inserts stamp ``linked_to=<name>`` into each chunk's metadata
  (``Knowledge._prepare_documents_for_insert``).
- Every search injects the ``linked_to`` filter server-side
  (``Knowledge._inject_instance_scope_filter`` — callers cannot opt out),
  so corpus B's search can never return corpus A's chunks.
- Content list/delete are scoped by the same ``linked_to`` value (list) and
  by corpus-unique content ids (delete — see the corpus stamp below).

The one rule, extended to embeddings: the embedding KEY is per-call BYOK
(uploads carry the creator's key in the request; runs resolve the runner's key
per run — see ``dispatcher.plan_per_run_knowledge``), and the embedding MODEL is
platform infrastructure fixed per deployment via ``KNOWLEDGE_EMBEDDER``. A
missing key is a client-side error surfaced cleanly — never a silent
platform-key spend (this module never falls back to an env key for the
embedder).

Instances are CONSTRUCTED FRESH PER CALL (upload, list, delete, run attach):
the embedder carries a per-call API key and a shared instance would race keys
across concurrent requests — the same rule that keeps keyed toolkits fresh per
run in ``dispatcher.py``. The cost is one ``vector_db.exists()`` information-
schema round-trip per construction (``Knowledge.__post_init__`` probes and
creates the table on first use — that is also how the pgvector extension gets
loaded: ``PgVector.create()`` runs ``CREATE EXTENSION IF NOT EXISTS vector``).
If profiling ever shows the construction round-trips matter, cache ONLY the
key-free prototype with a measured, documented reason (#233) — not now.
"""
import os
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from agno.db.base import BaseDb
from agno.knowledge.embedder.base import Embedder
from agno.knowledge.knowledge import Knowledge
from agno.utils.log import log_warning
from sqlalchemy.exc import IntegrityError, ProgrammingError

try:  # the website extra is in pyproject; a stripped env degrades to agno's factory
    from agno.knowledge.reader.website_reader import WebsiteReader
except ImportError:  # pragma: no cover
    WebsiteReader = None  # type: ignore[assignment,misc]
    log_warning(
        "agno website reader unavailable — URL ingest falls back to agno's factory"
        " default (max_links=10); the one-page cap (Hady-Ahmed/tackui#260) is OFF"
    )

# The shared vector table: one table, every corpus, isolation by ``linked_to``.
# Lives in the `public` schema (our infrastructure) — NOT agno's default `ai`.
KNOWLEDGE_TABLE = "builder_knowledge"
KNOWLEDGE_SCHEMA = "public"

# The metadata key this service stamps onto every upload's Content so the
# content hash is corpus-unique. See the module docstring and
# :func:`corpus_stamp` for why this is load-bearing.
CORPUS_METADATA_KEY = "corpus"

# The embedding MODEL is platform infrastructure: "<provider>:<model>", fixed
# per deployment via env. The KEY is never configured here — it is per-call.
EMBEDDER_ENV_VAR = "KNOWLEDGE_EMBEDDER"

# The Postgres SQLSTATE for ``duplicate_table`` (42P07). The cold-start race
# guard keys on this code, not on error text or a driver class: it is
# dialect-stable across Postgres versions. PRECONDITION: the guard reads the
# code off the psycopg 3 surface (``.sqlstate``); a psycopg2-backed DSN
# carries the same code at ``.pgcode``/``.diag.sqlstate`` instead, so the
# guard would no-op there (this service's engines are psycopg 3, and a no-op
# only means the failure propagates loudly). See
# :func:`_is_duplicate_table_error`.
DUPLICATE_TABLE_SQLSTATE = "42P07"

# The catalog unique indexes a concurrent first-use construction can violate —
# the OVERLAPPING-DDL flavor of the cold-start race. When the winner's DDL is
# still uncommitted, Postgres does NOT answer the loser's ``CREATE TABLE`` with
# duplicate_table (42P07): it blocks the loser on a catalog unique index until
# the winner's statement resolves, and the loser then fails with
# unique_violation (23505). Empirically (pgvector/pgvector:pg16 — the suite's
# and the compose stacks' image) the first insert to collide is the table's
# ROW TYPE in pg_type, so the loser dies on ``pg_type_typname_nsp_index``;
# ``pg_class_relname_nsp_index`` (the (relname, relnamespace) index) is the
# same benign shape and is kept as defense across catalog paths and versions.
# The concurrent ``CREATE EXTENSION IF NOT EXISTS vector`` every cold
# construction runs races the same way and dies on
# ``pg_extension_name_index`` (the flavor set is pinned by the offline
# retry tests below; the live pg16 probe that chose the names was a
# one-off, not reproducible from the repo). Every
# name here is a unique (name, namespace) index over a system catalog, so
# these names — and ONLY these — are absorbable: a data-level unique violation
# (any other constraint name, or none reported) stays loud. See
# :func:`_is_catalog_name_conflict`.
CATALOG_NAME_CONFLICT_CONSTRAINTS = frozenset({
    "pg_class_relname_nsp_index",
    "pg_extension_name_index",
    "pg_type_typname_nsp_index",
})


@dataclass(frozen=True)
class EmbedderConfig:
    """The platform's embedding configuration, parsed from ``KNOWLEDGE_EMBEDDER``.

    Attributes:
        provider: The embedding provider slug (v1: ``"openai"`` only). Drives
            which credential the BYOK delivery uses (``<provider>_api_key``).
        model: The embedding model id (e.g. ``"text-embedding-3-small"``).
            One model for all corpora: chunk vectors and query vectors must
            share model+dimensions, and the pgvector column is typed
            ``Vector(<dimensions>)`` at table creation, so models cannot be
            mixed or rotated within a deployment without re-uploading.
    """

    provider: str
    model: str


DEFAULT_EMBEDDER = EmbedderConfig(provider="openai", model="text-embedding-3-small")

# v1 embedder providers. A second provider later is ONE branch in
# :func:`_provider_embedder` plus an entry here — not a rewrite.
SUPPORTED_EMBEDDER_PROVIDERS = ("openai",)


class KnowledgeConfigError(ValueError):
    """A malformed ``KNOWLEDGE_EMBEDDER`` — raised AT USE TIME, never at boot.

    Knowledge is optional infrastructure: a bad env must not take the whole
    service down, so nothing here is validated at import. The affected route
    surfaces this as a clean 503 with an operator-readable message (the message
    deliberately does NOT echo the configured value — the response reaches
    browsers through tackui's proxy, and a misconfigured env value could hold
    anything, including a pasted secret).
    """


def parse_embedder_config(env: Optional[Mapping[str, str]] = None) -> EmbedderConfig:
    """Parse ``KNOWLEDGE_EMBEDDER`` into an :class:`EmbedderConfig`.

    The grammar is ``<provider>:<model>`` (e.g. ``openai:text-embedding-3-small``).
    Unset or empty falls back to the default — an operator who configures
    nothing gets the platform default, not a broken deployment. A non-empty
    but malformed value raises :class:`KnowledgeConfigError` — fail-closed AT
    USE TIME (callers construct instances per request), never at boot.

    Args:
        env: The environment mapping to read (defaults to ``os.environ``;
            injectable so tests can pin values without touching the process env).

    Returns:
        The parsed provider + model.

    Raises:
        KnowledgeConfigError: The configured value is malformed (no colon, an
            empty model part, or an unsupported provider).
    """
    raw = (env.get(EMBEDDER_ENV_VAR) if env is not None else os.environ.get(EMBEDDER_ENV_VAR)) or ""
    raw = raw.strip()
    if not raw:
        return DEFAULT_EMBEDDER

    provider, sep, model = raw.partition(":")
    provider = provider.strip().lower()
    model = model.strip()
    # No echo of `raw` (or any parsed part) in any message — see
    # KnowledgeConfigError's docstring: the value could hold a pasted secret.
    if not sep or not model:
        raise KnowledgeConfigError(
            f"{EMBEDDER_ENV_VAR} must be '<provider>:<model>' — the configured value "
            f"has no model part. Example: {DEFAULT_EMBEDDER.provider}:{DEFAULT_EMBEDDER.model}"
        )
    if not provider:
        raise KnowledgeConfigError(
            f"{EMBEDDER_ENV_VAR} must be '<provider>:<model>' — the configured value "
            f"has no provider part. Example: {DEFAULT_EMBEDDER.provider}:{DEFAULT_EMBEDDER.model}"
        )
    if provider not in SUPPORTED_EMBEDDER_PROVIDERS:
        raise KnowledgeConfigError(
            f"{EMBEDDER_ENV_VAR} names an unsupported provider — this deployment supports: "
            f"{', '.join(SUPPORTED_EMBEDDER_PROVIDERS)}"
        )
    return EmbedderConfig(provider=provider, model=model)


def _provider_embedder(provider: str, model: str, api_key: Optional[str]) -> Embedder:
    """Build the embedder for one parsed provider config — the provider dispatch branch.

    v1 is OpenAI only; a second provider is one branch here (plus an entry in
    ``SUPPORTED_EMBEDDER_PROVIDERS``). The key is the CALLER's (per-call BYOK):
    ``api_key=None`` is legitimate for the key-free paths (list/delete never
    embed — ``OpenAIEmbedder`` tolerates ``None`` at construction without any
    network call, and without one its client would lazily resolve an env key,
    which only the embedding paths can trigger; none of the key-free paths
    embed, so no key is ever read or sent).

    Args:
        provider: The parsed provider slug (validated by :func:`parse_embedder_config`).
        model: The parsed embedding model id.
        api_key: The per-call embedding key, or ``None`` on key-free paths.

    Returns:
        A fresh embedder instance owned by the caller's Knowledge instance.

    Raises:
        KnowledgeConfigError: An unsupported provider reached the branch
            (unreachable through :func:`build_knowledge_for`; kept explicit —
            never an assert, asserts vanish under ``python -O``).
    """
    if provider == "openai":
        from agno.knowledge.embedder.openai import OpenAIEmbedder

        return OpenAIEmbedder(id=model, api_key=api_key)
    raise KnowledgeConfigError(
        f"{EMBEDDER_ENV_VAR} names an unsupported provider — this deployment supports: "
        f"{', '.join(SUPPORTED_EMBEDDER_PROVIDERS)}"
    )


def corpus_name(component_id: str) -> str:
    """The Knowledge instance name for a component's corpus: ``kb-<component_id>``.

    This name IS the isolation key: it stamps ``linked_to`` on every chunk and
    scopes every list. The run half (``dispatcher.plan_per_run_knowledge``)
    derives the same name from the agent id, so both halves resolve one corpus
    by construction.

    Args:
        component_id: The stored component's id (the builder agent's handle).

    Returns:
        The corpus name.
    """
    return f"kb-{component_id}"


def corpus_stamp(name: str) -> Dict[str, Any]:
    """The service-owned metadata stamp that makes a corpus's content hashes unique.

    WHY THIS EXISTS — agno's shared-table gaps this issue closes (verified
    against agno 3.1.12): content ids are ``generate_id(content_hash)`` and the
    hash covers name/description/metadata/url/bytes but NOT the Knowledge
    instance's name. On one shared table that means two corpora uploading the
    same content would (a) collide onto one content id — the contents row's
    ``linked_to`` flips to the last writer, (b) ``skip_if_exists`` would skip
    the second corpus's ingest entirely (its ``content_hash_exists`` check is
    shared-bucket-wide), and (c) ``delete_by_content_id`` is not
    ``linked_to``-filtered, so a delete through corpus A would strip corpus B's
    vectors. Stamping the corpus name into the upload's metadata appends it to
    the hash (agno hashes metadata deterministically), making ids corpus-unique
    and all three paths corpus-scoped BY CONSTRUCTION.

    Args:
        name: The corpus's Knowledge instance name (:func:`corpus_name`).

    Returns:
        The metadata dict to attach to the upload's ``Content``.
    """
    return {CORPUS_METADATA_KEY: name}


def corpus_of(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    """Read a content row's corpus stamp (the inverse of :func:`corpus_stamp`).

    Args:
        metadata: The content row's metadata dict (as stored on the contents-db row).

    Returns:
        The stamped corpus name, or ``None`` when the row carries no stamp
        (rows written outside this service's routes).
    """
    if not metadata:
        return None
    value = metadata.get(CORPUS_METADATA_KEY)
    return value if isinstance(value, str) else None


def _is_duplicate_table_error(exc: Exception) -> bool:
    """Whether ``exc`` is the Postgres ``duplicate_table`` server error (SQLSTATE 42P07).

    The COMMITTED-CONFLICT flavor of the cold-start table-creation race: two
    concurrent first-use constructions both observe the shared table absent
    (agno's ``PgVector.create`` probes then creates — a TOCTOU window) and the
    loser's ``CREATE TABLE`` is answered with DuplicateTable — which happens
    when the winner's DDL was already committed. When the two DDLs OVERLAP
    (the winner's is still uncommitted), Postgres fails the loser with a
    unique violation on a catalog index instead — see
    :func:`_is_catalog_name_conflict`. The driver error arrives wrapped in
    SQLAlchemy's ``ProgrammingError`` (this service's engines are
    psycopg-backed via agno), so the code is read off the wrapped DBAPI error
    (``exc.orig``), falling back to the exception itself for an unwrapped
    driver error.

    WHY SQLSTATE, not a driver class or message text: the code is the
    dialect-stable Postgres contract for ``duplicate_table``, independent of
    error-message wording — matching on text would be fragile and
    locale-dependent. PRECONDITION: the read is the psycopg 3 surface
    (``.sqlstate``); a psycopg2-backed DSN would carry the same code at
    ``.pgcode`` and this guard would no-op — see the note at
    ``DUPLICATE_TABLE_SQLSTATE``.

    Args:
        exc: The exception raised by the construction (a
            ``sqlalchemy.exc.ProgrammingError`` in the raced shape).

    Returns:
        True when the error is the duplicate-table server error (the table
        now exists — construction may retry), False otherwise (re-raise).
    """
    candidates = (exc, getattr(exc, "orig", None))
    return any(
        getattr(candidate, "sqlstate", None) == DUPLICATE_TABLE_SQLSTATE
        for candidate in candidates
        if candidate is not None
    )


def _is_catalog_name_conflict(exc: Exception) -> bool:
    """Whether ``exc`` is the OVERLAPPING-DDL flavor of the cold-start race.

    When the winner's DDL is still uncommitted, Postgres does not answer the
    loser's ``CREATE TABLE`` with ``duplicate_table`` (42P07) — it blocks the
    loser on a catalog unique (name, namespace) index until the winner's
    statement resolves, and the loser then fails with unique_violation (23505).
    Empirically (pgvector/pgvector:pg16) the first insert to collide is the
    table's ROW TYPE in pg_type, so the loser dies on
    ``pg_type_typname_nsp_index``; ``pg_class_relname_nsp_index`` is the same
    benign shape (kept as defense), and the concurrent
    ``CREATE EXTENSION IF NOT EXISTS vector`` dies on
    ``pg_extension_name_index``. Either way the name conflict carries the same
    good news as 42P07 — the winner created the object — so the construction
    may retry. A DATA-level unique violation (any other constraint name, or
    none reported) is NOT this flavor and must propagate untouched.

    psycopg 3 surfaces the name at ``.diag.constraint_name`` on the driver
    error, which SQLAlchemy wraps as ``IntegrityError.orig`` — so the name is
    read the same way the SQLSTATE is (off ``exc`` and ``exc.orig``), and a
    missing ``diag``/attribute degrades to False.

    This predicate is calibrated to the construction path, whose guarded
    region is DDL-only (CREATE EXTENSION/SCHEMA/TABLE) — it keys on the
    constraint name alone, which is unforgeable there. It must NOT be
    reused on a data path: a data-path guard would additionally require
    ``sqlstate == "23505"``.

    Args:
        exc: The exception raised by the construction (a
            ``sqlalchemy.exc.IntegrityError`` in this raced shape).

    Returns:
        True when the error is a unique violation on one of the pinned catalog
        name-conflict indexes (the object now exists — construction may
        retry), False otherwise (re-raise).
    """
    for candidate in (exc, getattr(exc, "orig", None)):
        if candidate is None:
            continue
        constraint = getattr(getattr(candidate, "diag", None), "constraint_name", None)
        if constraint in CATALOG_NAME_CONFLICT_CONSTRAINTS:
            return True
    return False


def build_knowledge(
    component_id: str,
    db: BaseDb,
    embedder: Embedder,
    *,
    db_url: Optional[str] = None,
    name: Optional[str] = None,
) -> Knowledge:
    """Build a corpus's Knowledge instance — the mechanical construction both halves use.

    Constructed fresh per call — never shared or cached (see the module
    docstring: per-call key isolation, and the accepted one-round-trip
    construction cost). Construction probes the vector table and creates it —
    with the pgvector extension — on first use.

    The first-use probe is a TOCTOU check-then-create (agno's
    ``PgVector.create`` runs ``table_exists()`` then an unchecked
    ``Table.create``): two concurrent first-use constructions — two
    simultaneous runs, or a run racing the first upload on a fresh
    deployment — can both observe the table absent, and the loser's DDL
    fails in one of two flavors. When the winner's DDL was ALREADY
    COMMITTED, the loser's ``CREATE TABLE`` is answered with the
    ``duplicate_table`` server error (SQLSTATE 42P07); when the two DDLs
    OVERLAP (the winner's is still uncommitted), Postgres blocks the loser
    on a catalog unique (name, namespace) index and the loser fails with a
    unique_violation — empirically on the table's row type in pg_type
    (``pg_type_typname_nsp_index``; ``pg_class_relname_nsp_index`` kept as
    defense), and the concurrent ``CREATE EXTENSION`` racing the same way
    fails on ``pg_extension_name_index``. Both flavors carry the good news (the
    winner created the object), so they are absorbed with ONE retry of the
    construction (the retry's probe now finds the table present and skips
    creation). Any other failure propagates untouched — a real
    misconfiguration (an unreachable store, missing pgvector extension,
    permission denied) AND any data-level unique violation (a constraint
    name other than those catalog indexes) must reach the callers'
    existing degrade paths (dispatcher: run without retrieval; management
    routes: 503), never be masked by a retry.

    Args:
        component_id: The component whose corpus this is (drives the default
            instance name).
        db: The service's agno ``PostgresDb`` — the CONTENTS db (the
            ``ai.agno_knowledge`` rows agno keeps status/size/dates in).
        embedder: A fresh embedder carrying the caller's key (BYOK) — its
            ``dimensions`` type the pgvector column on first table creation.
        db_url: The vector store's Postgres DSN (defaults to ``DATABASE_URL``;
            the same Postgres the catalog and agno db live in — a separate
            store would only add an operational surface).
        name: The Knowledge instance name. Defaults to :func:`corpus_name`
            of ``component_id`` (``kb-<component_id>``). The run-time attach
            passes the STORED config name explicitly instead: when it drifted
            from the derivation, the stored name wins — the corpus was
            uploaded (stamped ``linked_to``) under it, and matching the
            derivation would address an empty (or foreign) corpus.

    Returns:
        A fresh, isolation-isolated Knowledge instance for the corpus.

    Raises:
        RuntimeError: No DSN is available (neither argument nor env).
        KnowledgeConfigError: Not raised here (the embedder is already built);
            see :func:`build_knowledge_for` for the parse-time variant.
    """
    from agno.vectordb.pgvector import PgVector

    url = db_url or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "No Postgres DSN for the knowledge vector store — pass db_url or set DATABASE_URL"
        )
    vector_db = PgVector(
        table_name=KNOWLEDGE_TABLE,
        schema=KNOWLEDGE_SCHEMA,
        db_url=url,
        embedder=embedder,
    )
    # URL ingest is ONE PAGE, by decision (Hady-Ahmed/tackui#260): the
    # platform caps the website reader at max_links=1 — the crawl loop
    # spends its only slot on the submitted URL, so every queued link
    # (including same-page #anchor fragments, whose full-URL strings agno's
    # visited-set treats as distinct) is skipped. Without the cap a
    # single-page site with a 7-anchor nav produced 8 rows of duplicated
    # content and crowded retrieval. Sitemap/YouTube auto-detection is
    # untouched (only the "website" key is provided; the rest fall through
    # to agno's factory). FLIP-OFF: when multi-page crawling is wanted,
    # raise the value (or make it env-configurable) — see #260 for the
    # trade-offs recorded at decision time.
    readers = None
    if WebsiteReader is not None:
        readers = {"website": WebsiteReader(max_links=1)}

    def _construct() -> Knowledge:
        """One construction attempt (the table is probed/created in ``__post_init__``)."""
        return Knowledge(
            name=name or corpus_name(component_id),
            vector_db=vector_db,
            content_db=db,
            isolate_vector_search=True,
            readers=readers,
        )

    try:
        return _construct()
    except (ProgrammingError, IntegrityError) as e:
        # The two race flavors (see the docstring): the committed-conflict
        # duplicate_table error, and the overlapping-DDL catalog name-conflict
        # unique violation. Any other failure — including a data-level unique
        # violation — propagates untouched.
        if not (_is_duplicate_table_error(e) or _is_catalog_name_conflict(e)):
            raise
        # The race loser's object already exists (the winner created it) — the
        # one retry re-probes and skips creation. Bounded: exactly one. The
        # vector store is reused (its engine is per-instance, already built),
        # and safely so: every agno call opens its own session/connection
        # (``create()``'s scoped session, ``table_exists()``'s per-call
        # inspection, ``Table.create``'s engine connection) and the pool
        # rolls connections back on return, so the retry never reuses the
        # aborted transaction's connection.
        log_warning(
            "knowledge: cold-start table-creation race lost — retrying the "
            "construction once (the concurrent winner created the shared table)"
        )
        return _construct()


def build_knowledge_for(
    component_id: str,
    db: BaseDb,
    api_key: Optional[str] = None,
    *,
    db_url: Optional[str] = None,
    name: Optional[str] = None,
) -> Knowledge:
    """Build a corpus's Knowledge instance with the platform's configured embedder.

    The BYOK specialization of :func:`build_knowledge`: the embedding
    MODEL comes from ``KNOWLEDGE_EMBEDDER`` (platform infrastructure) and the
    embedding KEY is whatever the caller passes — the upload route passes the
    creator's per-call key; the key-free management paths (list/delete) pass
    ``None`` and never embed, so no key is ever read or sent on those paths;
    the run-time attach (``dispatcher.plan_per_run_knowledge``) passes the
    RUNNER's per-run key. There is deliberately NO env-key fallback for the
    embedder: a missing key is a client-side error surfaced cleanly, never a
    silent platform-key spend.

    Args:
        component_id: The component whose corpus this is.
        db: The service's agno ``PostgresDb`` (the contents db).
        api_key: The per-call embedding key, or ``None`` on key-free paths.
        db_url: The vector store's Postgres DSN (defaults to ``DATABASE_URL``).
        name: The Knowledge instance name (defaults to :func:`corpus_name` of
            ``component_id``; the run-time attach threads the stored config's
            name verbatim — see :func:`build_knowledge` for the drift rule).

    Returns:
        A fresh Knowledge instance for the corpus.

    Raises:
        KnowledgeConfigError: ``KNOWLEDGE_EMBEDDER`` is malformed — use-time,
            operator-readable, and never echoed back verbatim.
    """
    config = parse_embedder_config()
    embedder = _provider_embedder(config.provider, config.model, api_key)
    return build_knowledge(component_id, db, embedder, db_url=db_url, name=name)


def pgvector_available(db_url: Optional[str] = None, connect_timeout: int = 5) -> bool:
    """The capability probe behind ``GET /platform/knowledge/config``'s ``enabled``.

    True when the Postgres is reachable AND the pgvector extension is
    AVAILABLE (``pg_available_extensions`` — the extension is loaded lazily by
    ``PgVector.create()`` at first use, so before any upload it is available-
    but-not-installed; probing ``pg_extension`` instead would report a healthy
    fresh deployment as disabled and permanently hide the capability).

    Args:
        db_url: The DSN to probe (defaults to ``DATABASE_URL``).
        connect_timeout: The libpq connect timeout in seconds — the probe runs
            per capability request and must fail fast on an unreachable host.

    Returns:
        True when knowledge storage is usable, False otherwise (unreachable
        Postgres, missing extension, missing DSN). Never raises: the probe
        feeds a boolean capability signal, and a probe exception IS the
        answer "not available".
    """
    import psycopg

    url = db_url or os.environ.get("DATABASE_URL")
    if not url:
        return False
    try:
        with psycopg.connect(url, connect_timeout=connect_timeout) as conn:
            row = conn.execute(
                "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'"
            ).fetchone()
            return bool(row and row[0])
    except Exception as e:
        log_warning(f"knowledge: pgvector capability probe failed: {type(e).__name__}")
        return False


def embedder_importable() -> bool:
    """Whether the configured embedder's module is importable on this deployment.

    Part of the capability signal (``enabled = pgvector_available() AND this``).
    agno and the OpenAI SDK are hard dependencies today, so this is belt-and-
    braces — but it is the spec'd contract: the capability endpoint must be
    the single source of the distinction between "knowledge disabled" and
    "knowledge would work if the deployment had its dependency".

    Returns:
        True when the v1 embedder module imports cleanly, False otherwise.
    """
    try:
        # The import IS the probe: agno and the OpenAI SDK are hard deps today,
        # so this is belt-and-braces — but the spec'd contract is that the
        # capability endpoint is the single source of "knowledge would work if
        # the deployment had its dependency".
        import agno.knowledge.embedder.openai

        return True
    except Exception as e:  # pragma: no cover — hard deps make this unreachable today
        log_warning(f"knowledge: embedder module not importable: {type(e).__name__}")
        return False

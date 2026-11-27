"""The knowledge store: parse, round-trip, and the isolation behavior contract (#233).

The isolation tests pin BEHAVIOR, not implementation: chunks inserted through
one corpus's named Knowledge instance are invisible to another corpus's search
(sync AND async paths), invisible in its content list, and survive its
deletes. If a future agno upgrade changes the stamping/filtering mechanics,
these tests fail loudly — the isolation property is contractual.

No network: every embedding goes through ``FakeEmbedder`` (deterministic
token-bucket vectors — see knowledge_test_helpers), against the real pgvector
testcontainer.
"""
import pytest

from agno.knowledge.content import Content, ContentStatus, FileData
from agno.os.routers.knowledge.knowledge import process_content
from agno.utils.string import generate_id

import knowledge as knowledge_store
from knowledge_test_helpers import FakeEmbedder, build_fake_knowledge

# Distinct vocabularies for the two corpora — verified to hash into disjoint
# buckets (FakeEmbedder, dims=256), so retrieval assertions are exact.
BANANA_DOC = "The banana harvest ripens in the orchard every summer."
ROCKET_DOC = "The rocket propellant feeds the engine during launch orbit."


def _stamped_content(knowledge, name: str, text: str) -> Content:
    """Build an upload's Content exactly like the upload route does.

    Corpus-stamped metadata (corpus-unique content ids — the shared-table
    collision fix), hash + id pinned before processing, shared-bucket owner.

    Args:
        knowledge: The corpus's Knowledge instance (its name is stamped).
        name: The content's display name.
        text: The pasted text payload.

    Returns:
        The ready-to-process Content.
    """
    content = Content(
        name=name,
        metadata=knowledge_store.corpus_stamp(knowledge.name),
        file_data=FileData(content=text.encode("utf-8"), type="manual"),
        size=len(text.encode("utf-8")),
        user_id=None,
    )
    content.content_hash = knowledge._build_content_hash(content)
    content.id = generate_id(content.content_hash)
    return content


# -- embedder config parse ---------------------------------------------------


def test_parse_embedder_config_defaults_when_unset():
    """Unset or empty KNOWLEDGE_EMBEDDER falls back to the platform default —
    an operator who configures nothing gets the default embedder, not a broken deployment."""
    assert knowledge_store.parse_embedder_config({}) == knowledge_store.DEFAULT_EMBEDDER
    assert knowledge_store.parse_embedder_config({knowledge_store.EMBEDDER_ENV_VAR: ""}) == (
        knowledge_store.DEFAULT_EMBEDDER
    )
    assert knowledge_store.parse_embedder_config({knowledge_store.EMBEDDER_ENV_VAR: "  "}) == (
        knowledge_store.DEFAULT_EMBEDDER
    )
    assert knowledge_store.DEFAULT_EMBEDDER.provider == "openai"
    assert knowledge_store.DEFAULT_EMBEDDER.model == "text-embedding-3-small"


def test_parse_embedder_config_parses_provider_and_model():
    """The '<provider>:<model>' grammar parses; provider matching is case-insensitive."""
    config = knowledge_store.parse_embedder_config({knowledge_store.EMBEDDER_ENV_VAR: "openai:text-embedding-3-large"})
    assert (config.provider, config.model) == ("openai", "text-embedding-3-large")
    config = knowledge_store.parse_embedder_config({knowledge_store.EMBEDDER_ENV_VAR: " OpenAI : text-embedding-3-small "})
    assert (config.provider, config.model) == ("openai", "text-embedding-3-small")


def test_parse_embedder_config_fails_closed_on_malformed_values():
    """A malformed value raises KnowledgeConfigError (a ValueError) AT USE TIME with an
    operator-readable message that does NOT echo the configured value (the message
    reaches browsers through tackui's proxy — a misconfigured env value could hold a pasted
    secret). Secret-shaped bad values: a leak means the error text would carry a credential."""
    for bad in ("sk-pasted-secret", "sk-pasted-secret:", ":sk-model-part", "cohere:embed-english"):
        with pytest.raises(knowledge_store.KnowledgeConfigError) as excinfo:
            knowledge_store.parse_embedder_config({knowledge_store.EMBEDDER_ENV_VAR: bad})
        message = str(excinfo.value)
        assert "KNOWLEDGE_EMBEDDER" in message, bad
        assert bad not in message, f"the raw env value must not be echoed: {bad}"
        assert "sk-pasted-secret" not in message and "cohere" not in message


def test_parse_embedder_error_is_a_valueerror():
    """KnowledgeConfigError IS a ValueError — callers catching the builtin stay correct."""
    with pytest.raises(ValueError):
        knowledge_store.parse_embedder_config({knowledge_store.EMBEDDER_ENV_VAR: "garbage"})


def test_corpus_stamp_round_trip():
    """The corpus stamp rides the Content metadata and reads back — and two corpora
    stamp differently, which is what makes their content hashes (and ids) corpus-unique."""
    stamp_a = knowledge_store.corpus_stamp("kb-comp-a")
    stamp_b = knowledge_store.corpus_stamp("kb-comp-b")
    assert knowledge_store.corpus_of(dict(stamp_a)) == "kb-comp-a"
    assert knowledge_store.corpus_of(dict(stamp_b)) == "kb-comp-b"
    assert knowledge_store.corpus_of(None) is None
    assert knowledge_store.corpus_of({"unrelated": "metadata"}) is None
    assert stamp_a != stamp_b


# -- upload → status → search round-trip -------------------------------------


def test_url_ingest_is_capped_to_one_page(agno_db, postgres_dsn):
    """The platform URL ingest fetches exactly the submitted page: the
    website reader is capped at max_links=1 (decision recorded in
    Hady-Ahmed/tackui#260 — without it, a single-page site's #anchor nav
    produced one row per fragment and duplicated content crowding
    retrieval). Only the ``website`` key is provided — sitemap/YouTube
    keep agno's factory defaults (auto-detection untouched)."""
    kb = build_fake_knowledge("urlcap-agent", agno_db, postgres_dsn)
    assert set(kb.readers.keys()) == {"website"}
    assert kb.readers["website"].max_links == 1


async def test_upload_process_search_round_trip(agno_db, postgres_dsn):
    """Upload → status processing → completed → exact retrieval — the service's whole
    ingest path (agno's stock process_content) with the fake embedder, no network."""
    kb = build_fake_knowledge("roundtrip-agent", agno_db, postgres_dsn)
    content = _stamped_content(kb, "orchard-notes.txt", BANANA_DOC)
    assert kb.get_content_by_id(content.id) is None  # nothing recorded before processing

    await process_content(kb, content)

    row = kb.get_content_by_id(content.id)
    assert row is not None
    assert row.status == ContentStatus.COMPLETED  # agno's terminal status (the "ready" chip)
    assert row.size == len(BANANA_DOC.encode("utf-8"))
    # Exact retrieval: the banana query ranks the banana chunk first — the
    # same corpus holds nothing else, and a rocket query must not rank a
    # banana chunk as a rocket match (pgvector is top-k with NO default
    # similarity threshold, so a low-similarity hit still returns; the
    # contract is content membership, not emptiness).
    hits = kb.search("banana harvest orchard", max_results=2)
    assert hits, "the corpus's own chunk must be retrievable"
    assert "banana" in hits[0].content
    async_hits = await kb.asearch("banana harvest orchard", max_results=2)
    assert async_hits and "banana" in async_hits[0].content
    # A query about the OTHER vocabulary still searches (no crash) — but its
    # hits are this corpus's own chunks only, never a rocket match.
    hits = kb.search("rocket propellant engine", max_results=2)
    assert all("rocket" not in (h.content or "") for h in hits)


# -- the isolation behavior contract -----------------------------------------


async def _isolate_two_corpora(agno_db, postgres_dsn):
    """Shared setup: corpus A (banana doc) and corpus B (rocket doc) on the one table."""
    kb_a = build_fake_knowledge("iso-agent-a", agno_db, postgres_dsn)
    kb_b = build_fake_knowledge("iso-agent-b", agno_db, postgres_dsn)
    assert kb_a.name == "kb-iso-agent-a" and kb_b.name == "kb-iso-agent-b"
    assert kb_a.isolate_vector_search is True and kb_b.isolate_vector_search is True
    await process_content(kb_a, _stamped_content(kb_a, "a.txt", BANANA_DOC))
    await process_content(kb_b, _stamped_content(kb_b, "b.txt", ROCKET_DOC))
    return kb_a, kb_b


async def test_isolation_sync_search(agno_db, postgres_dsn):
    """SYNC contract: corpus B's search never returns corpus A's chunks — and vice versa.

    pgvector is top-k with no default similarity threshold, so an
    orthogonal query still returns the corpus's OWN chunk; the contract is
    that no hit ever carries foreign content."""
    kb_a, kb_b = await _isolate_two_corpora(agno_db, postgres_dsn)
    a_hits = kb_a.search("banana harvest", max_results=5)
    assert a_hits and "banana" in a_hits[0].content
    b_hits = kb_b.search("banana harvest", max_results=5)
    assert all("banana" not in (h.content or "") for h in b_hits), "corpus B must not see corpus A's chunks"
    b_own = kb_b.search("rocket propellant", max_results=5)
    assert b_own and "rocket" in b_own[0].content
    a_foreign = kb_a.search("rocket propellant", max_results=5)
    assert all("rocket" not in (h.content or "") for h in a_foreign), "corpus A must not see corpus B's chunks"


async def test_isolation_async_search(agno_db, postgres_dsn):
    """ASYNC contract (the dispatcher's run-time path): same isolation through ``asearch``."""
    kb_a, kb_b = await _isolate_two_corpora(agno_db, postgres_dsn)
    a_hits = await kb_a.asearch("banana harvest", max_results=5)
    assert a_hits and "banana" in a_hits[0].content
    b_foreign = await kb_b.asearch("banana harvest", max_results=5)
    assert all("banana" not in (h.content or "") for h in b_foreign)
    b_hits = await kb_b.asearch("rocket propellant", max_results=5)
    assert b_hits and "rocket" in b_hits[0].content
    a_foreign = await kb_a.asearch("rocket propellant", max_results=5)
    assert all("rocket" not in (h.content or "") for h in a_foreign)


async def test_isolation_content_list(agno_db, postgres_dsn):
    """The content list is linked_to-scoped: each corpus lists only its own rows."""
    kb_a, kb_b = await _isolate_two_corpora(agno_db, postgres_dsn)
    list_a = [c.name for c in kb_a.get_content()[0]]
    list_b = [c.name for c in kb_b.get_content()[0]]
    assert list_a == ["a.txt"] and list_b == ["b.txt"]


async def test_isolation_delete(agno_db, postgres_dsn):
    """Deleting through corpus A does not remove corpus B's rows (list OR retrieval)."""
    kb_a, kb_b = await _isolate_two_corpora(agno_db, postgres_dsn)
    a_id = kb_a.get_content()[0][0].id
    assert knowledge_store.corpus_of(kb_a.get_content_by_id(a_id).metadata) == "kb-iso-agent-a"
    assert kb_a.remove_content_by_id(a_id) is True

    assert [c.name for c in kb_a.get_content()[0]] == []
    b_rows = kb_b.get_content()[0]
    assert [c.name for c in b_rows] == ["b.txt"]
    b_hits = kb_b.search("rocket propellant", max_results=5)
    assert b_hits and "rocket" in b_hits[0].content


async def test_identical_content_across_corpora_is_isolated(agno_db, postgres_dsn):
    """The shared-table collision fix: byte-identical uploads (same name, same text) into
    two corpora must NOT collapse onto one content id — the corpus stamp makes the hashes
    corpus-unique, so both corpora ingest their own copy, and deleting A's copy leaves B's
    retrievable. Without the stamp, agno's shared-bucket skip_if_exists + unfiltered
    delete_by_content_id would break exactly this."""
    kb_a = build_fake_knowledge("same-agent-a", agno_db, postgres_dsn)
    kb_b = build_fake_knowledge("same-agent-b", agno_db, postgres_dsn)
    content_a = _stamped_content(kb_a, "shared-notes.txt", "Identical bytes for both corpora.")
    content_b = _stamped_content(kb_b, "shared-notes.txt", "Identical bytes for both corpora.")
    assert content_a.id != content_b.id, "the corpus stamp must make identical uploads' ids differ"

    await process_content(kb_a, content_a)
    await process_content(kb_b, content_b)

    a_hits = kb_a.search("identical bytes corpora", max_results=5)
    b_hits = kb_b.search("identical bytes corpora", max_results=5)
    assert a_hits and b_hits, "both corpora must hold (and retrieve) their own copy"

    assert kb_a.remove_content_by_id(content_a.id) is True
    assert kb_a.get_content()[0] == []
    assert [c.name for c in kb_b.get_content()[0]] == ["shared-notes.txt"]
    assert kb_b.search("identical bytes corpora", max_results=5), "corpus B's copy must survive A's delete"


async def test_shared_bucket_retrieval(agno_db, postgres_dsn):
    """The org-corpus rule: rows inserted UNSCOPED (the service-token path — user_id
    None) are retrievable by ANY scoped user's search (pgvector's user scope matches
    ``user_id = X OR user_id IS NULL``), while an owner-stamped row stays that owner's."""
    kb = build_fake_knowledge("bucket-agent", agno_db, postgres_dsn)
    # The service's upload path: unscoped → the shared bucket.
    shared = _stamped_content(kb, "org-doc.txt", BANANA_DOC)
    await process_content(kb, shared)
    # An owner-stamped row (what a future per-user overlay would write).
    await kb.ainsert(text_content=ROCKET_DOC, name="alice-private.txt", user_id="alice")

    # Any runner (here: two different users) retrieves the shared corpus…
    assert kb.search("banana harvest", user_id="runner-1", max_results=5)
    assert (await kb.asearch("banana harvest", user_id="runner-2", max_results=5))
    # …but alice's private row is wall-to-wall for SCOPED callers: only alice's
    # own scope sees it (bob's candidates are the shared doc only — pgvector is
    # top-k with no threshold, so the assertion is content membership, not emptiness).
    assert kb.search("rocket propellant", user_id="alice", max_results=5)
    bob_hits = kb.search("rocket propellant", user_id="bob", max_results=5)
    assert all("rocket" not in (h.content or "") for h in bob_hits)
    # …and the unscoped caller sees everything — alice's row included: agno's
    # documented semantic for user_id=None is "searches everything" (the run
    # half runs service-scoped/unscoped on org corpora by design; per-user
    # overlays at run time are a follow-up concern, not this store's contract).
    assert kb.search("banana harvest", user_id=None, max_results=5)
    assert kb.search("rocket propellant", user_id=None, max_results=5)


# -- capability probe ---------------------------------------------------------


def test_pgvector_available_against_the_container(postgres_dsn):
    """The capability probe is TRUE against the pgvector container (the extension is
    available even before first use — the probe reads pg_available_extensions, because
    ``CREATE EXTENSION`` runs lazily at first table creation)."""
    assert knowledge_store.pgvector_available(postgres_dsn) is True


def test_pgvector_available_false_when_unreachable():
    """An unreachable Postgres probes FALSE — never raises: the probe feeds a boolean
    capability signal (the config endpoint answers enabled=false, not a 500)."""
    assert (
        knowledge_store.pgvector_available(
            "postgresql://nobody:nope@127.0.0.1:1/void", connect_timeout=1
        )
        is False
    )


def test_pgvector_available_false_when_the_extension_is_missing(postgres_dsn, monkeypatch):
    """A REACHABLE Postgres without the pgvector extension also probes false — the
    reachable-but-unsupported deployment (a plain postgres image) must not advertise
    the capability. Proved against the real container by pretending the extension is
    absent: the probe's query is stubbed at the connection level."""
    import psycopg

    class NoVectorCursor:
        """A cursor whose pg_available_extensions query answers empty."""

        def __init__(self, inner):
            self._inner = inner

        def execute(self, query, *args, **kwargs):
            if "pg_available_extensions" in query:
                self._result = [(0,)]
            else:
                self._result = self._inner.execute(query, *args, **kwargs).fetchall()
            return self

        def fetchone(self):
            return self._result[0] if self._result else None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class NoVectorConn:
        """A connection wrapper answering the probe's query with 'extension absent'."""

        def __init__(self, inner):
            self._inner = inner

        def execute(self, query, *args, **kwargs):
            return NoVectorCursor(self._inner).execute(query, *args, **kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self._inner.close()
            return False

    real_connect = psycopg.connect

    def fake_connect(*args, **kwargs):
        return NoVectorConn(real_connect(*args, **kwargs))

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    assert knowledge_store.pgvector_available(postgres_dsn) is False

"""The knowledge routes (/platform/knowledge/*) — validation, capability, authz, lifecycle.

Posture pinned here: admin/service-token scope only (tackui proxies; a user
token is 403, anonymous is 401 — the full route inventory is additionally
pinned in test_auth_lockdown.py), the capability signal never errors, upload
validation is fail-closed (BYOK key required, format allowlist, size cap,
URL shape, chunk params), deletes are idempotent with foreign-corpus ids
answered 404, and the optional chunk params demonstrably reach the actual
chunking — the stored chunk boundaries are pinned, not just the validation.

The upload lifecycle test runs the REAL route → background-task → agno
processing flow against the pgvector container, with the fake embedder
substituted at the provider-dispatch seam (``knowledge._provider_embedder``) —
no network (#233). Everything else about the construction is the real
``build_knowledge_for`` (env parse, shared table, isolation flag).
"""
import time

import pytest

from agno.knowledge.content import ContentStatus

import knowledge as knowledge_store
from knowledge_test_helpers import FakeEmbedder, RejectingEmbedder, build_fake_knowledge

from platform_test_helpers import admin_headers, user_headers


@pytest.fixture
def offline_embedder(monkeypatch):
    """Swap the provider-dispatch seam for the deterministic fake embedder.

    The ambient ``KNOWLEDGE_EMBEDDER`` is scrubbed suite-wide (conftest's
    ``hermetic_embedder_env``): ``build_knowledge_for`` parses the env BEFORE
    dispatching to this seam, so the parse must read the platform default —
    a malformed developer-shell export must not 503 these tests (#240).

    Args:
        monkeypatch: pytest's patcher (restores the seam after the test).

    Returns:
        The seam name patched, for test readability.
    """
    monkeypatch.setattr(
        knowledge_store,
        "_provider_embedder",
        lambda provider, model, api_key: FakeEmbedder(),
    )
    return knowledge_store


# -- capability endpoint ------------------------------------------------------


def test_capability_endpoint_reports_enabled(client):
    """pgvector up + embedder importable + default env → enabled, with the config echoed."""
    res = client.get("/platform/knowledge/config", headers=admin_headers())
    assert res.status_code == 200
    body = res.json()
    assert body == {"enabled": True, "provider": "openai", "model": "text-embedding-3-small"}


def test_capability_endpoint_serves_config_not_a_corpus(client):
    """Route-order pin: /config must answer the capability payload, never be swallowed
    by the dynamic GET /{component_id} route (FastAPI matches in registration order)."""
    res = client.get("/platform/knowledge/config", headers=admin_headers())
    assert res.status_code == 200
    assert set(res.json().keys()) == {"enabled", "provider", "model"}


def test_capability_endpoint_with_a_custom_embedder_env(client, monkeypatch):
    """The provider/model fields echo the configured embedder — the credential contract
    tackui derives (openai → openai_api_key) follows this field."""
    monkeypatch.setenv("KNOWLEDGE_EMBEDDER", "openai:text-embedding-3-large")
    body = client.get("/platform/knowledge/config", headers=admin_headers()).json()
    assert body["enabled"] is True
    assert body == {"enabled": True, "provider": "openai", "model": "text-embedding-3-large"}


def test_capability_endpoint_on_malformed_embedder_env(client, monkeypatch):
    """A malformed KNOWLEDGE_EMBEDDER must NOT crash boot or the endpoint: enabled=false,
    provider/model EMPTY (the configured value is never echoed — the payload reaches
    browsers through tackui's proxy)."""
    monkeypatch.setenv("KNOWLEDGE_EMBEDDER", "openai-no-colon")
    body = client.get("/platform/knowledge/config", headers=admin_headers()).json()
    assert body == {"enabled": False, "provider": "", "model": ""}


# -- authz: the routes are service-token scope only ---------------------------


def test_user_token_is_403_on_every_knowledge_route(client):
    """User-scope tokens never talk to this service — tackui proxies everything with
    its service token (same posture as the catalog admin API)."""
    h = user_headers()
    assert client.get("/platform/knowledge/config", headers=h).status_code == 403
    assert client.get("/platform/knowledge/some-component", headers=h).status_code == 403
    assert client.post("/platform/knowledge/some-component/content", headers=h).status_code == 403
    assert client.delete(
        "/platform/knowledge/some-component/content/whatever", headers=h
    ).status_code == 403


def test_anonymous_is_401_on_every_knowledge_route(client):
    """No token → 401 on all four routes (the middleware answers before any handler)."""
    assert client.get("/platform/knowledge/config").status_code == 401
    assert client.get("/platform/knowledge/some-component").status_code == 401
    assert client.post("/platform/knowledge/some-component/content").status_code == 401
    assert client.delete("/platform/knowledge/some-component/content/whatever").status_code == 401


# -- upload validation --------------------------------------------------------


def _post_text(client, component_id="route-agent", text="hello world", **form):
    """POST one text upload with standard admin auth.

    Args:
        client: The TestClient fixture.
        component_id: The corpus's component id.
        text: The pasted text.
        **form: Extra form fields (embedding_key, name, chunk params...).

    Returns:
        The response.
    """
    form.setdefault("embedding_key", "sk-test-creator-key")
    return client.post(
        f"/platform/knowledge/{component_id}/content",
        headers=admin_headers(),
        data={"text_content": text, **form},
    )


def test_upload_requires_an_embedding_key(client):
    """BYOK, fail-closed: no creator key → 400 naming the field — never a silent
    platform-key spend (no env fallback exists for the embedder)."""
    res = client.post(
        "/platform/knowledge/route-agent/content",
        headers=admin_headers(),
        data={"text_content": "hello"},
    )
    assert res.status_code == 400
    assert "embedding_key" in res.json()["detail"]


def test_upload_requires_exactly_one_source(client):
    """Zero sources → 400; two sources → 400 (clean rejection, not silent precedence)."""
    res = client.post(
        "/platform/knowledge/route-agent/content", headers=admin_headers(), data={"embedding_key": "k"}
    )
    assert res.status_code == 400
    res = client.post(
        "/platform/knowledge/route-agent/content",
        headers=admin_headers(),
        data={"embedding_key": "k", "text_content": "hi", "url": "https://example.test/doc"},
    )
    assert res.status_code == 400


def test_upload_rejects_unknown_file_formats_with_the_allowlist(client):
    """The format allowlist: a binary extension is a clean 400 LISTING the accepted
    formats — agno's own fallback (plain-text reader on unknown extensions) would
    ingest garbage chunks instead of rejecting."""
    res = client.post(
        "/platform/knowledge/route-agent/content",
        headers=admin_headers(),
        data={"embedding_key": "k"},
        files={"file": ("malware.exe", b"MZ\x90\x00", "application/octet-stream")},
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    for fmt in (".pdf", ".csv", ".xlsx", ".xls", ".docx", ".pptx", ".json", ".md", ".txt"):
        assert fmt in detail, fmt


def test_upload_rejects_legacy_doc_files(client):
    """Legacy binary .doc is NOT an accepted format: agno maps the extension to
    DocxReader, which parses the modern OOXML .docx container — a genuine .doc
    passed the allowlist and then reliably produced a FAILED row on a
    python-docx parse error (#238). Rejected at the route instead: a clean 400
    naming the accepted formats."""
    res = client.post(
        "/platform/knowledge/route-agent/content",
        headers=admin_headers(),
        data={"embedding_key": "k"},
        files={"file": ("legacy.doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "application/msword")},
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "'.doc'" in detail
    for fmt in (".docx", ".pdf", ".txt"):
        assert fmt in detail, fmt


def test_upload_rejects_files_over_10mb(client):
    """The size cap: >10 MB per file is a 400 — cheap hygiene, checked before embedding."""
    big = b"x" * (10 * 1024 * 1024 + 1)
    res = client.post(
        "/platform/knowledge/route-agent/content",
        headers=admin_headers(),
        data={"embedding_key": "k"},
        files={"file": ("big.txt", big, "text/plain")},
    )
    assert res.status_code == 400
    assert "10 MB" in res.json()["detail"]


def test_upload_rejects_text_over_10mb(client):
    """Pasted text is bounded by the same request cap (agno truncates nothing)."""
    res = _post_text(client, text="x" * (10 * 1024 * 1024 + 1))
    assert res.status_code == 400


def test_upload_rejects_malformed_urls(client):
    """URL ingest is shape-checked only (the SSRF decision is tackui's client-side
    guard): non-absolute or non-http(s) URLs are a 400."""
    for bad in ("not a url", "ftp://example.test/doc", "//example.test/doc"):
        res = client.post(
            "/platform/knowledge/route-agent/content",
            headers=admin_headers(),
            data={"embedding_key": "k", "url": bad},
        )
        assert res.status_code == 400, bad


def test_upload_rejects_an_over_long_name(client, offline_embedder):
    """The optional display name is bounded (#241): it lands verbatim in the
    contents row and feeds the content-hash input, so a multi-MB name is a
    clean 400 — symmetric with the other request-shape validations. Exactly
    at the cap is accepted: a cap, not a ban."""
    res = _post_text(client, name="x" * 301)
    assert res.status_code == 400
    assert "300" in res.json()["detail"]
    res = _post_text(client, component_id="name-cap-boundary", name="x" * 300, text="The rye harvest ripens.")
    assert res.status_code == 202
    assert res.json()["name"] == "x" * 300


def test_upload_rejects_invalid_chunk_params(client):
    """Chunk params are validated at the route (agno would only fail the whole ingest
    later — a FAILED row instead of a clean 400)."""
    res = _post_text(client, chunk_size=0)
    assert res.status_code == 400
    res = _post_text(client, chunk_size=100, chunk_overlap=100)
    assert res.status_code == 400
    res = _post_text(client, chunk_overlap=-1)
    assert res.status_code == 400


def test_upload_on_malformed_embedder_env_is_a_clean_use_time_error(client, monkeypatch):
    """Malformed KNOWLEDGE_EMBEDDER fails AT USE TIME on the affected route — a clean
    503 with an operator-readable message (never a boot crash, never a 500 stack)."""
    monkeypatch.setenv("KNOWLEDGE_EMBEDDER", "garbage-without-colon")
    res = _post_text(client)
    assert res.status_code == 503
    assert "KNOWLEDGE_EMBEDDER" in res.json()["detail"]
    # The key-free paths fail the same way (the vector column's dimensions come
    # from the parsed embedder — there is no key-free bypass of a broken env).
    assert client.get("/platform/knowledge/route-agent", headers=admin_headers()).status_code == 503


def test_persistent_construction_failure_is_a_clean_503_on_every_route(client, monkeypatch):
    """A construction failure that is NOT an OperationalError (a reachable store whose
    first-use table creation failed persistently — a missing pgvector extension,
    permission denied; the cold-start duplicate-table race is absorbed upstream by
    the build layer's one retry) answers a clean 503 on EVERY management route,
    never a raw 500 — the dispatcher-aligned degrade posture (#243)."""
    def failing_construction(component_id, db, api_key=None, *, db_url=None, name=None):
        """The sibling DBAPI failure (the shape the dispatcher also degrades on)."""
        raise RuntimeError("simulated persistent CREATE TABLE failure")

    monkeypatch.setattr(knowledge_store, "build_knowledge_for", failing_construction)
    listed = client.get("/platform/knowledge/route-agent", headers=admin_headers())
    assert listed.status_code == 503
    assert listed.json()["detail"] == "knowledge storage failed to initialize"
    upload = _post_text(client, text="The rye harvest ripens.")
    assert upload.status_code == 503
    assert upload.json()["detail"] == "knowledge storage failed to initialize"
    deleted = client.delete(
        "/platform/knowledge/route-agent/content/whatever", headers=admin_headers()
    )
    assert deleted.status_code == 503
    assert deleted.json()["detail"] == "knowledge storage failed to initialize"


# -- the full route lifecycle (upload → list → delete) ------------------------


def test_upload_list_delete_lifecycle(client, offline_embedder):
    """The real flow with the fake embedder: 202 processing → the background task
    completes the row → the corpus list shows it → delete → gone. B's corpus is
    untouched throughout (route-level isolation)."""
    # Upload into A.
    res = _post_text(client, component_id="lifecycle-a", text="The banana harvest ripens.", name="Notes")
    assert res.status_code == 202
    body = res.json()
    assert set(body.keys()) == {"id", "name", "status"}
    assert body["name"] == "Notes"
    assert body["status"] == ContentStatus.PROCESSING.value
    content_id = body["id"]

    # Upload into B (the same route machinery; different corpus).
    res_b = _post_text(client, component_id="lifecycle-b", text="The rocket engine launches.", name="Rockets")
    assert res_b.status_code == 202

    # The list is camelCase, corpus-scoped, and the row completed processing
    # (TestClient runs background tasks before the request returns).
    rows = client.get("/platform/knowledge/lifecycle-a", headers=admin_headers()).json()
    assert [r["name"] for r in rows] == ["Notes"]
    row = rows[0]
    assert set(row.keys()) == {"id", "name", "status", "statusMessage", "size", "createdAt", "updatedAt"}
    assert row["id"] == content_id
    assert row["status"] == ContentStatus.COMPLETED.value
    assert row["size"] == len("The banana harvest ripens.".encode("utf-8"))
    assert isinstance(row["createdAt"], int) and row["createdAt"] <= int(time.time()) + 5
    # The completion update may land in a later epoch second than the insert.
    assert isinstance(row["updatedAt"], int) and row["updatedAt"] >= row["createdAt"]
    # Failed/processing rows appear with their chip states — here: B's row is completed too,
    # and the lists do not leak into each other.
    rows_b = client.get("/platform/knowledge/lifecycle-b", headers=admin_headers()).json()
    assert [r["name"] for r in rows_b] == ["Rockets"]
    assert rows_b[0]["status"] == ContentStatus.COMPLETED.value

    # Delete A's row: gone from A; B's corpus untouched.
    res = client.delete(f"/platform/knowledge/lifecycle-a/content/{content_id}", headers=admin_headers())
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert client.get("/platform/knowledge/lifecycle-a", headers=admin_headers()).json() == []
    assert [r["name"] for r in client.get("/platform/knowledge/lifecycle-b", headers=admin_headers()).json()] == [
        "Rockets"
    ]


def test_upload_without_a_name_derives_one(client, offline_embedder):
    """Name derivation mirrors the stock router for file/url; pasted text gets a stable
    display name (agno would otherwise name the row from the first 10 raw chars)."""
    res = _post_text(client, text="some pasted notes")
    assert res.status_code == 202
    assert res.json()["name"] == "Pasted text"
    res = client.post(
        "/platform/knowledge/route-agent/content",
        headers=admin_headers(),
        data={"embedding_key": "k", "url": "https://example.test/docs/handbook"},
    )
    assert res.status_code == 202
    assert res.json()["name"] == "https://example.test/docs/handbook"


def test_list_of_an_empty_corpus_is_an_empty_list(client):
    """An unknown/empty corpus is 200 + [] — NOT a 404: these routes do not verify the
    component exists in the components catalog (tackui owns that truth and gates
    authorship before proxying)."""
    res = client.get("/platform/knowledge/never-seen-component", headers=admin_headers())
    assert res.status_code == 200
    assert res.json() == []


def test_delete_is_idempotent(client, offline_embedder):
    """Unknown content id → still {ok: true} (the connector-registry delete posture:
    the delete IS the state; tackui's flow must not error on an already-gone row)."""
    res = client.delete(
        "/platform/knowledge/some-agent/content/never-existed", headers=admin_headers()
    )
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_delete_of_another_corpus_content_id_is_404(client, offline_embedder):
    """A content id that exists but belongs to ANOTHER corpus is answered 404 — with
    corpus-unique ids this cannot arise from the list endpoint, so it is a confused
    client, and deleting it anyway would strip a foreign corpus's rows."""
    res = _post_text(client, component_id="owner-a", text="The banana harvest ripens.")
    foreign_id = res.json()["id"]
    res = client.delete(f"/platform/knowledge/owner-b/content/{foreign_id}", headers=admin_headers())
    assert res.status_code == 404
    # The foreign row survived.
    rows = client.get("/platform/knowledge/owner-a", headers=admin_headers()).json()
    assert [r["id"] for r in rows] == [foreign_id]


def test_failed_row_carries_the_status_message(client, offline_embedder, monkeypatch):
    """A failed ingest's reason reaches the wire. agno stores the classified
    reason on the contents row (``status_message`` — the live-demo case: an
    expired key surfaced as 'authentication (HTTP 401) ... Check the
    embedder's API key and permissions'); the list entry serializes it so the
    author's UI can say WHY a row failed instead of a bare failed chip.
    The seam is swapped for an embedder that constructs but raises agno's
    ``EmbeddingError`` at embed time (status 401 → reason ``authentication``)
    — the exact class the real provider embedder raises, so this pins the
    classified path, not the generic upsert-failure fallback."""
    monkeypatch.setattr(
        knowledge_store, "_provider_embedder", lambda p, m, k: RejectingEmbedder()
    )
    res = _post_text(client, component_id="failmsg", text="The oat harvest ripens.")
    assert res.status_code == 202
    rows = client.get("/platform/knowledge/failmsg", headers=admin_headers()).json()
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    message = rows[0]["statusMessage"]
    assert message, "the classified reason must reach the wire"
    # The classified composition (reason + recovery hint), not a generic
    # "Could not upsert embedding" fallback — agno derives both from the
    # EmbeddingError's status code.
    assert "Reason: authentication (HTTP 401)." in message
    assert "Check the embedder's API key and permissions." in message


def test_completed_row_has_a_null_status_message(client, offline_embedder):
    """The failure-reason field is null on a healthy row — the UI's failed
    branch keys on status, but the wire shape stays uniform."""
    res = _post_text(client, component_id="okmsg", text="The barley harvest ripens.")
    assert res.status_code == 202
    rows = client.get("/platform/knowledge/okmsg", headers=admin_headers()).json()
    assert len(rows) == 1
    assert rows[0]["status"] == "completed"
    assert rows[0]["statusMessage"] is None


# -- chunk params reach the actual chunking (#239) ------------------------------
#
# The upload route accepts optional chunk_size/chunk_overlap and validates
# them, but validation alone cannot see a WIRING regression: if the params
# were dropped between the route and agno's ``process_content``, every upload
# would silently chunk at agno's default (FixedSizeChunking(chunk_size=5000))
# while all the 400-pinning tests stayed green. These tests upload a long,
# deterministic text through the REAL route → background task → processing
# flow and read the STORED chunks back (the contents row is one-per-upload —
# the chunks live only in the shared vector table), so the observable is the
# actual chunk boundaries, not echoed params or a stubbed strategy.
#
# The chunking semantics these assertions rely on (verified against agno
# 3.1.12's FixedSizeChunker, the route's DEFAULT_CHUNKER): it is
# CHARACTER-based; each chunk's end walks BACK to the nearest whitespace
# before the requested size (a word-boundary snap — it never splits a word),
# and the next chunk starts ``overlap`` characters before the previous end.
# The pinned text is 100 fixed-width ``wNNN`` tokens joined by single spaces
# (499 chars): every boundary lands on a space, so at chunk_size=20 the
# chunks are 19 or 20 chars — 25 of them, tiling the text contiguously at
# overlap=0 — and at chunk_size=60 there are 9. A dropped param yields ONE
# 499-char chunk instead, so every assertion below fails loudly.
CHUNK_PARAMS_TEXT = " ".join(f"w{i:03d}" for i in range(100))  # 499 chars


def _stored_chunks(client, offline_embedder, agno_db, postgres_dsn, component_id, **form):
    """Upload the pinned text through the real route, then read the corpus's stored chunks.

    The search-side corpus (``build_fake_knowledge`` — the same ``kb-<component_id>``
    name, so the same shared table and stamp) reads back what the route's own
    instance wrote. Vector search ranks by similarity, not position, so the
    hits are re-ordered by the chunker's own chunk number.

    Args:
        client: The TestClient fixture.
        offline_embedder: The provider-seam fixture (the route embeds with the fake).
        agno_db: The contents-db fixture for the search-side corpus.
        postgres_dsn: The container DSN (the search-side corpus's vector store).
        component_id: The corpus's component id.
        **form: Extra form fields (chunk_size, chunk_overlap...).

    Returns:
        The stored chunks, ordered by chunk number.
    """
    res = _post_text(client, component_id=component_id, text=CHUNK_PARAMS_TEXT, **form)
    assert res.status_code == 202
    rows = client.get(f"/platform/knowledge/{component_id}", headers=admin_headers()).json()
    assert rows and rows[0]["status"] == ContentStatus.COMPLETED.value, rows
    corpus = build_fake_knowledge(component_id, agno_db, postgres_dsn)
    hits = corpus.search("w000 w001 w002", max_results=100)
    return sorted(hits, key=lambda doc: doc.meta_data.get("chunk", 0))


def test_chunk_params_take_effect_on_the_stored_chunks(client, offline_embedder, agno_db, postgres_dsn):
    """chunk_size/chunk_overlap actually shape the stored chunks (#239).

    Pinned here, per requested shape: the exact chunk counts (25 at size 20,
    9 at size 60 — and the count DIFFERENTIAL between the two uploads of the
    same text kills a silently-ignored-params regression on its own), every
    chunk within its requested size cap, the chunk numbers arriving intact
    in generation order, contiguous tiling of the source at overlap=0 (the
    19-char head chunk reflects the word-boundary snap: the 20th char would
    split ``w004``, so the end walks back to the space at index 19), and at
    overlap=5 consecutive chunks sharing exactly the 5-char seam.

    The fake embedder is irrelevant to the boundaries — chunking happens in
    the reader before any embedding — which is precisely why the observation
    is a wiring check: nothing here can be satisfied by a stubbed strategy.
    """
    small = _stored_chunks(
        client, offline_embedder, agno_db, postgres_dsn, "chunksize-20", chunk_size=20, chunk_overlap=0
    )
    large = _stored_chunks(
        client, offline_embedder, agno_db, postgres_dsn, "chunksize-60", chunk_size=60, chunk_overlap=0
    )
    overlapped = _stored_chunks(
        client, offline_embedder, agno_db, postgres_dsn, "chunksize-20-5", chunk_size=20, chunk_overlap=5
    )

    # Same text, different requested sizes → different chunk counts, each the
    # exact boundary math (19/20-char tiles at size 20; 9 chunks at size 60).
    assert [len(chunk.content) for chunk in small] == [19] + [20] * 24
    assert len(large) == 9
    assert len(small) != len(large)

    # Every stored chunk respects its requested size cap (a dropped param
    # produces ONE 499-char chunk — over both caps).
    assert all(len(chunk.content) <= 20 for chunk in small)
    assert all(len(chunk.content) <= 60 for chunk in large)
    assert all(len(chunk.content) <= 20 for chunk in overlapped)

    # The chunk numbers survive into the vector rows, 1..N in generation order.
    assert [chunk.meta_data.get("chunk") for chunk in small] == list(range(1, 26))

    # At overlap=0 the chunks TILE the source text: contiguous, no gaps, no
    # overlaps — the observed boundaries are exactly the requested geometry.
    assert "".join(chunk.content for chunk in small) == CHUNK_PARAMS_TEXT

    # At overlap=5 consecutive chunks share exactly the 5-char seam (the next
    # chunk starts ``overlap`` chars before the previous one's end).
    for prev, nxt in zip(overlapped, overlapped[1:]):
        assert prev.content[-5:] == nxt.content[:5]

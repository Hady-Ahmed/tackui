"""The knowledge management API — ``/platform/knowledge/*`` (service-token scope only).

tackui PROXIES these routes server-side with its service token (the same
posture as the catalog admin API — users never talk to this service directly;
the scope mappings' ``METHOD /*`` catch-alls already enforce admin-only, so a
user-scope token is 403 and an anonymous caller is 401 before any handler
runs). Every route resolves the component's corpus on demand via
:func:`knowledge.build_knowledge_for` — no instance registry, no caching: the
embedder carries a per-call API key (BYOK), and a shared instance would race
keys across concurrent requests.

Routes:

- ``GET  /platform/knowledge/config`` — the capability signal tackui gates the
  builder's Knowledge section on (``{enabled, provider, model}``). Never
  errors: ``enabled=false`` with the config echoed is how tackui distinguishes
  "the service answered, knowledge is off" from "the service is unreachable"
  (a failed fetch — its own rendering path).
- ``GET  /platform/knowledge/{component_id}`` — the corpus's content list
  (camelCase payload, the frontend consumes these directly). Includes
  failed/processing rows — the UI renders status chips.
- ``POST /platform/knowledge/{component_id}/content`` — multipart ingest:
  ``file`` | ``text_content`` | ``url``, plus optional ``name``,
  ``chunk_size``/``chunk_overlap`` (file/text uploads only — URL uploads
  validate but ignore them, agno's URL auto-detection owns the reader and
  its chunking), and the REQUIRED ``embedding_key`` — the
  creator's per-call key. **Never logged, never persisted**: this module must
  not log any request body or form value (a leaked key in a log is the
  incident); processing runs as a background task holding the key only for
  the embedding calls.
- ``DELETE /platform/knowledge/{component_id}/content/{content_id}`` —
  idempotent (mirrors the connector-registry delete posture: an unknown id is
  still ``{ok: true}`` — the delete IS the state, and tackui's delete flow
  must not error on an already-gone row).

A component id is just a string key here: these routes do NOT verify the
component exists in the components catalog — tackui owns that truth and gates
authorship before proxying (the same posture as the catalog's template ids).
"""
import asyncio
import os
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import anyio
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.exc import OperationalError

from agno.knowledge.content import Content, ContentStatus, FileData
from agno.knowledge.reader.reader_factory import ReaderFactory
from agno.os.routers.knowledge.knowledge import process_content
from agno.utils.log import log_error
from agno.utils.string import generate_id

import knowledge as knowledge_store

# Cheap hygiene, not a quota (#233): reject oversized uploads before they are
# buffered or embedded. Applies to file uploads and to pasted text alike —
# agno truncates nothing, so this is the practical request-size bound.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

# Format allowlist: only extensions agno ships a real reader for. agno itself
# silently falls back to the plain-text reader on unknown extensions, which
# turns a binary file into garbage chunks — this service rejects instead of
# ingesting noise. Must stay in lockstep with the reader packages declared in
# pyproject.toml (the agno per-format extras): an accepted extension whose
# reader package is missing would surface only at upload time as a FAILED row.
# Legacy binary .doc is deliberately ABSENT: agno maps it to DocxReader, which
# parses the modern OOXML .docx container, so a genuine .doc passed the
# allowlist and then reliably FAILED on a python-docx parse error (#238) — a
# clean 400 naming the accepted formats instead; re-save legacy .doc as .docx.
ALLOWED_EXTENSIONS = (".pdf", ".csv", ".xlsx", ".xls", ".docx", ".pptx", ".json", ".md", ".txt")

# When the client passes chunk_size/chunk_overlap without naming a chunker,
# agno's stock flow would silently ignore them (its ``process_content`` only
# applies chunk params when a reader is already attached). "FixedSizeChunker"
# is agno's own lazy default strategy (``Reader.chunk_document`` falls back to
# ``FixedSizeChunking(chunk_size=5000)``), so naming it explicitly preserves
# the default strategy while honoring the client's numbers. URL ingestion is
# exempt: a pre-set reader would defeat agno's auto-detection (YouTube/
# sitemap/website), so chunk params apply to file/text uploads only.
DEFAULT_CHUNKER = "FixedSizeChunker"


def _db_url(request: Request) -> str:
    """Resolve the service's Postgres DSN for the vector store.

    Args:
        request: The current request (``build_app`` installs the resolved DSN
            on ``app.state.db_url``).

    Returns:
        The DSN.

    Raises:
        HTTPException: 503 when no DSN is configured (a mis-deployed service —
            knowledge storage cannot work; clean signal, not a stack trace).
    """
    url = getattr(request.app.state, "db_url", None) or os.environ.get("DATABASE_URL")
    if not url:
        raise HTTPException(status_code=503, detail="knowledge storage is not configured (no database DSN)")
    return url


def _contents_db(request: Request):
    """The service's agno PostgresDb — the contents db every corpus reads/writes.

    Args:
        request: The current request.

    Returns:
        The agno db backing the app (components/sessions/contents).

    Raises:
        HTTPException: 503 when the app has no agno db installed.
    """
    agent_os = getattr(request.app.state, "agent_os", None)
    db = getattr(agent_os, "db", None) if agent_os is not None else None
    if db is None:
        raise HTTPException(status_code=503, detail="knowledge storage is not ready")
    return db


def _knowledge_for(request: Request, component_id: str, api_key: Optional[str]):
    """Build the corpus's Knowledge instance for one request, mapping config/storage failures.

    Fresh per call (see :mod:`knowledge`). Sync routes run on the threadpool so
    the construction round-trip is off-loop there; the async upload route wraps
    THIS helper in ``anyio.to_thread``.

    Args:
        request: The current request.
        component_id: The component whose corpus to resolve.
        api_key: The per-call embedding key (upload), or ``None`` on the
            key-free paths — list/delete never embed, so no key is required
            and none is sent.

    Returns:
        A fresh Knowledge instance.

    Raises:
        HTTPException: 503 with an operator-readable, client-safe detail when
            ``KNOWLEDGE_EMBEDDER`` is malformed or the vector store is
            unreachable. The malformed-env message deliberately does not echo
            the configured value (the detail reaches browsers via tackui).
    """
    try:
        return knowledge_store.build_knowledge_for(
            component_id,
            _contents_db(request),
            api_key,
            db_url=_db_url(request),
        )
    except knowledge_store.KnowledgeConfigError as e:
        log_error(f"knowledge: embedder misconfigured — {e}")
        raise HTTPException(status_code=503, detail=str(e))
    except OperationalError as e:
        log_error(f"knowledge: vector store unreachable: {type(e).__name__}")
        raise HTTPException(status_code=503, detail="knowledge storage is unreachable")


def _capability_payload() -> Dict[str, Any]:
    """The ``{enabled, provider, model}`` capability payload (see the config route).

    Returns:
        The payload. On a malformed ``KNOWLEDGE_EMBEDDER``: ``enabled=false``
        with EMPTY provider/model — the configured value is never echoed (the
        payload reaches browsers through tackui's proxy); the parse error is
        logged server-side instead.
    """
    try:
        config = knowledge_store.parse_embedder_config()
    except knowledge_store.KnowledgeConfigError as e:
        log_error(f"knowledge: embedder misconfigured — {e}")
        return {"enabled": False, "provider": "", "model": ""}
    enabled = knowledge_store.embedder_importable() and knowledge_store.pgvector_available()
    return {"enabled": enabled, "provider": config.provider, "model": config.model}


def _content_entry(content) -> Dict[str, Any]:
    """One content list row in the platform payload convention (camelCase).

    Args:
        content: The agno ``Content`` (from the corpus's linked_to-scoped list).

    Returns:
        ``{id, name, status, statusMessage, size, createdAt, updatedAt}`` —
        epoch-second timestamps (agno-native), ``size`` possibly null,
        ``status`` one of agno's ``ContentStatus`` values
        (``processing``/``completed``/``partial``/``failed``) or null when
        the row predates a status write, and ``statusMessage`` agno's
        classified failure reason (``status_message`` — e.g. "authentication
        (HTTP 401) ... Check the embedder's API key and permissions"),
        null unless the row failed. Shown to the author on the failed row
        in the builder form; contains no credential material.
    """
    return {
        "id": content.id,
        "name": content.name,
        "status": content.status.value if content.status is not None else None,
        "statusMessage": content.status_message or None,
        "size": content.size,
        "createdAt": content.created_at,
        "updatedAt": content.updated_at,
    }


def _process_content_in_background(
    knowledge,
    content: Content,
    chunker: Optional[str],
    chunk_size: Optional[int],
    chunk_overlap: Optional[int],
) -> None:
    """Run agno's stock ``process_content`` OFF the service's event loop.

    agno's readers differ in loop discipline (docx/pptx parse in
    ``asyncio.to_thread``; the PDF reader parses synchronously), so running
    ``process_content`` on the request loop — the stock router's shape — would
    let CPU-heavy PDF/DOCX parsing stall every concurrently streaming run.
    This bridge is a SYNC callable, which Starlette executes via
    ``run_in_threadpool``; inside the worker thread it runs agno's async task
    to completion on its own loop (``asyncio.run``) — the same event-loop
    discipline the dispatcher applies with ``anyio.to_thread``.

    Args:
        knowledge: The corpus's fresh Knowledge instance (owns the per-call embedder).
        content: The upload's ``Content`` (id/hash/metadata already pinned).
        chunker: The chunking strategy name, or ``None`` (agno's own defaults).
        chunk_size: The client's chunk size, or ``None``.
        chunk_overlap: The client's chunk overlap, or ``None``.
    """
    asyncio.run(
        process_content(knowledge, content, chunker=chunker, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    )


def attach_knowledge_routes(app: FastAPI) -> None:
    """Mount the ``/platform/knowledge/*`` routes (service-token scope only).

    Mirrors the ``admin_api.attach_admin_routes`` attach pattern — NOT agno's
    stock knowledge router, which mounts a STATIC instance list at
    construction; these corpora are per-component and dynamic. Registered
    BEFORE the dynamic-corpus route: FastAPI matches in registration order,
    and ``/platform/knowledge/config`` must not be swallowed by
    ``/{component_id}`` (pinned by a test).

    Args:
        app: The FastAPI app (``build_app``'s base app, before agno's mount).
    """

    @app.get("/platform/knowledge/config", name="platform_knowledge_config")
    def get_knowledge_config(request: Request):
        """The capability signal tackui gates the builder's Knowledge section on.

        SYNC def — the pgvector probe is a blocking connect; FastAPI runs it
        on the threadpool (the same discipline as /platform/models). Never
        errors: enabled=false (pgvector unreachable, extension unavailable,
        embedder not importable, or a malformed ``KNOWLEDGE_EMBEDDER``) is
        answered as a normal 200 with the config echoed, so tackui can render
        "the service answered, knowledge is off" differently from "the service
        is unreachable" (its own fetch failure).
        """
        return _capability_payload()

    @app.get("/platform/knowledge/{component_id}", name="platform_knowledge_list")
    def get_knowledge_contents(component_id: str, request: Request):
        """The corpus's content list — ``linked_to``-scoped by construction.

        SYNC def — the contents read is a blocking DB round-trip (threadpool,
        same discipline as the config route). The instance is built with
        ``api_key=None``: listing never embeds, so no key is required and none
        is sent. Failed/processing rows are included (the UI renders status
        chips); an unknown/empty corpus is an empty list (200, not 404 — the
        component's existence is tackui's truth to gate).
        """
        knowledge = _knowledge_for(request, component_id, None)
        contents, _count = knowledge.get_content()
        return [_content_entry(c) for c in contents]

    @app.post("/platform/knowledge/{component_id}/content", status_code=202, name="platform_knowledge_upload")
    async def upload_knowledge_content(
        request: Request,
        background_tasks: BackgroundTasks,
        component_id: str,
        file: Optional[UploadFile] = File(None),
        text_content: Optional[str] = Form(None),
        url: Optional[str] = Form(None),
        name: Optional[str] = Form(None),
        chunk_size: Optional[int] = Form(None),
        chunk_overlap: Optional[int] = Form(None),
        embedding_key: Optional[str] = Form(None),
    ):
        """Ingest one document into the component's corpus (async — 202 + id/status).

        The embedding key is the CREATOR's (BYOK, per call): required for every
        ingest, never persisted, never logged — nothing in this module logs a
        form value or request body. Processing runs as a background task
        (agno's stock shape) and holds the key only for the embedding calls.

        Raises:
            HTTPException: 400 for a missing/misshapen request (no source,
                multiple sources, missing key, oversized upload, rejected
                format, malformed URL, invalid chunk params); 503 for
                service-side conditions (misconfigured embedder, unreachable
                storage) via :func:`_knowledge_for`.
        """
        sources = [bool(file), bool(text_content), bool(url and url.strip())]
        if sum(sources) == 0:
            raise HTTPException(status_code=400, detail="Provide a file, text_content, or url to upload.")
        if sum(sources) > 1:
            raise HTTPException(status_code=400, detail="Provide exactly ONE of file, text_content, or url.")
        # BYOK, fail-closed: no key → no embed → no silent platform-key spend.
        # (Checked before any source-specific validation: the 400 names the
        # missing credential first, whatever else is wrong with the request.)
        if not embedding_key or not embedding_key.strip():
            raise HTTPException(
                status_code=400,
                detail="embedding_key is required — uploads are embedded with the creator's own key (BYOK).",
            )
        if chunk_size is not None and chunk_size < 1:
            raise HTTPException(status_code=400, detail="chunk_size must be at least 1.")
        if chunk_overlap is not None and chunk_overlap < 0:
            raise HTTPException(status_code=400, detail="chunk_overlap must be 0 or more.")
        if chunk_size is not None and chunk_overlap is not None and chunk_overlap >= chunk_size:
            raise HTTPException(status_code=400, detail="chunk_overlap must be smaller than chunk_size.")

        read_bytes: Optional[bytes] = None
        display_name = name
        if file is not None:
            # Reject before buffering when the multipart parser reported the
            # size; double-check after the read (a missing report must not
            # bypass the cap).
            if file.size is not None and file.size > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload cap.",
                )
            suffix = Path(file.filename or "").suffix.lower()
            if not suffix:
                raise HTTPException(
                    status_code=400,
                    detail="The uploaded file needs a filename with an extension.",
                )
            if suffix not in ALLOWED_EXTENSIONS:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Unsupported file format '{suffix}' — accepted formats: "
                        f"{', '.join(ALLOWED_EXTENSIONS)}"
                    ),
                )
            read_bytes = await file.read()
            if len(read_bytes) > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload cap.",
                )
            display_name = display_name or file.filename
        elif text_content is not None:
            text_bytes = text_content.encode("utf-8")
            if len(text_bytes) > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Text exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB request cap.",
                )
            read_bytes = text_bytes
            display_name = display_name or "Pasted text"
        else:
            parsed = urlparse(url or "")
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                # Shape only — this service fetches what the client passed; the
                # SSRF decision (private-address refusal) is the CLIENT's guard
                # (tackui runs assertSafeUrl before forwarding — #233's posture).
                raise HTTPException(status_code=400, detail="url must be an absolute http(s) URL")
            display_name = display_name or url

        # Fresh instance per request, off-loop (construction round-trips to the
        # vector store; the upload route is async — same discipline as the
        # dispatcher's to_thread-wrapped construction). The key is stripped
        # here: the blankness check above validates the trimmed value, so the
        # embedder must receive the same one (a pasted trailing newline would
        # otherwise reach the provider and fail auth as a FAILED row).
        knowledge = await anyio.to_thread.run_sync(
            _knowledge_for, request, component_id, embedding_key.strip()
        )

        if file is not None:
            file_data = FileData(
                content=read_bytes,
                type=file.content_type,
                filename=file.filename,
                size=len(read_bytes) if read_bytes is not None else file.size,
            )
        elif text_content is not None:
            file_data = FileData(content=read_bytes, type="manual")
        else:
            file_data = None

        # The corpus stamp makes this content's hash (and therefore its id)
        # corpus-unique — see knowledge.corpus_stamp for the shared-table
        # collisions this closes. user_id=None is the shared bucket by design:
        # these routes are admin-only (tackui's service token), and the org
        # corpus is retrievable by every runner (agno's user scope matches
        # user_id = X OR user_id IS NULL).
        content = Content(
            name=display_name,
            url=url if (file is None and text_content is None) else None,
            metadata=knowledge_store.corpus_stamp(knowledge.name),
            file_data=file_data,
            size=len(read_bytes) if read_bytes is not None else None,
            user_id=None,
        )
        # Pinned BEFORE the background task, exactly like the stock router:
        # the id is the content hash's id — the caller's delete/list handle.
        content.content_hash = knowledge._build_content_hash(content)
        content.id = generate_id(content.content_hash)

        # Chunk params apply to file/text only (a pre-set reader would defeat
        # agno's URL auto-detection — YouTube/sitemap/website readers).
        chunker = None
        if (chunk_size is not None or chunk_overlap is not None) and file_data is not None:
            hint = Path(file.filename or "").suffix.lower() if file is not None else "manual"
            content.reader = ReaderFactory.get_reader_for_extension(hint)
            chunker = DEFAULT_CHUNKER

        background_tasks.add_task(
            _process_content_in_background,
            knowledge,
            content,
            chunker,
            chunk_size,
            chunk_overlap,
        )
        return {
            "id": content.id,
            "name": display_name,
            "status": ContentStatus.PROCESSING.value,
        }

    @app.delete(
        "/platform/knowledge/{component_id}/content/{content_id}",
        name="platform_knowledge_delete",
    )
    def delete_knowledge_content(component_id: str, content_id: str, request: Request):
        """Delete one content row (and its vectors) from the component's corpus.

        SYNC def — blocking DB deletes (threadpool). Idempotent, mirroring the
        connector-registry delete posture: an unknown content id is still
        ``{ok: true}`` — the delete IS the state, and tackui's flow must not
        error on an already-gone row. A content id that EXISTS but belongs to
        ANOTHER corpus is answered 404: with corpus-unique ids this cannot
        happen through the list endpoint, so it is a confused client — and
        deleting it anyway would strip a foreign corpus's rows.
        """
        knowledge = _knowledge_for(request, component_id, None)
        content = knowledge.get_content_by_id(content_id)
        if content is not None and knowledge_store.corpus_of(content.metadata) != knowledge.name:
            raise HTTPException(status_code=404, detail="Content not found in this corpus.")
        if not knowledge.remove_content_by_id(content_id):
            # agno keeps the row (and logs) when the vector delete or a page
            # cascade failed — the row is the retry anchor; answering ok would
            # lie about state the UI shows.
            raise HTTPException(status_code=503, detail="Delete failed — the content row was kept; retry.")
        return {"ok": True}

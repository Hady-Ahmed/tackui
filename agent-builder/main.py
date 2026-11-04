"""platform-os — the shared multi-tenant AgentOS hosting remotely-created agents.

One service hosts ALL user-created agents (no per-agent deploys). The client
frontend is
the policy layer (plans, caps, quotas, credential gates); this service is the
execution layer — it never knows plans exist.

Wiring:

- **Components catalog** (native Agno): agent definitions live as versioned
  configs in this service's db, created/updated via POST/PATCH /components by
  the client's service token. Runs load the current PUBLISHED config.
- **Multi-tenancy**: AuthMiddleware with ``user_isolation=True`` — the JWT
  sub becomes the tenancy wall on sessions/memories (reads scoped, writes
  coerced, ownership enforced on resume/cancel).
- **Per-run credentials**: the run client sends them in the AG-UI context; the
  dispatcher installs them for the stream; runner keys win over the platform
  env keys (see credentials.py).
- **Dynamic AG-UI**: the dispatcher route (dispatcher.py) serves stored
  components — the stock AGUI interface only binds code-defined agents.
"""
import os
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

# Observability — env-driven, no-op when SENTRY_DSN is unset (self-host
# deployments run without it). Initialized BEFORE the app builds so the
# FastAPI integration instruments the whole middleware stack. Traces are
# off: this service's latency lives in provider streaming, not request
# spans, and trace volume on a chat service is mostly noise.
if os.getenv("SENTRY_DSN"):
    import sentry_sdk

    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        environment=os.getenv("SENTRY_ENVIRONMENT", os.getenv("RAILWAY_ENVIRONMENT", "production")),
        traces_sample_rate=0.0,
        send_default_pii=False,
    )

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from agno.db.postgres import PostgresDb
from agno.os import AgentOS
from agno.os.middleware.jwt import AuthMiddleware

from admin_api import attach_admin_routes
from agents_shared.auth import ADMIN_SCOPE, USER_SCOPE, build_scope_mappings
from catalog import CatalogDB
from catalog_state import CatalogState, platform_models_payload, platform_tools_payload
from dispatcher import attach_stored_agent_routes
from discovery import discover


def platform_scope_mappings() -> Dict[str, List[str]]:
    """Scope policy for the platform OS.

    Everything Agno mounts is admin-only (the ``build_scope_mappings`` base +
    method catch-alls). ``POST /agui/*`` is the one user surface: the client's
    user tokens (``app:user``) run stored components. CRUD and session
    inspection stay service/admin-only — the client proxies them with its service
    token; users never talk to this service directly.
    """
    mappings = build_scope_mappings(
        agui_requires_user=True,
        # The dispatcher serves every stored component under /agui/{agent_id}.
        # Pattern overrides are inserted before the ``POST /*`` admin
        # catch-all (first pattern match wins in Agno's scope lookup).
        pattern_overrides={"POST /agui/*": [USER_SCOPE]},
    )
    return mappings


def attach_platform_routes(app: FastAPI) -> None:
    """The builder-facing platform catalog endpoints.

    The client proxies these (server-side, service token): /platform/models
    renders the model picker — every enabled model row is selectable, and
    ``platform_tier`` marks the subset the platform key pays for;
    /platform/tools renders the builder's tool palette and the BYOK provider
    list — each tool carries its credential contract (dep keys, platform
    fallback flag, json-schema parameters) from the catalog. Both payloads
    reflect the current catalog rows and refresh live when the admin edits
    them (revision-counter rebuild, no restart).
    """

    @app.get("/platform/models", name="platform_model_catalog")
    def get_platform_models(request: Request):
        # SYNC def — FastAPI runs it on the threadpool. The old `async def`
        # called the blocking `ensure_current` (a DB round-trip, and under
        # a revision bump a full registry rebuild under the rebuild lock)
        # directly on the event loop: every catalog request paid a blocking
        # Neon round-trip on the loop, and a rebuild stalled EVERY
        # concurrently streaming run for its whole duration.
        state: CatalogState = request.app.state.catalog
        state.ensure_current(request.app.state.agent_os)
        return platform_models_payload(state, os.environ)

    @app.get("/platform/tools", name="platform_tool_catalog")
    def get_platform_tools(request: Request):
        # SYNC def — same rationale as get_platform_models above.
        state: CatalogState = request.app.state.catalog
        state.ensure_current(request.app.state.agent_os)
        return platform_tools_payload(state, os.environ)


def attach_sanitized_validation_errors(app: FastAPI) -> None:
    """Replace FastAPI's default 422 validation body.

    FastAPI/pydantic echo the *submitted value* back in each validation
    error's ``input`` field (plus ``ctx`` internals and pydantic doc URLs).
    The client forwards this service's 4xx detail to the browser (client-fixable
    errors pass through), so a client submitting a bad-typed field carrying a
    secret could see that secret reflected in the validation error. Keep only
    what explains the error — location, message, type — and drop everything
    that echoes the payload.
    """

    @app.exception_handler(RequestValidationError)
    async def sanitized_validation_handler(request, exc: RequestValidationError):
        detail = [
            {"loc": err.get("loc"), "msg": err.get("msg"), "type": err.get("type")}
            for err in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": detail})


def build_app(db_url: Optional[str] = None) -> FastAPI:
    """Build the platform-os FastAPI app (factory so tests can inject a DSN)."""
    jwt_secret = os.getenv("JWT_SECRET")
    if not jwt_secret:
        raise RuntimeError("JWT_SECRET environment variable is required")

    base_app = FastAPI(title="platform-os")
    attach_sanitized_validation_errors(base_app)
    base_app.add_middleware(
        AuthMiddleware,
        verification_keys=[jwt_secret],
        algorithm="HS256",
        excluded_route_paths=["/health"],
        scope_mappings=platform_scope_mappings(),
        admin_scope=ADMIN_SCOPE,
        user_isolation=True,
    )

    # The catalog lives in the same Postgres database as the agno db (its own
    # `public`-schema tables): admin decisions (enabled rows, model
    # ids/attrs) plus a revision counter.
    db_url = db_url or os.getenv("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL environment variable is required")
    catalog_db = CatalogDB(db_url)
    catalog = CatalogState(discover(), catalog_db)
    catalog.refresh()

    # Agno creates its `ai` schema and component/session tables on demand.
    db = PostgresDb(id="platform-os-db", db_url=db_url)

    agent_os = AgentOS(
        id="platform-os",
        description="Shared multi-tenant AgentOS hosting remotely-created agents.",
        agents=[],
        db=db,
        registry=catalog.registry,
        base_app=base_app,
    )

    attach_stored_agent_routes(base_app, agent_os)
    attach_platform_routes(base_app)
    attach_admin_routes(base_app)

    app = agent_os.get_app()
    # Agno's AgentOS unconditionally installs CORSMiddleware with its own
    # default allowlist (localhost:3000, agno.com domains) when no origins
    # are configured — and passing cors_allowed_origins=[] does NOT help:
    # agno's resolve_origins treats an empty list as falsy and falls back
    # to those defaults anyway. This service is private-network-only; its
    # only browser-adjacent client is the run client's own server (which
    # proxies server-to-server), so NO origin may call it cross-origin.
    # Strip the middleware entirely and force the stack to rebuild.
    from starlette.middleware.cors import CORSMiddleware as _CORSMiddleware

    app.user_middleware = [
        m for m in app.user_middleware if m.cls is not _CORSMiddleware
    ]
    app.middleware_stack = None  # rebuilt lazily on first request
    # Expose the OS and the live catalog state to the tests (and any
    # introspection) on the app itself.
    app.state.agent_os = agent_os
    app.state.catalog = catalog
    return app


# No module-level `app = build_app()` — importing this module for any other
# purpose (tooling, scripts, docs generation) must not boot the whole app
# and open database connections. The server entry point below builds the app
# explicitly; tests use the factory seam (`build_app(db_url=...)`).

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        # The app OBJECT, not an import string — an import string
        # ("main:agent_os_app") would require a module-level build, which
        # is exactly the side effect this module avoids (see above).
        build_app(),
        host=os.getenv("AGENT_OS_HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", os.getenv("AGENT_OS_PORT", "7778"))),
    )

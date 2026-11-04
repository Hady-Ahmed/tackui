"""Auth lockdown for the platform-os: only /health is public.

Policy (platform_scope_mappings):
- anonymous -> 401 everywhere except /health
- app:user  -> 200 on POST /agui/{agent_id} (the chat surface), 403 elsewhere
- app:superadmin (frontend service token) -> 200 everywhere
"""
from agents_shared.auth import ADMIN_SCOPE, USER_SCOPE

from platform_test_helpers import admin_headers, user_headers

# Every /platform/* route the app mounts (pinned by
# test_platform_route_inventory_is_pinned below, which re-derives this list
# from the FastAPI app so a new admin route cannot ship unpinned).
PLATFORM_ADMIN_REQUESTS = [
    ("GET", "/platform/available", None),
    ("GET", "/platform/catalog/models", None),
    ("PUT", "/platform/catalog/models", {"providers": []}),
    ("GET", "/platform/catalog/tools", None),
    ("PUT", "/platform/catalog/tools", {"tools": []}),
    ("POST", "/platform/test/model", {"entry": "openai-chat:gpt-4o-mini"}),
    ("GET", "/platform/connectors", None),
    ("PUT", "/platform/connectors/{connector_id}", {"url": "https://mcp.example.test/mcp"}),
    ("DELETE", "/platform/connectors/{connector_id}", None),
    ("GET", "/platform/models", None),
    ("GET", "/platform/tools", None),
]


def test_health_is_public(client):
    assert client.get("/health").status_code == 200


def test_anonymous_gets_401_everywhere(client):
    assert client.get("/agents").status_code == 401
    assert client.post("/components", json={}).status_code == 401
    assert client.post("/agui/some-agent", json={"thread_id": "t", "messages": []}).status_code == 401


def test_anonymous_gets_401_on_every_platform_route(client):
    """The /platform/* admin surface is JWT-protected end to end: with no
    Authorization header the bouncer answers 401 before any route or scope
    logic runs (the bodies here never reach validation)."""
    for method, path, body in PLATFORM_ADMIN_REQUESTS:
        res = client.request(method, path, json=body)
        assert res.status_code == 401, f"{method} {path} -> {res.status_code}"


def test_invalid_token_gets_401_not_403(client):
    """A present-but-invalid token (unverifiable signature) is an
    authentication failure, not an authorization one: 401, same as no token
    at all — the 403 distinction is reserved for valid tokens with
    insufficient scopes (see test_user_token_cannot_touch_crud_or_admin_routes
    and the catalog suite's admin-scope rejection tests)."""
    for method, path, body in PLATFORM_ADMIN_REQUESTS:
        res = client.request(method, path, headers={"Authorization": "Bearer not-a-jwt"}, json=body)
        assert res.status_code == 401, f"{method} {path} -> {res.status_code}"


def test_platform_route_inventory_is_pinned(client, app):
    """Drift guard: every /platform/* route the app actually mounts must be
    covered by PLATFORM_ADMIN_REQUESTS, so a future admin route cannot ship
    without an anonymous-401 pin."""
    pinned = {(method, path) for method, path, _ in PLATFORM_ADMIN_REQUESTS}
    mounted = set()
    for route in app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/platform"):
            for method in route.methods - {"HEAD", "OPTIONS"}:
                mounted.add((method, path))
    assert mounted == pinned, f"unpinned /platform routes: {sorted(mounted - pinned)}"


def test_user_token_cannot_touch_crud_or_admin_routes(client):
    h = user_headers()
    assert client.get("/agents", headers=h).status_code == 403
    assert client.post("/components", headers=h, json={}).status_code == 403
    assert client.get("/components", headers=h).status_code == 403
    assert client.get("/sessions", headers=h).status_code == 403


def test_user_token_reaches_the_dispatcher(client):
    # A valid AG-UI body for a component that does not exist: the auth gate
    # passed (401/403 would fail the test); the route itself answers 404.
    res = client.post(
        "/agui/does-not-exist",
        headers=user_headers(),
        json={"thread_id": "t", "run_id": "r1", "messages": [{"id": "m1", "role": "user", "content": "hi"}], "tools": []},
    )
    assert res.status_code == 404


def test_admin_token_reaches_crud(client):
    res = client.post("/components", headers=admin_headers(), json={"name": "x", "component_type": "agent"})
    assert res.status_code in (200, 201, 422)  # 422 = reached validation, not the auth gate


def test_no_cors_middleware_and_no_acao_header(client, app):
    """The service is private-network-only: its ONLY browser client is the
    run client's own server (which proxies server-to-server), so CORS is
    deliberately absent — no CORSMiddleware is installed and no
    Access-Control-Allow-Origin header is ever emitted, even for requests
    bearing an Origin header. A browser on the public internet must never
    be invited to call this service directly."""
    middleware_classes = [m.cls for m in app.user_middleware]
    assert not any(
        getattr(m, "__name__", str(m)) == "CORSMiddleware" or "CORS" in str(m)
        for m in middleware_classes
    )
    res = client.get(
        "/health", headers={"Origin": "https://evil.example.com"}
    )
    assert res.headers.get("access-control-allow-origin") is None
    # Same for a preflight — no middleware answers it, so it falls through
    # to routing (405/404/401 depending on the path) with no ACAO headers.
    preflight = client.options(
        "/health",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert preflight.headers.get("access-control-allow-origin") is None

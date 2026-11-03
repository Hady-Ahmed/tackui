"""Shared test helpers (token minting, request shaping)."""
from datetime import UTC, datetime, timedelta
from typing import List, Optional

import jwt

from agents_shared.auth import ADMIN_SCOPE, USER_SCOPE

TEST_JWT_SECRET = "test-secret-32-chars-min-please-xx"


def mint_token(scopes: List[str], sub: str = "test-user") -> str:
    return jwt.encode(
        {
            "sub": sub,
            "scopes": scopes,
            "exp": datetime.now(UTC) + timedelta(hours=1),
            "iat": datetime.now(UTC),
        },
        TEST_JWT_SECRET,
        algorithm="HS256",
    )


def admin_headers(sub: str = "admin") -> dict:
    """Service/admin token — what the frontend's backend presents for CRUD."""
    return {"Authorization": f"Bearer {mint_token([ADMIN_SCOPE], sub=sub)}"}


def user_headers(sub: str = "user-1") -> dict:
    """End-user token (app:user) — mirrors what the frontend mints for chatters."""
    return {"Authorization": f"Bearer {mint_token([USER_SCOPE], sub=sub)}"}


def agui_body(
    thread_id: str = "thread-1",
    message: str = "hello",
    context: Optional[List[dict]] = None,
    user_id: Optional[str] = None,
) -> dict:
    """Minimal AG-UI RunAgentInput payload."""
    forwarded = {"user_id": user_id} if user_id else None
    body = {
        "thread_id": thread_id,
        "run_id": "run-1",
        "messages": [{"id": "m1", "role": "user", "content": message}],
        "tools": [],
    }
    if context is not None:
        body["context"] = context
    if forwarded is not None:
        body["forwarded_props"] = forwarded
    return body


def component_payload(
    component_id: str = "test-agent",
    stage: str = "published",
    tools: Optional[list] = None,
    model: Optional[dict] = None,
    connectors: Optional[list] = None,
) -> dict:
    """A POST /components payload for a minimal agent component."""
    config = {
        "id": component_id,
        "name": "Test Agent",
        # Model reference: id + binding name — the registry binds configs by
        # (id, name) so same-id API doors (openai-chat vs openai-responses)
        # resolve to the exact registered instance instead of first-matching
        # on id. The name must be the instance's effective display name (the
        # agno class name unless a name= attr overrides it) or the match
        # fails and agno falls back to a from-dict rebuild.
        "model": model or {"id": "gpt-4o-mini", "name": "OpenAIChat"},
        "instructions": ["Answer concisely."],
        "tools": tools or [],
    }
    if connectors:
        # Mirrors the frontend's builder: connector NAMES in the stored config —
        # the dispatcher's run-time allowlist for wire mcp_connectors.
        config["connectors"] = connectors
    return {
        "name": "Test Agent",
        "component_id": component_id,
        "component_type": "agent",
        "description": "spike test agent",
        "config": config,
        "stage": stage,
        "set_current": True,
    }

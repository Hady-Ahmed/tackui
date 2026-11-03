"""Auth configuration shared by main.py and the test suite.

Centralizing the scope-mappings and excluded-paths here means the lockdown
tests exercise the identical configuration that production runs.

Two token tiers, both HS256-signed with the same ``JWT_SECRET``:

* ``app:superadmin`` — admin (``scripts/mint_token.py``). Bypasses every
  route-level scope check; reaches ``/config``, ``/agents``, ``/sessions``,
  ``/memories``, ``/databases/*/migrate``, and ``/agui``.
* ``app:user`` — end user. Reaches the chat surface ``POST /agui`` only;
  every other route rejects with 403. Only enforced when the agent opts in
  via ``build_scope_mappings(agui_requires_user=True)``.

The signature proves the token wasn't tampered with and was minted by a
``JWT_SECRET`` holder. Scopes are a declaration of intent the minter chose
to put in the payload; the backend enforces that declaration independently.
You trust the minter to mint honestly (it holds the secret); you do NOT
trust the token-bearer to report their own scopes — they can't, the
signature covers the scope claim.

Per-agent public-route policy (each agent picks its preset — both agents
share the same gated policy):

* **islamai** — ``/health`` (Railway liveness) only is public. ``POST
  /agui`` requires ``app:user`` (the frontend mints this for chatters); anonymous
  callers get 401. ``/status`` and every admin route require
  ``app:superadmin``.
* **personal** — same policy: ``/health`` only is public, ``POST /agui``
  requires ``app:user``, admin routes require ``app:superadmin``.
"""
from typing import Dict, List, Optional

from agno.os.scopes import get_default_scope_mappings

# The scope that bypasses every route-level scope check (the master key).
ADMIN_SCOPE = "app:superadmin"

# The scope end-user tokens carry when the agent gates /agui. The frontend mints
# JWTs with this scope so holders can reach the chat surface. Anything
# admin-only (/config, /agents, /sessions, /memories, /databases/*, ...)
# rejects this scope with 403.
USER_SCOPE = "app:user"

# islamai: chat is gated. /health (Railway liveness) only is public.
# POST /agui requires app:user (the frontend mints this for chatters); anonymous
# callers get 401. /status and every admin route require an admin-scoped
# JWT.
ISLAMAI_EXCLUDED_PATHS: List[str] = [
    "/health",
]

# personal: chat is gated. /health (Railway liveness) only is public.
# POST /agui requires app:user (see build_scope_mappings(agui_requires_user=
# True)); anonymous callers get 401. The frontend authenticates via an
# Authorization header.
PERSONAL_EXCLUDED_PATHS: List[str] = [
    "/health",
]


def build_scope_mappings(
    *,
    agui_requires_user: bool = True,
    pattern_overrides: Optional[Dict[str, List[str]]] = None,
) -> Dict[str, List[str]]:
    """Build the scope-mappings dict for an agent.

    Every Agno default route is rewritten to require ``ADMIN_SCOPE``, and
    method-scoped catch-alls ("GET /*", "POST /*", ...) are appended so any
    route Agno mounts that is not in the default set (e.g. /queue,
    /agents/{id}/runs/{id}/resume, future additions) is also locked to
    admin.

    When ``agui_requires_user`` is True (both agents), an exact-match
    override ``POST /agui -> [USER_SCOPE]`` is added. Agno's
    ``get_required_scopes_for_route`` checks exact matches before pattern
    matches (see ``agno/os/scopes.py``), so this wins over the ``POST /*``
    admin catch-all. End users with ``app:user`` chat; admin tokens bypass
    via the admin-scope short-circuit.

    ``pattern_overrides`` adds PATTERN mappings (e.g. "POST /agui/*") that
    must beat the catch-alls. Scope lookup walks the dict in insertion order
    and returns the FIRST pattern match, so these are inserted before the
    catch-alls, never appended after them.

    When False, no override is added — /agui must then be in the agent's
    excluded_route_paths, so the middleware never consults a scope mapping
    for it and anonymous callers reach /agui directly. (The open-chat
    policy islamai used before being published to the frontend's catalog; kept
    as an escape hatch.)

    Net effect with agui_requires_user=True:
      anonymous            -> 401 on every non-excluded route
      app:user  token      -> 200 on POST /agui, 403 everywhere else
      app:superadmin token -> 200 everywhere (admin bypass)
    """
    mappings: Dict[str, List[str]] = {
        key: [ADMIN_SCOPE] for key in get_default_scope_mappings()
    }
    if agui_requires_user:
        # User-tier exception: the chat surface. Exact match wins over the
        # ``POST /*`` catch-all added below.
        mappings["POST /agui"] = [USER_SCOPE]
    # Pattern overrides go BEFORE the catch-alls (first pattern match wins).
    if pattern_overrides:
        mappings.update(pattern_overrides)
    for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        mappings[f"{method} /*"] = [ADMIN_SCOPE]
    return mappings
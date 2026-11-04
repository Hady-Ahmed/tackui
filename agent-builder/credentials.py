"""Per-run credential resolution — the runner's key always wins.

The run client delivers a run's credentials in the AG-UI ``context`` field; the AG-UI
interface turns that into the run's ``dependencies``. This module holds those
credentials for the duration of ONE run and resolves them on demand:

    runner's key (dependencies)  >  platform env key (fallback)

The credentials live in a ContextVar that the streaming generator sets before
the run starts and resets when it ends. They are visible to model client
construction and toolkit calls inside that run's task — and to nothing else.
Nothing is ever written onto the shared registry instances, so concurrent
runs (different users) never see each other's keys.

Dependency keys the run client may send (the wire contract — derived
mechanically, never a fixed provider list):

- ``<provider>_api_key``  — single-key credentials (model keys and
  single-field toolkits): ``openai_api_key``, ``openrouter_api_key``,
  ``tavily_api_key``, … whatever the client's key catalog currently
  derives from the platform.
- ``<provider>_<field>``  — each named field of a multi-credential
  toolkit's contract (e.g. ``x_consumer_key``, ``x_access_token``).
- ``mcp_connectors``      — ``{"<connector-id>": {"token": ...}}``; attach
  URLs resolve ONLY from the platform's connector registry, never the wire.
"""
import os
from contextvars import ContextVar, Token
from typing import Any, Dict, Optional

from agno.utils.log import log_warning

_run_credentials: ContextVar[Optional[Dict[str, Any]]] = ContextVar(
    "platform_os_run_credentials", default=None
)


def set_run_credentials(deps: Optional[Dict[str, Any]]) -> Token:
    """Install a run's credential dict; returns the token for reset_run_credentials."""
    return _run_credentials.set(deps or None)


def reset_run_credentials(token: Token) -> None:
    """Reset the run's credential ContextVar to its pre-``set`` state.

    ``ContextVar.reset`` raises ``ValueError`` when the token was created in
    a DIFFERENT Context than the current one. The reset lives in the streaming
    generator's finally, which during a client disconnect / mid-stream
    cancellation can run in a different task's context copy than the task
    that called ``set_run_credentials`` — the reset must then be a no-op
    (the set context is already gone with that task), not a ValueError
    propagating out of a cleanup finally and masking the original unwind.
    """
    try:
        _run_credentials.reset(token)
    except ValueError:
        # Token belongs to another Context — that context died with its
        # task, so the credential state is already cleaned up.
        pass


def resolve_from_deps(
    deps: Optional[Dict[str, Any]], name: str, fallback_env: Optional[str] = None
) -> Optional[str]:
    """Resolve one credential from an explicit deps dict — the single funnel
    shared by the ContextVar path (:func:`resolve_credential`) and pre-context
    construction (the dispatcher's keyed-toolkit build, which runs before the
    streaming generator installs the run's context).

    A value that is PRESENT but not a string is logged and treated as
    missing: agno's extract_context json-decodes the context, so a numeric
    key sent as ``"12345"`` arrives as the int ``12345`` and would otherwise
    be silently dropped with no trace of why. "Sent but not a string" is
    operator-actionable (the runner delivered a wrong-typed value); "no key"
    is the normal pre-run-gate state and stays silent.
    """
    value = (deps or {}).get(name)
    if value is not None and not isinstance(value, str):
        log_warning(
            f"credentials: '{name}' was sent but is not a string "
            f"(got {type(value).__name__}) — treating as missing; the runner "
            f"likely json-encoded a non-string value"
        )
    if isinstance(value, str) and value.strip():
        return value
    if fallback_env:
        return os.getenv(fallback_env) or None
    return None


def resolve_credential(name: str, fallback_env: Optional[str] = None) -> Optional[str]:
    """Resolve one credential: the runner's key wins, the platform env key is the fallback."""
    return resolve_from_deps(_run_credentials.get(), name, fallback_env)

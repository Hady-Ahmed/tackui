"""The per-run credential ContextVar (credentials.py) — leak discipline.

The dispatcher's streaming generator sets the run's credential dict before
the run starts and resets it in a ``finally`` (so an error unwinding
through the stream — including a mid-stream cancellation — can never leave
the per-run key context installed). These tests pin the primitive that
``finally`` relies on:

- the reset restores the PRIOR value (token semantics — a nested install
  unwinds to exactly what was there before it, not to "None");
- a set inside a child task never leaks back into the spawning context
  (the property that keeps concurrent runs isolated even if one forgot to
  reset);
- the set → error → finally-reset sequence clears the context (the exact
  shape of the dispatcher's generator teardown).
"""

import asyncio

import pytest

from credentials import (
    resolve_credential,
    reset_run_credentials,
    set_run_credentials,
)


def test_reset_restores_the_prior_value_not_none():
    outer = set_run_credentials({"openai_api_key": "sk-outer"})
    inner = set_run_credentials({"tavily_api_key": "tvly-inner"})
    assert resolve_credential("tavily_api_key") == "tvly-inner"

    reset_run_credentials(inner)
    # The inner dict is gone — and the OUTER dict is exactly what is
    # visible again (not None, not merged).
    assert resolve_credential("tavily_api_key") is None
    assert resolve_credential("openai_api_key") == "sk-outer"

    reset_run_credentials(outer)
    assert resolve_credential("openai_api_key") is None


def test_set_none_clears_visibility():
    token = set_run_credentials({"openai_api_key": "sk-run"})
    assert resolve_credential("openai_api_key") == "sk-run"
    reset_run_credentials(token)
    assert resolve_credential("openai_api_key") is None


def test_set_none_literal_installs_nothing():
    set_run_credentials(None)  # deps=None must not crash or poison reads
    assert resolve_credential("openai_api_key") is None


async def test_child_task_sets_never_leak_to_the_parent_context():
    """Each request task runs in its own context copy — the property that
    makes concurrent runs (different users) unable to see each other's
    keys even if a reset were missed."""

    async def run_like_request():
        set_run_credentials({"openai_api_key": "sk-run-a"})
        # Visible inside the run's own context.
        assert resolve_credential("openai_api_key") == "sk-run-a"

    await asyncio.create_task(run_like_request())

    # The parent (the "next request") sees nothing.
    assert resolve_credential("openai_api_key") is None


async def test_error_unwind_with_finally_reset_leaves_nothing_behind():
    """The exact shape of the dispatcher's generator teardown: the reset
    lives in the ``finally`` so a raising stream still unwinds the
    credential context."""
    token = set_run_credentials(
        {"openai_api_key": "sk-run", "mcp_connectors": {"github": {"url": "https://mcp.example.test", "token": "tok"}}}
    )
    with pytest.raises(RuntimeError):
        try:
            raise RuntimeError("stream blew up mid-run")
        finally:
            reset_run_credentials(token)

    assert resolve_credential("openai_api_key") is None


async def test_runner_key_wins_over_the_platform_env_fallback(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-env")
    token = set_run_credentials({"openai_api_key": "sk-runner"})
    try:
        assert resolve_credential("openai_api_key", "OPENAI_API_KEY") == "sk-runner"
    finally:
        reset_run_credentials(token)
    # After the reset the platform env key is what resolves (the fallback).
    assert resolve_credential("openai_api_key", "OPENAI_API_KEY") == "sk-platform-env"


async def test_context_without_the_key_still_falls_back_to_env(monkeypatch):
    """A run that delivers OTHER credentials but not this one falls back to
    the platform env key — an absent key is the normal pre-run-gate state,
    not an error."""
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-platform-env")
    token = set_run_credentials({"openai_api_key": "sk-runner"})
    try:
        assert resolve_credential("tavily_api_key", "TAVILY_API_KEY") == "tvly-platform-env"
    finally:
        reset_run_credentials(token)


@pytest.mark.parametrize("bad", [12345, ["sk-in-list"], {"sk": "dict"}, ""])
async def test_non_string_and_blank_values_are_treated_as_missing(monkeypatch, bad):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-env")
    token = set_run_credentials({"openai_api_key": bad})
    try:
        assert resolve_credential("openai_api_key", "OPENAI_API_KEY") == "sk-platform-env"
        assert resolve_credential("openai_api_key") is None
    finally:
        reset_run_credentials(token)

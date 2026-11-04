"""Dynamic AG-UI dispatch for stored (remotely-created) agent components.

The stock AGUI interface binds ONE code-defined agent at boot. Components
created at runtime via POST /components need a dispatcher instead: this module
mounts ``POST /agui/{agent_id}``, which

1. resolves the caller's identity SERVER-SIDE (JWT sub via the user-scope
   machinery — a client's forwarded ``user_id`` is ignored for authenticated
   callers, exactly like the stock router),
2. loads the component's current PUBLISHED config (drafts are invisible),
3. builds a fresh Agent per run (request isolation — Agno's own pattern),
4. attaches per-run MCP connectors from the run's dependencies — only ids
   the component's stored config declares; anything else is refused,
5. installs keyed-toolkit functions per run: toolkits with a credential
   contract are constructed fresh with the run's resolved keys (runner keys
   win, platform env keys fall back) and their referenced functions are
   appended after rehydration — the shared registry holds only keyless
   toolkits, and
6. streams AG-UI events with the run's credentials installed for the
   duration of the stream (runner keys win, platform env keys fall back).

Deliberate divergence from the stock AG-UI router: dependencies are NOT
appended to the user message (``add_dependencies_to_context`` stays False).
The stock router assumes dependencies are display context for the model;
in this deployment they carry secrets (API keys) that must never enter the
prompt.
"""
import asyncio
import contextlib
import copy
import os
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import anyio

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent, RunStartedEvent, StateSnapshotEvent
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from agno.agent import Agent
from agno.os.interfaces.agui.input import (
    extract_context,
    extract_media,
    extract_tool_messages,
    extract_user_input,
    parse_client_tools,
    validate_state,
)
from agno.os.interfaces.agui.resume import resume_paused_run
from agno.os.interfaces.agui.stream import async_stream_agno_response_as_agui_events
from agno.os.middleware.user_scope import assert_session_writable, caller_is_admin, resolve_run_user_id
from agno.os.app import AgentOS
from agno.run.base import RunContext
from agno.tools.function import Function
from agno.utils.log import log_error, log_warning

from catalog_state import CatalogState
from credentials import resolve_from_deps, reset_run_credentials, set_run_credentials

# Cap for each MCP connector handshake during run attach. A hung endpoint
# (unreachable host, silent drop) must not hold the run start indefinitely —
# the member sees a spinner and the concurrent-run slot stays occupied.
# Overridable for slow internal networks; 20s comfortably covers a healthy
# streamable-HTTP handshake (connect + initialize + tools/list).
# Parsed defensively: a typo'd value ("20s", empty) must fall back to the
# default, not crash the service at import time.
try:
    MCP_ATTACH_TIMEOUT_SECONDS = float(os.environ.get("MCP_ATTACH_TIMEOUT_SECONDS", "20"))
except ValueError:
    MCP_ATTACH_TIMEOUT_SECONDS = 20.0


def plan_per_run_tools(
    config: Dict[str, Any],
    fn_index: Dict[str, Any],
    deps: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], List[Function]]:
    """Split stored-config tools into registry-resolved and per-run-constructed.

    Keyed toolkits (those with a credential contract) are NEVER instantiated
    as shared registry members — a shared toolkit cannot serve many runners'
    different keys. Instead their function references are stripped from the
    stored config before rehydration, and fresh toolkit instances are built
    here with the run's resolved credentials passed to the stock constructor
    (runner key wins per credential, platform env key falls back). A missing
    credential skips that toolkit's functions with a warning — the client's
    pre-run gate is the real guard.

    Config tool references that match no enabled catalog function are also
    stripped (disabling a catalog entry stops existing agents from running
    it). Function-config-shaped dicts (``name`` + ``parameters`` with no
    provider-native markers) are recognized the same way agno's rehydration
    recognizes them, so provider-run tool payloads pass through untouched.

    Returns the config with keyed/unknown tool references removed, plus the
    fresh Function objects to append to the agent after rehydration.
    """
    tools_cfg = config.get("tools")
    if not isinstance(tools_cfg, list) or not tools_cfg:
        return config, []

    def _is_function_config(entry: Any) -> bool:
        # Mirrors agno's Registry._is_function_config: positive serialized
        # Function identification; provider-native dicts pass through.
        return (
            isinstance(entry, dict)
            and "name" in entry
            and "parameters" in entry
            and "type" not in entry
            and "input_schema" not in entry
        )

    keyed_names: set = set()
    unknown_names: set = set()
    for entry in tools_cfg:
        if _is_function_config(entry):
            name = entry.get("name")
            if name in fn_index and fn_index[name].keyed:
                keyed_names.add(name)
            elif name not in fn_index:
                unknown_names.add(name)

    if not keyed_names and not unknown_names:
        return config, []

    def _strip(name: str) -> bool:
        return name in keyed_names or name in unknown_names

    stripped_tools = [
        e for e in tools_cfg if not (_is_function_config(e) and _strip(e.get("name")))
    ]
    stripped_cfg = {**config, "tools": stripped_tools}
    fresh_fns: List[Function] = []
    if keyed_names:
        built: Dict[str, Any] = {}
        for name in (e.get("name") for e in tools_cfg if _is_function_config(e) and e.get("name") in keyed_names):
            entry = fn_index[name]
            toolkit = built.get(entry.module)
            if toolkit is None:
                kwargs: Dict[str, Any] = {}
                missing = False
                for cred in entry.credentials:
                    # Single funnel with credentials.resolve_credential
                    # (runner wins, platform env fallback) — but reading the
                    # deps dict directly: construction happens before the
                    # streaming generator installs the per-run credential
                    # context. A sent-but-not-a-string value (extract_context
                    # json-decodes the context) warns inside the funnel
                    # instead of being silently dropped.
                    value = resolve_from_deps(deps, cred.dep_key, cred.env)
                    if value:
                        kwargs[cred.arg] = value
                    else:
                        missing = True
                if missing:
                    log_warning(
                        f"dispatcher: skipping keyed toolkit '{entry.module}' — a required "
                        f"credential is missing from this run's dependencies"
                    )
                    continue
                try:
                    toolkit = entry.cls(**kwargs)
                except Exception as e:
                    log_warning(
                        f"dispatcher: per-run construction of '{entry.module}' failed "
                        f"({type(e).__name__}: {str(e)[:120]}) — skipping"
                    )
                    continue
                built[entry.module] = toolkit
            fresh = toolkit.get_functions().get(name)
            if fresh is not None:
                fresh_fns.append(fresh)
    if unknown_names:
        log_warning(
            f"dispatcher: stripping tool references absent from the enabled catalog: "
            f"{sorted(unknown_names)} (disabled entries stop existing agents from running them)"
        )
    return stripped_cfg, fresh_fns


class ModelBindingError(Exception):
    """The component's model config does not resolve to a live registry
    instance. Raised BEFORE anything runs — no credentials installed, no
    MCP sessions opened — and surfaced to the client as the AG-UI contract's
    terminal RUN_ERROR with an actionable (member-safe, constant) message.

    Why refuse instead of letting agno's fallback rebuild: agno's
    ``resolve_model`` falls back to ``get_model_from_dict`` when the
    registry misses — a fresh, keyless instance with none of the catalog
    row's attrs, which then resolves its key from THIS deployment's env
    (observed live during the wrapper-cache incident: a run rode the
    platform's OPENAI_API_KEY because the registry binding missed). That
    silently converts a BYOK run into a platform-funded one and drops the
    row's attrs besides. The registry is the single source of servable
    models: the run either uses one of its live instances or does not run.
    """


def _refuse_unresolved_model_binding(agent: Agent, agent_os: AgentOS) -> None:
    """Refuse a run whose resolved model is not a live registry instance.

    Identity (``is``), not equality: a registry hit hands back the exact
    registered wrapper; agno's fallback constructs a DIFFERENT object with
    the same id. Checking identity keeps the guarantee regardless of how
    agno's resolution order evolves.
    """
    model = getattr(agent, "model", None)
    if model is None:
        return
    registry = getattr(agent_os, "registry", None)
    registered = getattr(registry, "models", None) or []
    if any(candidate is model for candidate in registered):
        return
    log_error(
        f"dispatcher: model binding for component '{getattr(agent, 'id', '?')}' "
        f"did not resolve to a registry instance — refusing the run"
    )
    raise ModelBindingError(
        "This agent's model is no longer available on the platform. "
        "Open it in the agent builder and save it again to pick a current model."
    )


def build_agent_for_run(
    agent_os: AgentOS,
    agent_id: str,
    catalog: Optional[CatalogState] = None,
    deps: Optional[Dict[str, Any]] = None,
) -> Optional[Tuple[Agent, Dict[str, Any], List[Function]]]:
    """Load a stored component's published config and build a fresh Agent.

    Fresh per run = no shared mutable state between concurrent runs (the same
    request isolation ``get_agent_by_id(create_fresh=True)`` provides for
    code-defined agents). Draft configs are invisible: only the published
    (current) version runs. When a catalog state is supplied, keyed-toolkit
    references are handled by :func:`plan_per_run_tools` and the returned
    fresh Function objects must be appended to the agent's tools by the
    caller. Returns the raw config alongside the Agent so the run route can
    enforce config-declared MCP connectors (the config dict is what the
    client writes; agno's ``from_dict`` ignores unknown keys like
    ``connectors``, so
    the Agent object alone doesn't carry it).
    """
    db = agent_os.db
    if db is None:
        return None
    stored = db.get_current_config(agent_id)
    if stored is None:
        return None
    # get_current_config returns the version wrapper ({component_id, version,
    # stage, config}); the Agent config lives under "config".
    config = stored.get("config") if isinstance(stored, dict) else None
    if config is None:
        return None
    fresh_fns: List[Function] = []
    if catalog is not None:
        config, fresh_fns = plan_per_run_tools(config, catalog.fn_index, deps)
    agent = Agent.from_dict(config, registry=agent_os.registry, strict=False)
    _refuse_unresolved_model_binding(agent, agent_os)
    if agent.db is None:
        agent.db = db
    # The agent id must match the handle the component was created under.
    agent.id = agent_id
    return agent, stored.get("config"), fresh_fns


def _sanitize_wire_event(event: Any) -> Any:
    """Client-facing wire hygiene on agno's converted AG-UI events.

    agno's stream handler (agui/handlers.py ``on_run_error``) echoes the raw
    run error into the terminal RUN_ERROR event: ``message`` carries the raw
    exception text and ``rawEvent`` the full internal event dict. Both can
    leak provider/infra detail (internal URLs, request ids, auth shapes) to
    any signed-in client. Keep the event type and error code, replace the
    message with a generic one, and drop the raw echo — the detail is already
    in the server logs via agno's own log_error.
    """
    if getattr(event, "type", None) == EventType.RUN_ERROR:
        return RunErrorEvent(
            type=EventType.RUN_ERROR,
            message="The agent run failed. Please try again.",
            code=getattr(event, "code", None),
        )
    return event


async def _attach_mcp_connectors(
    agent: Agent,
    connectors: Dict[str, Any],
    attached: list,
    connector_index: Optional[Dict[str, Tuple[str, Optional[str]]]] = None,
) -> None:
    """Construct MCP toolkits per run from the run's dependencies.

    Connectors arrive as ``mcp_connectors: {connector_id: {token}}`` in the
    run's dependencies — the run client resolves the org's connector config
    per run, so tokens never touch this service's storage. The attach URL
    comes ONLY from the connector registry (``connector_index``, written by
    the run client's server via the admin API): the wire carries no URL at
    all, and one arriving anyway is ignored — a URL from the wire would be
    an SSRF primitive (this service connects to attacker-chosen addresses
    from inside the deployment). A connector missing from the registry is
    skipped with a loud warning (same posture as a failed handshake: the
    client's pre-run gate is the primary guard, and skipping never aims a
    request anywhere).

    ``attached`` is CALLER-OWNED and every successfully opened toolkit is
    appended to it IMMEDIATELY after its ``__aenter__`` returns: if this
    coroutine is cancelled mid-attach (client disconnect during a handshake —
    attach happens before the first byte is streamed), the partial progress
    survives the raise inside the caller's list, so the caller's teardown
    closes every session that was actually opened. The one toolkit whose
    handshake was in flight when the cancellation landed is closed
    best-effort before the error re-raises (its connection never made it
    into ``attached``, so nobody else would close it).
    """
    from agno.tools.mcp import MCPTools

    index = connector_index or {}
    for connector_id, spec in connectors.items():
        if not isinstance(spec, dict):
            log_warning(f"dispatcher: skipping malformed MCP connector '{connector_id}'")
            continue
        registered = index.get(connector_id)
        if registered is None:
            log_warning(
                f"dispatcher: MCP connector '{connector_id}' is not registered — "
                f"skipping (the run proceeds without it; the wire carries no URL)"
            )
            continue
        url = registered[0]
        headers: Dict[str, str] = {}
        token = spec.get("token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        mcp_tools = None
        try:
            mcp_tools = MCPTools(url=url, transport="streamable-http", headers=headers or None)
            # Cap the handshake: a hung connector endpoint (unreachable
            # host, silent drop) would otherwise hold the run's start
            # indefinitely — the member sees an eternal spinner and the
            # concurrent-run slot stays occupied. On timeout the toolkit
            # is cleaned up like any other failed handshake and the run
            # proceeds without it (same skip-with-warning posture).
            await asyncio.wait_for(mcp_tools.__aenter__(), timeout=MCP_ATTACH_TIMEOUT_SECONDS)
            # Caller-owned list, appended first: even if anything below
            # raises, the opened session stays closable by the teardown.
            attached.append(mcp_tools)
            agent.tools = (agent.tools or []) + [mcp_tools]
        except BaseException as e:
            # BaseException, not Exception: asyncio.CancelledError has been
            # a BaseException since 3.8, and an ``except Exception`` here
            # let a cancellation during the handshake escape WITHOUT closing
            # the in-flight toolkit — its session leaked (the caller's
            # teardown only sees what made it into ``attached``).
            if mcp_tools is not None and mcp_tools not in attached:
                # The cleanup runs inside a SHIELDED cancel scope: this
                # except block usually executes while the run's task is
                # being unwound by a client disconnect, and in a cancelled
                # anyio scope every subsequent await raises — the unshielded
                # cleanup would abort at its first await and leak the
                # session anyway. The shield keeps the close running to
                # completion (the same close contract as the run teardown);
                # its own wait_for timeout still bounds a hung endpoint's
                # close. BaseException is suppressed so the cleanup never
                # masks the original failure.
                with anyio.CancelScope(shield=True):
                    try:
                        await asyncio.wait_for(
                            mcp_tools.__aexit__(None, None, None),
                            timeout=MCP_ATTACH_TIMEOUT_SECONDS,
                        )
                    except BaseException:
                        pass  # best-effort: never mask the original failure
            # The run is being torn down — unwind, don't log over it.
            # GeneratorExit/SystemExit/KeyboardInterrupt are BaseExceptions
            # too: falling through to the skip-log + continue below would
            # swallow the exit request and keep the loop running (a
            # GeneratorExit that never propagates out of the generator
            # makes the caller's close raise "ignored GeneratorExit").
            if isinstance(
                e,
                (asyncio.CancelledError, GeneratorExit, SystemExit, KeyboardInterrupt),
            ):
                raise
            log_warning(f"dispatcher: MCP connector '{connector_id}' failed to connect ({e}); skipping")


async def _stream_component_run(
    agent: Agent,
    run_input: RunAgentInput,
    user_id: Optional[str],
    deps: Optional[Dict[str, Any]],
) -> AsyncIterator:
    """The stock AG-UI ``run_entity`` flow, with two deliberate changes:

    1. dependencies are NOT appended to the user message (they carry secrets),
    2. per-run MCP connectors are attached before the run starts.
    """
    run_id = run_input.run_id or str(uuid.uuid4())

    try:
        messages = run_input.messages or []

        # 1. Extract inputs from the AG-UI message history
        user_input = extract_user_input(messages)
        images, audio, videos, files = extract_media(messages)
        tool_messages = extract_tool_messages(messages)

        # 2. Frontend tool definitions -> Agno Functions
        client_tools = parse_client_tools(run_input.tools) or None

        yield RunStartedEvent(type=EventType.RUN_STARTED, thread_id=run_input.thread_id, run_id=run_id)

        session_state = validate_state(run_input.state, run_input.thread_id)
        if session_state is not None:
            yield StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=copy.deepcopy(session_state))

        # 3. Run context carries the dependencies for tools — but they are
        #    NOT injected into the prompt (add_dependencies_to_context stays
        #    unset/False; the stock router sets it True when deps exist).
        run_context = RunContext(
            run_id=run_id,
            session_id=run_input.thread_id,
            user_id=user_id,
            client_tools=client_tools,
            dependencies=deps,
            session_state=session_state,
        )

        # 4. Resume (frontend executed external tools) or fresh run
        if tool_messages:
            response_stream = await resume_paused_run(
                entity=agent,
                session_id=run_input.thread_id,
                tool_messages=tool_messages,
                run_context=run_context,
                run_kwargs={},
            )
        else:
            response_stream = agent.arun(
                input=user_input,
                stream=True,
                stream_events=True,
                session_id=run_input.thread_id,
                user_id=user_id,
                run_id=run_id,
                images=images or None,
                audio=audio or None,
                videos=videos or None,
                files=files or None,
                run_context=run_context,
            )

        events_iter = async_stream_agno_response_as_agui_events(
            response_stream=response_stream,
            thread_id=run_input.thread_id,
            run_id=run_id,
            run_state=session_state,
        )
        try:
            async for event in events_iter:
                yield _sanitize_wire_event(event)
        finally:
            # Cancellation hygiene: when the client disconnects, GeneratorExit
            # is thrown into THIS generator at its yield point — the async for
            # above is abandoned. Without an explicit close, the conversion
            # generator and the agno run stream beneath it are only finalized
            # by garbage collection — non-deterministic, and long-lived runs
            # keep their underlying HTTP/work resources open until then.
            # aclose() delivers GeneratorExit into each layer deterministically
            # (best-effort: a close failure during cancellation must not mask
            # the unwind, and both layers are closed even if one errors).
            # The shielded scope keeps the closes running to completion while
            # the request task unwinds from a client disconnect — in a
            # cancelled scope every await raises, which would abort the
            # closes and leave both layers to GC.
            with anyio.CancelScope(shield=True):
                await _aclose_quietly(events_iter)
                await _aclose_quietly(response_stream)

    except Exception as e:
        # Detail stays server-side (log_error above); the client event is
        # generic — raw exception text can leak internal paths/URLs/keys.
        log_error(f"dispatcher: error running component '{agent.id}': {e}")
        yield RunErrorEvent(
            type=EventType.RUN_ERROR,
            message="The agent run failed. Please try again.",
        )


async def _aclose_quietly(stream: Any) -> None:
    """Best-effort ``aclose()`` for an async iterator during unwind.

    Missing ``aclose`` (a plain async iterator) and close-time errors are
    both swallowed: this runs in cancellation/exception paths where the
    original outcome must not be masked.

    ``BaseException`` (not ``Exception``) is the correct breadth here: an
    aclose() racing an active cancellation raises ``CancelledError`` — a
    ``BaseException`` since Python 3.8 — which ``suppress(Exception)``
    would let escape from the finally, aborting the remaining cleanup
    steps and breaking the unwind itself. Swallowing it is safe: the
    shielded scopes around these calls keep the closes running, and any
    real task-level cancellation is re-delivered by anyio at the next
    checkpoint after the finally completes.
    """
    aclose = getattr(stream, "aclose", None)
    if aclose is None:
        return
    with contextlib.suppress(BaseException):
        await aclose()


class CancellableStreamingResponse(StreamingResponse):
    """StreamingResponse that closes its body generator deterministically.

    Starlette's StreamingResponse leaves the body iterator suspended at its
    yield when the response task is cancelled mid-stream (client disconnect)
    — the generator's ``finally``, which owns the MCP session teardown and
    credential reset, would then only run via GC's asyncgen finalizer,
    leaking open MCP sessions for an unbounded time (F8). Closing the
    iterator explicitly in a ``finally`` delivers GeneratorExit at the yield
    point, running the teardown synchronously with the cancellation unwind.
    A no-op when the generator already completed (aclose on an exhausted
    async generator returns immediately).
    """

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.body_iterator.aclose()


def attach_stored_agent_routes(app: FastAPI, agent_os: AgentOS) -> None:
    """Mount ``POST /agui/{agent_id}`` for every stored (published) component.

    The app must carry the live ``CatalogState`` on ``app.state.catalog``
    (installed by ``build_app``): it is refreshed against the catalog revision
    before each run and drives the per-run keyed-toolkit delivery.
    """
    encoder = EventEncoder()

    @app.post("/agui/{agent_id}", name="run_stored_component")
    async def run_stored_component(request: Request, agent_id: str, run_input: RunAgentInput):
        # Identity is server-resolved: the JWT sub wins; forwarded user_id is
        # honored only for anonymous callers (mirrors the stock AG-UI router).
        client_user_id = run_input.forwarded_props.get("user_id") if run_input.forwarded_props else None
        user_id = resolve_run_user_id(request, client_user_id)

        catalog = getattr(request.app.state, "catalog", None)
        if catalog is not None:
            # Sync DB round-trip — and under a revision bump, a FULL
            # registry rebuild under the rebuild lock. Never run it on the
            # event loop: a rebuild would stall every concurrently
            # streaming run for its whole duration. anyio.to_thread keeps
            # the loop free; the rebuild lock still serializes rebuilds.
            await anyio.to_thread.run_sync(catalog.ensure_current, agent_os)

        # Per-run credentials are resolved from the wire context once, up
        # front: keyed-toolkit construction reads them directly, and the
        # streaming generator installs the same dict for the run's duration.
        deps = extract_context(run_input.context)

        try:
            # Same event-loop discipline as ensure_current above: agent
            # construction instantiates models/toolkits (network clients,
            # etc.) and reads the registry — blocking work, off-loop.
            agent_and_config = await anyio.to_thread.run_sync(
                build_agent_for_run, agent_os, agent_id, catalog, deps
            )
        except ModelBindingError as e:
            # Refused BEFORE anything ran — no credentials installed, no MCP
            # sessions opened. Surfaced as the AG-UI contract's terminal
            # event rather than an HTTP error status: the runtime's SSE
            # plumbing would drop a JSON error body's message, while a
            # RUN_ERROR event reaches the member's chat verbatim. The
            # message is a constant this service controls — safe to echo.
            return StreamingResponse(
                iter(
                    [
                        encoder.encode(
                            RunErrorEvent(type=EventType.RUN_ERROR, message=str(e))
                        )
                    ]
                ),
                media_type="text/event-stream",
            )
        if agent_and_config is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        agent, stored_config, fresh_fns = agent_and_config
        if fresh_fns:
            agent.tools = (agent.tools or []) + fresh_fns

        # The thread id is client-supplied and becomes the session id — refuse
        # a run into another user's session before streaming starts.
        await assert_session_writable(
            agent.db,
            run_input.thread_id,
            user_id or getattr(agent, "user_id", None),
            is_admin=caller_is_admin(request),
        )

        # Config-declared MCP connectors — the enforcement allowlist. The
        # client's server writes the agent's connector IDS into the stored
        # config at create/update time (ids, not names: connector names are
        # org-scoped and collide across orgs; ids are globally unique and
        # match the connector registry's keys); anything on the wire outside
        # that list is not a connector this component may ever reach (a
        # client-supplied `mcp_connectors` item would otherwise be an SSRF
        # primitive). Fail closed: undeclared ids are dropped with a
        # warning, the run proceeds without them (a declared-connector 402
        # was already the pre-run gate's job; this only guards the wire
        # namespace).
        declared_connectors = stored_config.get("connectors")
        if not isinstance(declared_connectors, list):
            declared_connectors = []

        async def event_generator():
            # Credentials live for exactly this stream: set before the run,
            # reset after — model clients and toolkits resolve keys from here.
            token = set_run_credentials(deps)
            attached_mcp: list = []
            try:
                # MCP connectors connect per run (inside the stream, where the
                # credential context is live) and close when the stream ends.
                if deps and deps.get("mcp_connectors"):
                    wire_connectors = deps["mcp_connectors"]
                    if not isinstance(wire_connectors, dict):
                        log_warning(
                            f"dispatcher: malformed mcp_connectors payload for component '{agent_id}' — refusing"
                        )
                    else:
                        undeclared = [
                            name
                            for name in wire_connectors
                            if name not in declared_connectors
                        ]
                        if undeclared:
                            log_warning(
                                f"dispatcher: refusing undeclared MCP connectors {undeclared} "
                                f"for component '{agent_id}' (declared: {declared_connectors})"
                            )
                            wire_connectors = {
                                name: spec
                                for name, spec in wire_connectors.items()
                                if name in declared_connectors
                            }
                        if wire_connectors:
                            # Caller-owned list: _attach_mcp_connectors
                            # appends each opened session the moment its
                            # handshake succeeds, so a cancellation
                            # mid-attach (client disconnect during the
                            # handshake) leaves the partial progress here
                            # and the finally below closes every session
                            # that was actually opened.
                            await _attach_mcp_connectors(
                                agent,
                                wire_connectors,
                                attached_mcp,
                                connector_index=(
                                    catalog.connector_index if catalog is not None else {}
                                ),
                            )
                inner = _stream_component_run(agent, run_input, user_id=user_id, deps=deps)
                try:
                    async for event in inner:
                        yield encoder.encode(event)
                finally:
                    # Deterministic close of the inner generator: the
                    # CancellableStreamingResponse only acloses THIS outer
                    # generator (GeneratorExit at the yield) — without this,
                    # the inner generator (and the agno run stream it wraps,
                    # closed in its own finally) finalizes only at GC.
                    # Shielded so the close completes even when the request
                    # task is already cancelled (client disconnect): in a
                    # cancelled scope every await raises, which would abort
                    # the close and leave the inner generator to GC.
                    with anyio.CancelScope(shield=True):
                        await _aclose_quietly(inner)
            finally:
                if attached_mcp:
                    # Cancellation-safety: closing MCP sessions must not be
                    # skipped when the request task is cancelled mid-stream
                    # (client disconnect). The request runs under
                    # BaseHTTPMiddleware's anyio task group, where a
                    # cancelled scope makes EVERY subsequent await raise —
                    # a bare asyncio shield + second wait would never
                    # actually wait. An anyio shielded cancel scope is the
                    # correct pattern: awaits inside it are protected from
                    # the outer cancellation, so the closes run to
                    # completion no matter how the disconnect unwinds.
                    async def _close_mcp_sessions() -> None:
                        await asyncio.gather(
                            *(mcp_tools.__aexit__(None, None, None) for mcp_tools in attached_mcp),
                            return_exceptions=True,
                        )

                    with anyio.CancelScope(shield=True):
                        await _close_mcp_sessions()
                # The credential reset lives INSIDE the finally: an exception
                # unwinding through the finally (e.g. the cancellation above)
                # would otherwise skip it and leave the per-run key context
                # set. Harmless across tasks today (each request task runs in
                # its own context copy), but the finally is the correct home.
                reset_run_credentials(token)

        return CancellableStreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            # No CORS headers on purpose: CORS is browser-enforced and this
            # endpoint is server-to-server (the client's runtime attaches the
            # Bearer JWT). Serving `Access-Control-Allow-Origin: *` only
            # widened the probe surface for browser clients; every caller
            # here is a server that ignores CORS entirely.
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

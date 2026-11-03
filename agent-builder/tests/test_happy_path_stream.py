"""Happy-path AG-UI event stream — the full run contract over the wire.

The other run tests drive RecordingModel, whose stub client ABORTS the run
(proving credential handling without network). Nothing yet asserts what a
SUCCESSFUL run streams. This file pins the happy path end-to-end: a model
stub that actually completes, and the SSE event sequence a conforming AG-UI
client needs — RUN_STARTED (with the request's thread/run ids), the
TEXT_MESSAGE_* family carrying the content, and a terminal RUN_FINISHED
with no RUN_ERROR anywhere.
"""

import json
from types import SimpleNamespace

import pytest
from agno.models.openai import OpenAIChat

from models import platform_model_class
from platform_test_helpers import admin_headers, agui_body, user_headers

PlatformOpenAIChat = platform_model_class(OpenAIChat, "openai_api_key", "OPENAI_API_KEY")

TEXT_DELTAS = ["Hello", " world"]


def _chunk(content, finish_reason=None):
    """A minimal OpenAI ChatCompletionChunk-shaped object — exactly the
    attributes agno's parser touches, nothing more."""
    return SimpleNamespace(
        id="chatcmpl-test",
        model="gpt-4o-mini",
        created=0,
        object="chat.completion.chunk",
        system_fingerprint=None,
        model_extra=None,
        usage=None,  # _should_collect_metrics reads .usage unconditionally
        choices=[
            SimpleNamespace(
                index=0,
                finish_reason=finish_reason,
                logprobs=None,
                delta=SimpleNamespace(
                    role="assistant",
                    content=content,
                    tool_calls=None,
                    function_call=None,
                    refusal=None,
                ),
            )
        ],
    )


class HappyModel(PlatformOpenAIChat):
    """A model stub that completes: two content deltas, then stop."""

    def get_async_client(self):
        async def create(**kwargs):
            async def stream():
                for delta in TEXT_DELTAS:
                    yield _chunk(delta)
                yield _chunk(None, finish_reason="stop")

            return stream()

        return SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=create))
        )


@pytest.fixture
def happy_registry(app):
    """Swap the registry's OpenAI model for a HappyModel (same id)."""
    registry = app.state.agent_os.registry
    happy = HappyModel(id="gpt-4o-mini")
    original = registry.models[0]
    registry.models[0] = happy
    yield registry
    registry.models[0] = original


def _create_component(client, **overrides):
    from platform_test_helpers import component_payload

    payload = component_payload(**overrides)
    return client.post("/components", headers=admin_headers(sub="frontend-service"), json=payload)


def _parse_sse(text):
    events = []
    for line in text.splitlines():
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:"):].strip()))
    return events


def test_happy_path_streams_a_complete_agui_event_sequence(client, happy_registry):
    res = _create_component(client, component_id="happy-agent")
    assert res.status_code in (200, 201), res.text
    component_id = res.json()["component_id"]

    run = client.post(
        f"/agui/{component_id}",
        headers=user_headers(),
        json=agui_body(thread_id="t-happy"),
    )
    assert run.status_code == 200, run.text

    events = _parse_sse(run.text)
    types = [e.get("type") for e in events]

    # Opens with RUN_STARTED carrying the request's identity...
    assert types[0] == "RUN_STARTED"
    assert events[0]["threadId"] == "t-happy"
    assert events[0]["runId"] == "run-1"
    # ...streams the content...
    assert "TEXT_MESSAGE_START" in types
    assert "TEXT_MESSAGE_CONTENT" in types
    deltas = "".join(e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert deltas == "".join(TEXT_DELTAS)
    # ...every opened message closes, and the run finishes cleanly.
    assert types.count("TEXT_MESSAGE_START") == types.count("TEXT_MESSAGE_END")
    assert types[-1] == "RUN_FINISHED"
    assert "RUN_ERROR" not in types


def test_happy_path_state_round_trips_through_state_snapshot(client, happy_registry):
    """A run with session state opens with a STATE_SNAPSHOT right after
    RUN_STARTED (the AG-UI state contract the run client's persistence
    reads), and the stream still finishes cleanly."""
    res = _create_component(client, component_id="happy-state-agent")
    component_id = res.json()["component_id"]

    body = agui_body(thread_id="t-happy-state")
    body["state"] = {"counter": 3}

    run = client.post(f"/agui/{component_id}", headers=user_headers(), json=body)
    assert run.status_code == 200, run.text

    events = _parse_sse(run.text)
    types = [e.get("type") for e in events]
    assert types[0] == "RUN_STARTED"
    assert "STATE_SNAPSHOT" in types
    snapshot = next(e for e in events if e.get("type") == "STATE_SNAPSHOT")
    assert snapshot["snapshot"] == {"counter": 3}
    assert types[-1] == "RUN_FINISHED"
    assert "RUN_ERROR" not in types

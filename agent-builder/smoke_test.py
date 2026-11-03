"""Live smoke test for the platform-os spike (real model + real tool calls).

Boots the REAL app in-process, creates a published agent component referencing
the OpenRouter-hosted GLM model plus the Tavily toolkit, then proves the
whole credential contract over live runs:

  1. runner key WINS  — a (deliberately wrong) BYOK OpenRouter key sent in
     the run's dependencies reaches the model client -> provider 401 -> the
     run errors with the provider's auth error (proof the key was USED).
  2. platform key FALLBACK — no deps -> the platform env key -> a real
     completion streams back (RUN_COMPLETED with content).
  3. per-run tool key — the Tavily toolkit resolves the runner's Tavily key
     per call; a real search executes and the model cites results.
  4. history alignment — a second run on the same thread_id sees the first
     turn (Agno-side history via session_id = the run client's thread id).

DESTRUCTIVE BOOT GUARD: the smoke test drops and recreates the catalog
tables and the agno `ai` schema on startup, so it refuses to run against
anything but a throwaway target — a loopback/container Postgres host —
unless ``SMOKE_ALLOW_DESTROY=1`` is set (the escape hatch for pointing it
at a scratch cloud database on purpose; never a live deployment).

Keys: OPENROUTER_API_KEY / TAVILY_API_KEY and DATABASE_URL come from the
shell env or this service's own .env — and from nowhere else. No sibling
agent's .env is ever read: those carry PROD databases, which must never
reach this script.
Cost: two short GLM completions + one Tavily basic search.

    DATABASE_URL=postgresql://... uv run python agents/platform-os/smoke_test.py
"""
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Mapping, Optional

AG_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AG_DIR))

# Hosts the destructive boot is allowed to touch without an explicit
# override: the loopback interfaces and container-style single-label
# hostnames (docker service names). Anything else — notably a cloud/Neon
# host — needs the SMOKE_ALLOW_DESTROY=1 escape hatch.
_SAFE_HOSTS = {"localhost", "::1", "host.docker.internal"}
_V4_LOOPBACK_RE = re.compile(r"127(?:\.\d{1,3}){3}")


def _is_throwaway_host(dsn: str) -> bool:
    host = (urllib.parse.urlparse(dsn).hostname or "").lower()
    return (
        host in _SAFE_HOSTS
        or host.endswith(".localhost")
        or bool(_V4_LOOPBACK_RE.fullmatch(host))
    )


def _assert_destroyable_target(dsn: str, env: Optional[Mapping[str, str]] = None) -> None:
    """Refuse to run unless the target is a throwaway database.

    The smoke test DROPs the catalog tables and the agno `ai` schema on
    boot; against a live deployment that destroys sessions, memories and
    learnings. The guard accepts loopback/container targets only; anything
    else requires the explicit SMOKE_ALLOW_DESTROY=1 escape hatch (checked
    first, so an operator override always wins over the host heuristic).
    """
    env = os.environ if env is None else env
    if env.get("SMOKE_ALLOW_DESTROY") == "1":
        return
    if _is_throwaway_host(dsn):
        return
    host = urllib.parse.urlparse(dsn).hostname or ""
    raise SystemExit(
        f"Refusing to run the smoke test against Postgres host '{host}' — it drops "
        "the catalog tables and the agno `ai` schema on boot. Point DATABASE_URL at "
        "a throwaway local Postgres, or set SMOKE_ALLOW_DESTROY=1 to run anyway."
    )


def _load_env() -> None:
    """Load this service's own .env. Values already present in the shell
    environment always win (dotenv does not override existing variables).

    Nothing outside this directory is ever read — sibling agents' .env
    files carry PROD database URLs, and this script's DATABASE_URL must
    come only from its own env or the shell.
    """
    from dotenv import load_dotenv

    load_dotenv(AG_DIR / ".env")  # the service's own env (DATABASE_URL, JWT_SECRET, keys)


PASS = []
FAIL = []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    print(f"{'PASS' if condition else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not condition else ""))


def events(text):
    """Parse the SSE stream into AG-UI event dicts."""
    out = []
    for line in text.splitlines():
        if line.startswith("data:"):
            try:
                out.append(json.loads(line[5:]))
            except json.JSONDecodeError:
                pass
    return out


def boot():
    """Env, guard checks and the destructive state reset. Returns the two
    auth header dicts the run section below needs."""
    _load_env()

    if not os.getenv("OPENROUTER_API_KEY"):
        sys.exit(
            "OPENROUTER_API_KEY missing — put it in agents/platform-os/.env "
            "(or the shell env) to run the live smoke test."
        )
    if not os.getenv("DATABASE_URL"):
        sys.exit(
            "DATABASE_URL missing — the smoke test needs a throwaway Postgres "
            "(it drops the catalog tables and the agno `ai` schema on boot)."
        )

    os.environ.setdefault("JWT_SECRET", "smoke-test-secret-32-chars-min-please")

    import jwt
    import psycopg

    from agents_shared.auth import ADMIN_SCOPE, USER_SCOPE

    dsn = os.environ["DATABASE_URL"]
    _assert_destroyable_target(dsn)

    # Fresh state per run: drop the catalog tables AND the agno schema so
    # component ids never collide and the admin re-ticks the catalog below.
    # The guard is re-asserted HERE, immediately before the destructive
    # statements, so the check and the drops cannot drift apart.
    _assert_destroyable_target(dsn)
    with psycopg.connect(dsn) as conn:
        for table in ("platform_provider", "platform_model", "platform_tool", "platform_catalog_version"):
            conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        conn.execute("DROP SCHEMA IF EXISTS ai CASCADE")
        conn.commit()

    admin_token = jwt.encode(
        {"sub": "frontend-service", "scopes": [ADMIN_SCOPE], "exp": 4102444800},
        os.environ["JWT_SECRET"],
        algorithm="HS256",
    )
    user_token = jwt.encode(
        {"sub": "smoke-user", "scopes": [USER_SCOPE], "exp": 4102444800},
        os.environ["JWT_SECRET"],
        algorithm="HS256",
    )
    return (
        {"Authorization": f"Bearer {admin_token}"},
        {"Authorization": f"Bearer {user_token}"},
    )


def main():
    ADMIN_H, USER_H = boot()

    from fastapi.testclient import TestClient

    import main as platform_main

    app = platform_main.build_app(db_url=os.environ["DATABASE_URL"])
    client = TestClient(app, raise_server_exceptions=False)

    # -- configure the catalog via the admin API (the operator's one step) ----
    res = client.put(
        "/platform/catalog/models",
        headers=ADMIN_H,
        json={"providers": [{"slug": "openrouter", "enabled": True, "models": ["z-ai/glm-5.3-flash:max_tokens=8192"]}]},
    )
    check("catalog: openrouter model enabled", res.status_code == 200, res.text[:200])
    res = client.put(
        "/platform/catalog/tools",
        headers=ADMIN_H,
        json={"tools": [{"slug": "tavily", "enabled": True}]},
    )
    check("catalog: tavily toolkit enabled", res.status_code == 200, res.text[:200])
    # The builder-facing catalogs reflect the rows immediately.
    res = client.get("/platform/models", headers=ADMIN_H)
    check(
        "platform/models serves the enabled model",
        [m["id"] for m in res.json()["models"]] == ["z-ai/glm-5.3-flash"],
        res.text[:200],
    )

    # -- create a published agent: GLM via OpenRouter + Tavily search --------
    component_id = "smoke-agent"
    config = {
        "id": component_id,
        "name": "Smoke Agent",
        "model": {"id": "z-ai/glm-5.3-flash", "name": "OpenRouter"},
        "instructions": ["Answer in one short sentence."],
        # History lives Agno-side for created agents — the builder must
        # always write these flags into the stored config.
        "add_history_to_context": True,
        "num_history_runs": 10,
        "tools": [
            {
                # Stock TavilyTools function name (per-run constructed with
                # the run's key — no platform wrapper class anymore).
                "name": "web_search_using_tavily",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string", "description": "The search query"}},
                    "required": ["query"],
                },
            }
        ],
    }
    res = client.post(
        "/components",
        headers=ADMIN_H,
        json={
            "name": "Smoke Agent",
            "component_id": component_id,
            "component_type": "agent",
            "config": config,
            "stage": "published",
            "set_current": True,
        },
    )
    check("component created", res.status_code in (200, 201), res.text[:200])

    def run(body):
        r = client.post(f"/agui/{component_id}", headers=USER_H, json=body)
        assert r.status_code == 200, r.text[:300]
        return events(r.text)

    # -- 1. runner key WINS (wrong BYOK key -> provider 401) ------------------
    ev = run(
        {
            "thread_id": "smoke-t-byok",
            "run_id": "r1",
            "messages": [{"id": "m1", "role": "user", "content": "hi"}],
            "tools": [],
            "context": [{"description": "openrouter_api_key", "value": "sk-deliberately-wrong-byok"}],
        }
    )
    err = next((e for e in ev if e.get("type") == "RUN_ERROR"), None)
    # The wire error is sanitized (fac65cf): the raw provider message never
    # reaches the client — the detail stays in server logs only. The event's
    # error CODE still discriminates: `model_provider_error` proves the run
    # reached the provider and was rejected (the wrong BYOK key was
    # delivered and used); any other error would mean the provider was
    # never hit. Also assert the generic-message sanitization is active.
    check(
        "runner key wins (BYOK reached the provider; wire error sanitized)",
        err is not None
        and err.get("code") == "model_provider_error"
        and err.get("message") == "The agent run failed. Please try again.",
        json.dumps(err)[:300],
    )

    # -- 2. platform key fallback -> real completion ---------------------------
    ev = run(
        {
            "thread_id": "smoke-t-platform",
            "run_id": "r2",
            "messages": [{"id": "m1", "role": "user", "content": "Reply with exactly: PLATFORM-OK"}],
            "tools": [],
        }
    )
    completed = next((e for e in ev if e.get("type") == "RUN_FINISHED"), None)
    content = "".join(
        (e.get("delta") or "") for e in ev if e.get("type") == "TEXT_MESSAGE_CONTENT"
    )
    check("platform key fallback (real completion)", completed is not None, str([e.get("type") for e in ev]))
    check("completion has content", "PLATFORM-OK" in content or len(content) > 0, content[:100])

    # -- 3. per-run Tavily key -> real search ----------------------------------
    tavily_key = os.getenv("TAVILY_API_KEY")
    if tavily_key:
        ev = run(
            {
                "thread_id": "smoke-t-tavily",
                "run_id": "r3",
                "messages": [
                    {
                        "id": "m1",
                        "role": "user",
                        "content": "Search the web for 'Agno agent framework' and name one fact you found.",
                    }
                ],
                "tools": [],
                "context": [{"description": "tavily_api_key", "value": tavily_key}],
            }
        )
        tool_calls = [e for e in ev if e.get("type") == "TOOL_CALL_START"]
        completed = next((e for e in ev if e.get("type") == "RUN_FINISHED"), None)
        check("tavily tool call executed per-run", completed is not None and len(tool_calls) >= 1, str([e.get("type") for e in ev]))
    else:
        print("SKIP  tavily per-run key (no TAVILY_API_KEY found)")

    # -- 4. history alignment: same thread sees the previous turn --------------
    ev = run(
        {
            "thread_id": "smoke-t-platform",
            "run_id": "r4",
            "messages": [{"id": "m2", "role": "user", "content": "What exact phrase did I ask you to reply with one turn ago?"}],
            "tools": [],
        }
    )
    content = "".join(
        (e.get("delta") or "") for e in ev if e.get("type") == "TEXT_MESSAGE_CONTENT"
    )
    check("history aligns via session_id (= thread id)", "PLATFORM-OK" in content, content[:150])

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        sys.exit(1)


if __name__ == "__main__":
    main()

"""The connector registry endpoints (/platform/connectors*).

The run client's server is the registry's ONLY writer (push-first-then-
commit: it pushes before every local write), so these tests pin the exact
surface it depends on: idempotent upserts, shape-only URL validation,
idempotent deletes, and a listing that can never carry tokens (connector
credentials are per-run deps, they never touch this service's storage).
Auth is pinned exhaustively in test_auth_lockdown.py — not repeated here.
"""

from platform_test_helpers import admin_headers


def _listing(client):
    return client.get("/platform/connectors", headers=admin_headers()).json()["connectors"]


def _row(client, connector_id):
    matches = [r for r in _listing(client) if r["connectorId"] == connector_id]
    return matches[0] if matches else None


def test_put_then_get_lists_the_entry(client):
    res = client.put(
        "/platform/connectors/conn-registry-1",
        headers=admin_headers(),
        json={"url": "https://mcp.example.test/sse", "label": "GitHub"},
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True
    row = _row(client, "conn-registry-1")
    assert row is not None
    assert row["url"] == "https://mcp.example.test/sse"
    assert row["label"] == "GitHub"


def test_put_is_an_idempotent_upsert_that_overwrites(client):
    """The run client pushes on connector create/edit AND belt-and-braces
    at agent save — repeated PUTs are the normal case, and an edited URL
    must replace the stored one."""
    first = client.put(
        "/platform/connectors/conn-registry-2",
        headers=admin_headers(),
        json={"url": "https://old.example.test/sse", "label": "Old"},
    )
    second = client.put(
        "/platform/connectors/conn-registry-2",
        headers=admin_headers(),
        json={"url": "https://new.example.test/sse", "label": "New"},
    )
    assert first.status_code == second.status_code == 200
    assert second.json()["revision"] > first.json()["revision"]
    row = _row(client, "conn-registry-2")
    assert row["url"] == "https://new.example.test/sse"
    assert row["label"] == "New"
    # Exactly one row — the id is the key, no duplicate accumulates.
    assert len([r for r in _listing(client) if r["connectorId"] == "conn-registry-2"]) == 1


def test_put_label_is_optional(client):
    res = client.put(
        "/platform/connectors/conn-registry-3",
        headers=admin_headers(),
        json={"url": "https://mcp.example.test/mcp"},
    )
    assert res.status_code == 200
    assert _row(client, "conn-registry-3")["label"] is None


def test_put_validates_the_url_shape(client):
    for bad in ("not a url", "ftp://mcp.example.test/sse", "//mcp.example.test/sse"):
        res = client.put(
            "/platform/connectors/conn-registry-bad",
            headers=admin_headers(),
            json={"url": bad, "label": "Bad"},
        )
        assert res.status_code == 400, bad
    # Nothing was stored for the failed upserts.
    assert _row(client, "conn-registry-bad") is None


def test_put_rejects_an_overlong_connector_id(client):
    res = client.put(
        "/platform/connectors/" + "x" * 201,
        headers=admin_headers(),
        json={"url": "https://mcp.example.test/sse"},
    )
    assert res.status_code == 400


def test_delete_removes_the_entry(client):
    client.put(
        "/platform/connectors/conn-registry-4",
        headers=admin_headers(),
        json={"url": "https://mcp.example.test/sse", "label": "Doomed"},
    )
    assert _row(client, "conn-registry-4") is not None

    res = client.delete("/platform/connectors/conn-registry-4", headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert _row(client, "conn-registry-4") is None


def test_delete_an_unknown_id_is_still_ok(client):
    """Idempotent deletes: the run client deletes the registry entry BEFORE
    the local row — an entry that never synced (or was already removed)
    must not error the connector delete flow."""
    res = client.delete("/platform/connectors/conn-never-synced", headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_listing_cannot_carry_tokens(client):
    """A misbehaving writer cannot smuggle a token into the registry: the
    upsert model accepts url + label only, and the listing shape has no
    place for secrets."""
    res = client.put(
        "/platform/connectors/conn-registry-5",
        headers=admin_headers(),
        json={"url": "https://mcp.example.test/sse", "label": "X", "token": "gh_super_secret"},
    )
    assert res.status_code == 200
    row = _row(client, "conn-registry-5")
    assert row == {"connectorId": "conn-registry-5", "url": "https://mcp.example.test/sse", "label": "X"}

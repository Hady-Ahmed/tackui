"""Unit tests for the smoke test's destructive-boot guard.

``smoke_test.py`` drops the catalog tables and the agno `ai` schema on boot,
so its target check is load-bearing: a prod-looking host must be refused and
only the explicit SMOKE_ALLOW_DESTROY=1 escape hatch may override. The guard
is factored as a function so these tests can pin it without importing the
script's boot path (importing ``smoke_test`` is side-effect-free by design —
all boot work lives in ``boot()``).
"""
import pytest

import smoke_test


def test_prod_looking_host_is_refused():
    with pytest.raises(SystemExit) as exc:
        smoke_test._assert_destroyable_target(
            "postgresql://user:pass@ep-cool-name-123.us-east-2.aws.neon.tech/neondb"
        )
    assert "SMOKE_ALLOW_DESTROY=1" in str(exc.value)


def test_aws_style_public_host_is_refused():
    with pytest.raises(SystemExit):
        smoke_test._assert_destroyable_target(
            "postgresql://user:pass@my-db.abc123xyz.rds.amazonaws.com:5432/prod"
        )


def test_localhost_and_loopback_pass():
    smoke_test._assert_destroyable_target("postgresql://user:pass@localhost:5432/smoke")
    smoke_test._assert_destroyable_target("postgresql://user:pass@127.0.0.1:5432/smoke")
    smoke_test._assert_destroyable_target("postgresql://user:pass@[::1]:5432/smoke")


def test_single_label_hostname_is_NOT_throwaway():
    # A single-label hostname is NOT proof of a container: Railway-style
    # private networks name REAL production databases with bare labels
    # (`db`, `postgres`). Treating them as throwaway let the smoke test's
    # destructive boot run against production with no override. A local
    # compose target now needs SMOKE_ALLOW_DESTROY — stricter is correct
    # here (testcontainers fixtures are loopback anyway).
    with pytest.raises(SystemExit):
        smoke_test._assert_destroyable_target("postgresql://user:pass@pg-test:5432/smoke")


def test_smoke_allow_destroy_overrides_any_host():
    smoke_test._assert_destroyable_target(
        "postgresql://user:pass@ep-cool-name-123.us-east-2.aws.neon.tech/neondb",
        env={"SMOKE_ALLOW_DESTROY": "1"},
    )


def test_guard_defaults_to_the_process_env():
    """Without an explicit mapping the guard reads os.environ — the escape
    hatch must work exactly the way the boot path uses it."""
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setenv("SMOKE_ALLOW_DESTROY", "1")
        smoke_test._assert_destroyable_target(
            "postgresql://user:pass@prod-db.example.com/prod"
        )
        monkey.delenv("SMOKE_ALLOW_DESTROY", raising=False)
        monkey.setenv("SMOKE_ALLOW_DESTROY", "0")
        with pytest.raises(SystemExit):
            smoke_test._assert_destroyable_target(
                "postgresql://user:pass@prod-db.example.com/prod"
            )
    finally:
        monkey.undo()


def test_dsn_without_a_host_is_refused():
    with pytest.raises(SystemExit):
        smoke_test._assert_destroyable_target("not-a-dsn")

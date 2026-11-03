"""Platform model classes — per-run API keys without shared-state races.

Registry model instances are SHARED across every run: one object per model
id serves every user, so it cannot hold any single runner's key. A runner's
key arrives per run (via the run's dependencies) and must reach client
construction WITHOUT mutating the shared instance — concurrent runs of
different users would otherwise see each other's keys.

The generic mechanism (replaces one hand-written subclass per provider):

- ``PlatformMixin`` resolves the per-run credential at client-construction
  time. When a per-run key exists and differs from the instance's, a
  THROWAWAY copy of the model (``dataclasses.replace`` — field values only,
  no cached clients) is built with the runner's key and the provider's own
  ``get_client`` machinery constructs the client. Nothing provider-specific
  lives here: OpenAI-SDK-backed providers, ollama, llama.cpp — each builds
  its own client type; the mixin only supplies the key.
- ``platform_model_class`` generates the wrapper subclass at catalog-rebuild
  time for whatever provider class the discovery scan found. Adding a
  provider = enabling it in the admin UI; no code.
- A provider whose keyless construction fails never appears (discovery
  skips it) — nothing dead is ever served.
"""
import dataclasses
from typing import Any, Dict, Optional

from credentials import resolve_credential


class PlatformMixin:
    """Per-run key resolution for shared model instances.

    ``credential_dep_key`` / ``platform_env_key`` are plain class attributes
    stamped onto the generated subclass (never dataclass fields). The
    ``credential_dep_key`` is the dependency key the run client delivers the runner's
    key under — derived from the provider's agno MODULE as
    ``<module>_api_key`` (never from the catalog slug: one vendor's API
    doors share the vendor's single key) and cross-checked by the catalog
    (a mismatched key would be injected on the wire and never read).
    """

    credential_dep_key: str = ""
    # Stamped onto every generated subclass and surfaced to the admin API
    # payloads (env_key_set / platform_tier gating) — never read
    # platform-side: the platform env-key fallback happens inside agno.
    platform_env_key: Optional[str] = None

    def _per_run_api_key(self) -> Optional[str]:
        if not self.credential_dep_key:
            return None
        return resolve_credential(self.credential_dep_key)

    def _run_keyed_copy(self) -> Any:
        """A throwaway copy of this model with the runner's key baked in.

        ``dataclasses.replace`` re-runs ``__init__`` with current field
        values — cached clients are explicitly cleared so the copy builds
        its own. The copy is discarded after client construction; the shared
        instance is never mutated.
        """
        field_names = {f.name for f in dataclasses.fields(self)}
        kwargs: Dict[str, Any] = {"api_key": self._per_run_api_key()}
        for cached in ("client", "async_client"):
            if cached in field_names:
                kwargs[cached] = None
        return dataclasses.replace(self, **kwargs)

    def get_client(self):
        key = self._per_run_api_key()
        if key and key != getattr(self, "api_key", None):
            return self._run_keyed_copy().get_client()
        return super().get_client()

    def get_async_client(self):
        key = self._per_run_api_key()
        if key and key != getattr(self, "api_key", None):
            return self._run_keyed_copy().get_async_client()
        return super().get_async_client()


def platform_model_class(provider_cls: type, dep_key: str, platform_env_key: Optional[str]) -> type:
    """Generate the platform wrapper subclass for one discovered provider."""
    return type(
        f"Platform{provider_cls.__name__}",
        (PlatformMixin, provider_cls),
        {"credential_dep_key": dep_key, "platform_env_key": platform_env_key},
    )

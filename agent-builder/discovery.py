"""Boot-time discovery of everything agno ships on THIS deployment.

The scan enumerates ``agno.models.*`` provider modules and ``agno.tools.*``
toolkit modules, try-importing each. It is read-only introspection: nothing
here is exposed to anyone — it produces the MENU the platform admin picks
from. Everything the catalog can offer derives from this scan; nothing is
hand-authored.

Rules (all fail-closed):

- A module that cannot import (missing pip package) does not exist for this
  deployment: not in the menu, one boot-log line. Installing the package and
  restarting makes it appear.
- A class that cannot be constructed (required args the scan cannot supply)
  does not appear either — an entry the platform cannot build is never
  offered.
- Toolkits are constructed once with throwaway dummy credentials purely to
  read their identity (``.name``), function list, and function schemas. The
  dummies never reach a network call: SDK clients are built but not used.
- Credential contracts are DERIVED from the module's own source (the
  ``<arg> = <arg> or getenv("SOME_ENV")`` idiom) and cross-checked against
  the constructor signature. Nothing is typed by hand.
- Every concrete model class a module defines is an offering — the
  chat-completions and Responses doors both appear, each under its own
  slug, and so do the generic adapters (``OpenAILike``,
  ``OpenResponses``) a self-hoster can point at their own server. The
  scan excludes nothing; the admin enables. One vendor's doors share the
  vendor's single credential, because ``dep_key`` derives from the agno
  module, not the slug.

The scan runs at boot and is cached for the process lifetime. Its output
only changes when the agno package changes, which only happens on redeploy
(process restart) — so the cache can never go stale and needs no TTL.
"""
import dataclasses
import inspect
import pkgutil
import re
from typing import Any, Dict, List, Optional, Tuple

from agno.models.base import Model
from agno.tools.function import Function
from agno.tools.toolkit import Toolkit
from agno.utils.log import log_info

# Modules that are infrastructure, not offerings.
_MODEL_SKIP = {"base", "message", "response", "utils", "fallback", "tuning_engines"}
_TOOL_SKIP = {"function", "toolkit", "decorator", "annotations", "utils"}

# ``var = getenv("X")`` / ``var or getenv("X")`` / ``var = os.environ.get("X")``
# — the idiom every agno toolkit/model uses to fall back to an env var. The
# captured variable is the constructor argument that receives the value.
_ENV_ASSIGN_RE = re.compile(
    r"""(\w+)\s*(?:=|or)\s*(?:os\.)?(?:getenv|environ\.get)\(\s*["']([A-Z0-9_]{3,})["']"""
)
# Model credentials are uniformly named *_API_KEY (OPENAI_API_KEY,
# OPENROUTER_API_KEY, ...). Tool credentials additionally use TOKEN / SECRET
# / PASSWORD (DISCORD_BOT_TOKEN, ZENDESK_PASSWORD, ...). The model scan
# accepts only ASSIGNMENT-SHAPED lines — the call must sit in code value
# position behind an ``=`` or ``or`` fallback (``self.api_key =
# getenv(...)``), a ``lambda:`` default factory, or a ``:`` dict value
# (``{"api_key": os.environ.get(...)}``) — the same discipline as the tools
# scanner above — so a docstring that merely MENTIONS another *_API_KEY
# (prose around the call, no assignment on the line) cannot misderive the
# platform env key. The multi-hit alphabetical pick is unchanged.
_MODEL_ENV_RE = re.compile(
    r"""(?:=|\bor\b|\blambda\s*:|:)\s*(?:os\.)?(?:getenv|environ\.get)\(\s*["']([A-Z0-9_]*API_KEY)["']"""
)
_CRED_ENV_RE = re.compile(r"(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD)(?:_|$)")

_DUMMY_STR = "platform-scan-placeholder"


@dataclasses.dataclass
class ModelProvider:
    """One discoverable model offering — one agno model CLASS, not module.

    A module may export several concrete classes (openai ships the
    chat-completions and Responses doors side by side). Each concrete class
    becomes its own offering with its own slug; ``module`` stays the agno
    module and is the CREDENTIAL identity — ``dep_key`` derives from it, so
    every door of one vendor shares the vendor's single key.
    """

    slug: str  # "openai-chat" / "openai-responses" — the catalog + admin identity
    module: str  # "openai" — the agno module; dep keys derive from this
    class_name: str  # "OpenAIChat"
    cls: type  # the agno model class (dataclass)
    platform_env_key: Optional[str]  # "OPENAI_API_KEY" — env scan of the MRO
    has_api_key_field: bool  # False = keyless provider (ollama, llama.cpp)

    @property
    def dep_key(self) -> Optional[str]:
        """The dependency key the run client delivers the runner's key under."""
        if not self.has_api_key_field:
            return None
        return f"{self.module}_api_key"


@dataclasses.dataclass
class ToolCredential:
    """One credential a toolkit may need — derived, never hand-typed.

    ``dep_key`` follows the one convention the whole stack shares
    (``<toolkit-slug>_<constructor-arg>`` — e.g. ``tavily_api_key``,
    ``x_consumer_key``): the client's key UI, run gate, and per-run delivery all
    derive it the same way, so a mismatch is structurally impossible.
    """

    env: str  # "TAVILY_API_KEY" — the env var the toolkit itself would read
    arg: str  # "api_key" — the constructor argument that receives the value
    dep_key: str  # "tavily_api_key" — the dependency key the runner's key arrives under
    label: str  # "Api key" — human label for the connect form field


@dataclasses.dataclass
class ToolEntry:
    """One discoverable toolkit (one agno toolkit class)."""

    module: str  # "tavily" — the slug; dep keys derive from it
    class_name: str  # "TavilyTools"
    cls: type
    toolkit_name: str  # the registry-facing name the class assigns itself
    functions: List[Dict[str, Any]]  # [{name, description, parameters}] — scan-processed
    credentials: List[ToolCredential]  # the delivery contract (may be empty)
    # Credential-shaped env vars the toolkit reads that have NO constructor
    # argument (read directly from env inside __init__): the key exists but
    # there is no per-run delivery path for it. Such a toolkit constructs
    # fine and then fails at call time — it is shown in the admin list but
    # not enable-able ("no key delivery path"), never silently broken.
    undeliverable_envs: List[str] = dataclasses.field(default_factory=list)

    @property
    def keyed(self) -> bool:
        return bool(self.credentials or self.undeliverable_envs)

    @property
    def deliverable(self) -> bool:
        """Whether this toolkit can actually receive per-run keys."""
        return not self.undeliverable_envs

    @property
    def label(self) -> str:
        return self.toolkit_name.replace("_", " ").strip().capitalize()


@dataclasses.dataclass
class Discovery:
    models: Dict[str, ModelProvider]  # by offering slug
    tools: Dict[str, ToolEntry]  # by module slug (deduped — see _dedupe_tools)
    skipped: List[str]  # human-readable one-liners for the boot log

    def model_provider(self, slug: str) -> Optional[ModelProvider]:
        return self.models.get(slug)

    def tool(self, slug: str) -> Optional[ToolEntry]:
        return self.tools.get(slug)


def _module_source(module) -> str:
    try:
        return inspect.getsource(module)
    except (OSError, TypeError):
        return ""


def _scan_env_assignments(source: str) -> Dict[str, str]:
    """env var name → the variable assigned from it (first assignment wins)."""
    pairs: Dict[str, str] = {}
    for var, env in _ENV_ASSIGN_RE.findall(source):
        pairs.setdefault(env, var)
    return pairs


def _constructor_params(cls) -> Dict[str, Any]:
    try:
        sig = inspect.signature(cls.__init__)
    except (ValueError, TypeError):
        return {}
    return {
        name: param
        for name, param in sig.parameters.items()
        if name not in ("self", "kwargs", "args", "tools")
    }


def _dummy_for(annotation: Any) -> Any:
    """A throwaway value that satisfies the constructor's type expectation."""
    origin = getattr(annotation, "__origin__", None)
    # A bare bool never has an __origin__, so `annotation is bool` covers it
    # fully — the origin branch below only runs for subscripted annotations
    # (Optional[X], list[X], …), where annotation is never bool itself.
    if annotation is bool:
        return True
    if origin is not None:
        args = getattr(annotation, "__args__", ())
        for arg in args:
            if arg in (int,):
                return 1
            if arg in (float,):
                return 1.0
            if arg in (str,) or arg is Any or arg is object:
                return _DUMMY_STR
        return _DUMMY_STR
    if annotation is int:
        return 1
    if annotation is float:
        return 1.0
    return _DUMMY_STR


def _function_schema(fn: Function) -> Dict[str, Any]:
    """Name + description + lazily-processed json-schema parameters.

    Mirrors the stock /registry router: schemas derive lazily, so process a
    copy (never the shared instance) and fall back to the default schema.
    """
    params = fn.parameters
    default = {"type": "object", "properties": {}, "required": []}
    if params == default and fn.entrypoint and not fn.skip_entrypoint_processing:
        try:
            fn_copy = fn.model_copy(deep=False)
            fn_copy.process_entrypoint(strict=False)
            params = fn_copy.parameters
        except Exception:
            pass
    description = fn.description
    if description is None and fn.entrypoint:
        try:
            description = inspect.getdoc(fn.entrypoint)
        except Exception:
            description = None
    return {"name": fn.name, "description": description, "parameters": params}


def _dedupe_tools(candidates: List[Tuple[str, ToolEntry]], skipped: List[str]) -> Dict[str, ToolEntry]:
    """First toolkit wins per function-name set; identical sets are duplicates.

    Several agno classes expose the same functions under the same toolkit
    name (DuckDuckGoTools subclasses WebSearchTools with the same name and
    the same two functions). Function names are the registry's flat keys —
    two entries with identical sets are one capability. Scan order is
    alphabetical by module, so the earlier module wins; the skipped one is
    logged once.
    """
    out: Dict[str, ToolEntry] = {}
    seen_fn_sets: List[frozenset] = []
    for slug, entry in candidates:
        fn_set = frozenset(f["name"] for f in entry.functions)
        if fn_set in seen_fn_sets:
            skipped.append(
                f"toolkit {entry.module}.{entry.class_name} duplicates an already-scanned "
                f"function set ({', '.join(sorted(fn_set))}) — skipped"
            )
            continue
        if slug in out:
            # Same-module collision: two Toolkit subclasses in ONE agno
            # module with different function sets both pass the function-set
            # dedupe, but the slug key can hold only one — the later class
            # would silently overwrite the first. Keep that outcome (don't
            # change which one wins) and surface the overwrite like the
            # cross-module dedupe does.
            skipped.append(
                f"toolkit {slug}.{entry.class_name} overwrites the earlier "
                f"{slug}.{out[slug].class_name} (same module, different "
                f"function sets) — earlier entry skipped"
            )
        seen_fn_sets.append(fn_set)
        out[slug] = entry
    return out


def _offering_slug(module: str, cls: type) -> str:
    """The catalog slug for one offering class of a module.

    The slug mirrors where agno defines the class: the bare module name
    when the class lives in the module's own file — ``openrouter.py`` in
    ``openrouter/``, ``deepseek.py`` in ``deepseek/``, or a true
    single-file ``agno.models.foo`` module — otherwise
    ``<module>-<defining-submodule>`` (openai's doors: ``openai-chat``,
    ``openai-responses``). An underscore in the submodule name hyphenates
    (azure's ``openai_responses`` → ``azure-openai-responses``). Nothing
    is hand-picked and nothing can flip: the slug is a pure function of
    the module and the file the class is defined in.
    """
    tail = cls.__module__.rsplit(".", 1)[-1].replace("_", "-")
    if tail == module:
        return module
    return f"{module}-{tail}"


def discover_models() -> Tuple[Dict[str, ModelProvider], List[str]]:
    import importlib

    import agno.models as agno_models

    skipped: List[str] = []

    # Pass 1 — collect every Model subclass each module exports. Only what a
    # module DEFINES counts: a module that merely re-exports another
    # module's class does not offer it (the defining module already does).
    # Both of agno's layouts qualify as "defines": a package module
    # (``agno/models/foo/…`` — every current provider) and a single-file
    # module (``agno/models/foo.py`` defining ``Model`` subclasses directly,
    # ``__module__ == "agno.models.foo"``). A module that defines nothing
    # under either shape yields no offerings — that silence is correct for
    # pure re-export shims, and every other absence is logged below.
    exports: Dict[str, List[Tuple[str, type]]] = {}
    for mi in sorted(pkgutil.iter_modules(agno_models.__path__), key=lambda x: x.name):
        if mi.name.startswith("_") or mi.name in _MODEL_SKIP:
            continue
        try:
            mod = importlib.import_module(f"agno.models.{mi.name}")
        except Exception as e:
            skipped.append(f"model provider '{mi.name}' did not import ({e})")
            continue
        module_root = f"agno.models.{mi.name}"
        classes = [
            (name, obj)
            for name, obj in vars(mod).items()
            if inspect.isclass(obj)
            and issubclass(obj, Model)
            and obj is not Model
            and (
                obj.__module__ == module_root  # single-file module layout
                or obj.__module__.rsplit(".", 1)[0] == module_root  # package layout
            )
        ]
        if classes:
            exports[mi.name] = classes

    # Pass 2 — every defined class is an offering. No canonical picks, no
    # exclusion: classes other providers build on (openai's OpenAILike,
    # OpenResponses) are legitimate endpoints in their own right — a
    # self-hoster points OpenAILike at any OpenAI-schema server — and the
    # admin, not the scan, decides what to enable. The class graph alone
    # cannot separate "foundation" from "door" anyway (AzureOpenAIResponses
    # subclasses OpenAIResponses just as OpenRouter subclasses OpenAILike).

    # Pass 3 — one offering per class, each named by where agno defines it.
    # The slug is a pure function of (module, defining file): the bare
    # module name when the class lives in the module's own file (agno's
    # ``vendor/vendor.py`` convention — openrouter, xai, deepseek), and a
    # true single-file ``agno.models.foo`` module, otherwise
    # ``<module>-<file>`` (openai's doors: ``openai-chat``,
    # ``openai-responses``). There is no "primary" class and no tie-break
    # heuristic to flip out from under a saved row.
    out: Dict[str, ModelProvider] = {}
    for mod, classes in exports.items():
        for name, cls in sorted(classes, key=lambda nc: nc[0]):
            slug = _offering_slug(mod, cls)
            if slug in out:
                skipped.append(
                    f"model provider '{mod}.{name}' derived slug '{slug}', "
                    f"already taken by '{out[slug].module}.{out[slug].class_name}' — skipped"
                )
                continue

            # The env var the provider resolves its platform key from: scan the
            # class MRO's source (subclasses inherit _get_client_params and its
            # getenv call from the base provider class).
            env_key: Optional[str] = None
            for klass in cls.__mro__:
                try:
                    source = inspect.getsource(klass)
                except (OSError, TypeError):
                    continue
                found = sorted(set(_MODEL_ENV_RE.findall(source)))
                if found:
                    env_key = found[0]
                    break

            has_api_key_field = any(
                f.name == "api_key" for f in dataclasses.fields(cls)
            ) if dataclasses.is_dataclass(cls) else False

            try:
                cls(id="platform-scan-probe")  # keyless constructability probe
            except Exception as e:
                skipped.append(
                    f"model provider '{mod}.{name}' does not construct "
                    f"({type(e).__name__}: {str(e)[:80]}) — skipped"
                )
                continue

            out[slug] = ModelProvider(
                slug=slug,
                module=mod,
                class_name=name,
                cls=cls,
                platform_env_key=env_key,
                has_api_key_field=has_api_key_field,
            )
    return out, skipped


def discover_tools() -> Tuple[Dict[str, ToolEntry], List[str]]:
    import importlib

    import agno.tools as agno_tools

    skipped: List[str] = []
    candidates: List[Tuple[str, ToolEntry]] = []
    for mi in sorted(pkgutil.iter_modules(agno_tools.__path__), key=lambda x: x.name):
        if mi.name.startswith("_") or mi.ispkg or mi.name in _TOOL_SKIP:
            continue
        try:
            mod = importlib.import_module(f"agno.tools.{mi.name}")
        except Exception as e:
            skipped.append(f"toolkit '{mi.name}' did not import ({e})")
            continue
        pairs = _scan_env_assignments(_module_source(mod))
        for class_name, klass in vars(mod).items():
            if not (
                inspect.isclass(klass)
                and issubclass(klass, Toolkit)
                and klass is not Toolkit
                and klass.__module__ == mod.__name__
            ):
                continue
            params = _constructor_params(klass)
            credentials: List[ToolCredential] = []
            undeliverable: List[str] = []
            construct_kwargs: Dict[str, Any] = {}
            for env, var in sorted(pairs.items()):
                arg = var if var in params else None
                if arg is None:
                    # The env var is read directly (no constructor arg) — no
                    # per-run delivery path for it.
                    if _CRED_ENV_RE.search(env):
                        undeliverable.append(env)
                    continue
                construct_kwargs[arg] = _dummy_for(params[arg].annotation)
                if _CRED_ENV_RE.search(env):
                    credentials.append(
                        ToolCredential(
                            env=env,
                            arg=arg,
                            dep_key=f"{mi.name}_{arg}",
                            label=arg.replace("_", " ").strip().capitalize(),
                        )
                    )
            try:
                instance = klass(**construct_kwargs)
            except Exception as e:
                skipped.append(
                    f"toolkit '{mi.name}.{class_name}' does not construct "
                    f"({type(e).__name__}: {str(e)[:80]}) — skipped"
                )
                continue
            functions = [_function_schema(fn) for fn in instance.get_functions().values()]
            if not functions:
                continue
            candidates.append(
                (
                    mi.name,
                    ToolEntry(
                        module=mi.name,
                        class_name=class_name,
                        cls=klass,
                        toolkit_name=instance.name,
                        functions=functions,
                        credentials=credentials,
                        undeliverable_envs=undeliverable,
                    ),
                )
            )
    return _dedupe_tools(candidates, skipped), skipped


_CACHE: Optional[Discovery] = None


def discover() -> Discovery:
    """Run the full scan once per process (see module docstring for why)."""
    global _CACHE
    if _CACHE is None:
        models, model_skips = discover_models()
        tools, tool_skips = discover_tools()
        for line in model_skips + tool_skips:
            log_info(f"discovery: {line}")
        log_info(
            f"discovery: {len(models)} model providers, {len(tools)} toolkits available on this deployment"
        )
        _CACHE = Discovery(models=models, tools=tools, skipped=model_skips + tool_skips)
    return _CACHE

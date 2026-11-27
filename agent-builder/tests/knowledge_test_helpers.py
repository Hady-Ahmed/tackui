"""Knowledge-test helpers: the deterministic fake embedder + corpus builders.

The knowledge tests must run with NO network (#233): embeddings are fake
vectors whose values the tests control, so retrieval assertions are exact
(texts sharing vocabulary land in shared hash buckets and score similar;
disjoint vocabularies score ~orthogonal). The fake replaces the OpenAI
embedder at the ONE seam the service already has for provider dispatch
(``knowledge._provider_embedder``) — the routes and ``build_knowledge_for``
run unmodified against it.
"""
import hashlib
import math
import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from agno.knowledge.embedder.base import Embedder

import knowledge as knowledge_store


@dataclass
class FakeEmbedder(Embedder):
    """A deterministic, offline ``Embedder`` — token-bucket vectors, no network.

    Each token hashes into one of ``dimensions`` buckets and accumulates; the
    result is L2-normalized. Deterministic across runs (sha256, no RNG), so
    tests can assert exact retrieval: a query embedding maximally overlaps the
    documents sharing its vocabulary.

    Attributes:
        dimensions: Vector width / bucket count. MUST stay at 1536 — the real
            ``OpenAIEmbedder``'s default — because the shared
            ``builder_knowledge`` table's ``Vector(N)`` column is typed by
            whichever embedder FIRST creates it and the table is truncated,
            never dropped, between tests: a different fake width would make
            the key-free list route (real embedder) and the fake-embedder
            tests fight over one baked dimensionality.
    """

    dimensions: int = 1536

    def _vector(self, text: str) -> List[float]:
        """Hash every token into its bucket and normalize the result.

        Args:
            text: The text to embed.

        Returns:
            The normalized bucket vector.
        """
        vector = [0.0] * self.dimensions
        for token in re.findall(r"\w+", (text or "").lower()):
            index = int(hashlib.sha256(token.encode("utf-8")).hexdigest(), 16) % self.dimensions
            vector[index] += 1.0
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    def get_embedding(self, text: str) -> List[float]:
        """Embed one text (sync path).

        Args:
            text: The text to embed.

        Returns:
            The normalized bucket vector.
        """
        return self._vector(text)

    def get_embedding_and_usage(self, text: str) -> Tuple[List[float], Optional[dict]]:
        """Embed one text, reporting no usage (the fake spends nothing).

        Args:
            text: The text to embed.

        Returns:
            ``(vector, None)``.
        """
        return self._vector(text), None

    async def async_get_embedding(self, text: str) -> List[float]:
        """Embed one text (async path — same deterministic vector).

        Args:
            text: The text to embed.

        Returns:
            The normalized bucket vector.
        """
        return self._vector(text)

    async def async_get_embedding_and_usage(self, text: str) -> Tuple[List[float], Optional[dict]]:
        """Embed one text (async path, no usage).

        Args:
            text: The text to embed.

        Returns:
            ``(vector, None)``.
        """
        return self._vector(text), None


class RejectingEmbedder(FakeEmbedder):
    """A ``FakeEmbedder`` whose embed calls FAIL — the provider-rejection
    shape (an expired key's 401) without network. Construction succeeds (the
    embedder builds fine); every embed attempt raises, so ingest marks the
    content row failed with agno's classified ``status_message``.
    """

    def _reject(self, text: str) -> List[float]:
        """The failure itself (every path routes here).

        Args:
            text: The text the caller tried to embed.

        Raises:
            RuntimeError: Always — the simulated provider rejection.
        """
        raise RuntimeError("simulated provider rejection")

    def get_embedding(self, text: str) -> List[float]:
        """Fail the sync embed (see ``_reject``).

        Args:
            text: The text the caller tried to embed.

        Raises:
            RuntimeError: The simulated provider rejection.
        """
        self._reject(text)
        raise AssertionError("unreachable")

    def get_embedding_and_usage(self, text: str) -> Tuple[List[float], Optional[dict]]:
        """Fail the sync embed-with-usage (see ``_reject``).

        Args:
            text: The text the caller tried to embed.

        Raises:
            RuntimeError: The simulated provider rejection.
        """
        self._reject(text)
        raise AssertionError("unreachable")

    async def async_get_embedding(self, text: str) -> List[float]:
        """Fail the async embed (see ``_reject``).

        Args:
            text: The text the caller tried to embed.

        Raises:
            RuntimeError: The simulated provider rejection.
        """
        self._reject(text)
        raise AssertionError("unreachable")

    async def async_get_embedding_and_usage(self, text: str) -> Tuple[List[float], Optional[dict]]:
        """Fail the async embed-with-usage (see ``_reject``).

        Args:
            text: The text the caller tried to embed.

        Raises:
            RuntimeError: The simulated provider rejection.
        """
        self._reject(text)
        raise AssertionError("unreachable")


def build_fake_knowledge(component_id: str, db, db_url: str):
    """Build one corpus's Knowledge instance with the fake embedder.

    The same construction the service's routes perform
    (:func:`knowledge.build_knowledge_for`) with the embedder swapped for the
    offline fake — the tests exercise the REAL isolation/processing mechanics
    against a real pgvector container without any OpenAI call.

    Args:
        component_id: The component whose corpus to build.
        db: The agno PostgresDb used as the corpus's contents db.
        db_url: The vector-store DSN (the throwaway container's).

    Returns:
        A fresh Knowledge instance named ``kb-<component_id>``.
    """
    return knowledge_store.build_knowledge(
        component_id,
        db,
        FakeEmbedder(),
        db_url=db_url,
    )

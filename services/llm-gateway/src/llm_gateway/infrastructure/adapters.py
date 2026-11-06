"""PII detection (Presidio), short-lived stores (memory / Redis), embeddings (Triton / stub)."""

from __future__ import annotations

import hashlib
import math
import time
from typing import Any

import httpx
from atlas_platform.presidio import PresidioDetector

from llm_gateway.application.ports import ProviderUnavailableError

# --- Short-lived key/value state ------------------------------------------------------------------


class MemoryKeyValueStore:
    """Single-process store for development and tests (production uses Redis)."""

    def __init__(self, clock: Any = None) -> None:
        self._data: dict[str, tuple[str, float]] = {}
        self._now = (lambda: clock.now().timestamp()) if clock else time.time

    async def get(self, key: str) -> str | None:
        item = self._data.get(key)
        if item is None:
            return None
        value, expires = item
        if expires <= self._now():
            self._data.pop(key, None)
            return None
        return value

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        self._data[key] = (value, self._now() + ttl_seconds)

    def keys(self) -> list[str]:
        return list(self._data)


class RedisKeyValueStore:
    def __init__(self, url: str) -> None:
        import redis.asyncio as redis

        self._redis = redis.from_url(url, decode_responses=True)

    async def get(self, key: str) -> str | None:
        value = await self._redis.get(key)
        return value if isinstance(value, str) else None

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        await self._redis.set(key, value, ex=ttl_seconds)

    async def ping(self) -> None:
        await self._redis.ping()


# --- Embeddings ---------------------------------------------------------------------------------


class TritonEmbeddings:
    """bge-m3 served by Triton (KServe v2 HTTP). The same model runs on a CPU instance group in
    development; the response always names the model that produced the vectors."""

    def __init__(
        self,
        base_url: str,
        *,
        model: str = 'bge-m3',
        triton_model: str = 'bge_m3',
        timeout: float = 5.0,
    ) -> None:
        self.model = model
        self._url = f'{base_url.rstrip("/")}/v2/models/{triton_model}/infer'
        self._client = httpx.AsyncClient(timeout=timeout)

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], float]:
        body = {
            'inputs': [
                {'name': 'TEXT', 'shape': [len(texts), 1], 'datatype': 'BYTES', 'data': texts}
            ],
            'outputs': [{'name': 'EMBEDDING'}],
        }
        started = time.perf_counter()
        try:
            response = await self._client.post(self._url, json=body)
        except httpx.HTTPError as error:
            raise ProviderUnavailableError(f'triton: {type(error).__name__}') from error
        if response.status_code >= 500:
            raise ProviderUnavailableError(f'triton: HTTP {response.status_code}')
        response.raise_for_status()
        out = next(o for o in response.json()['outputs'] if o['name'] == 'EMBEDDING')
        rows, dim = out['shape']
        flat: list[float] = out['data']
        vectors = [flat[i * dim : (i + 1) * dim] for i in range(rows)]
        # Wall time on the GPU pool is what the tenant is charged for.
        return vectors, time.perf_counter() - started


class StubEmbeddings:
    """Deterministic hashed bag-of-words vectors (dev and tests). Named honestly, so callers that
    check the model (taxonomy-svc) can tell stub vectors from bge-m3."""

    def __init__(
        self, model: str = 'stub-hash-1024', dim: int = 1024, gpu_seconds_per_input: float = 0.01
    ) -> None:
        self.model = model
        self.dim = dim
        self.per_input = gpu_seconds_per_input
        self.down = False

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], float]:
        if self.down:
            raise ProviderUnavailableError('stub embeddings are down')
        vectors = []
        for text in texts:
            v = [0.0] * self.dim
            for word in text.lower().split():
                h = int.from_bytes(hashlib.sha256(word.encode()).digest()[:8], 'big')
                v[h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
            norm = math.sqrt(sum(x * x for x in v)) or 1.0
            vectors.append([x / norm for x in v])
        return vectors, self.per_input * len(texts)


__all__ = ['PresidioDetector']

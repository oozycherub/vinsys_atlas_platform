"""Persistence ports and the records they hold."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from atlas_platform.db import Tx

LIVE_STATUSES = ('queued', 'running')
FINAL_STATUSES = ('succeeded', 'failed', 'failed_retryable', 'quarantined')


@dataclass
class Job:
    tenant_id: str
    job_id: str
    document_id: str
    candidate_id: str
    storage_key: str
    mime_type: str
    byte_size: int
    origin: str  # event | api | bulk
    parser_version: str
    status: str = 'queued'
    stage: str | None = None
    progress: int = 0
    attempts: int = 0
    error_code: str | None = None
    flags: list[str] = field(default_factory=list)
    batch_id: str | None = None
    idempotency_key: str | None = None
    result: dict[str, Any] | None = None
    created_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


@dataclass(frozen=True)
class StoredChunk:
    chunk_type: str
    chunk_index: int
    content: str
    token_count: int
    vector: list[float]


@dataclass(frozen=True)
class SearchHit:
    candidate_id: str
    document_id: str | None
    chunk_type: str
    chunk_index: int
    score: float
    embedding: list[float] | None = None


class JobRepository(Protocol):
    async def insert(self, tx: Tx, job: Job) -> Job:
        """Inserts, or returns the live job for the same document (or idempotency key)."""
        ...

    async def get(self, tx: Tx, job_id: str) -> Job | None: ...

    async def set_stage(self, tx: Tx, job_id: str, stage: str, progress: int) -> None: ...

    async def finish(
        self,
        tx: Tx,
        job_id: str,
        status: str,
        *,
        error_code: str | None = None,
        flags: list[str] | None = None,
        result: dict[str, Any] | None = None,
    ) -> bool:
        """Moves a live job to a final status; False when it already was final."""
        ...

    async def claim(self, tx: Tx, limit: int, per_tenant_cap: int) -> list[Job]:
        """System transaction: next queued jobs, round-robin across tenants, marked running."""
        ...

    async def delete_candidate(self, tx: Tx, candidate_id: str) -> int: ...


class EmbeddingRepository(Protocol):
    async def replace(
        self,
        tx: Tx,
        *,
        tenant_id: str,
        candidate_id: str,
        document_id: str,
        model_id: str,
        chunks: list[StoredChunk],
    ) -> int: ...

    async def search(
        self,
        tx: Tx,
        *,
        model_id: str,
        vector: list[float],
        k: int,
        chunk_types: list[str] | None,
        candidate_ids: list[str] | None = None,
        per_candidate: int | None = None,
        include_vectors: bool = False,
    ) -> list[SearchHit]: ...

    async def chunks_without(
        self, tx: Tx, *, have: str, missing: str, limit: int
    ) -> list[dict[str, Any]]:
        """Chunks embedded with `have` whose (candidate, type, index) has no `missing` row."""
        ...

    async def insert_one(
        self, tx: Tx, *, row: dict[str, Any], model_id: str, vector: list[float]
    ) -> None: ...

    async def delete_candidate(self, tx: Tx, candidate_id: str) -> int: ...

    async def count(self, tx: Tx, candidate_id: str) -> int: ...


class ModelSlots(Protocol):
    async def get(self, tx: Tx) -> tuple[str, str | None]:
        """(active, shadow) embedding model ids."""
        ...

    async def set(self, tx: Tx, slot: str, model_id: str | None, by: str) -> None: ...


class BatchRepository(Protocol):
    async def create(
        self, tx: Tx, *, tenant_id: str, batch_id: str, by: str, items: list[tuple[str, int]]
    ) -> None: ...

    async def get(self, tx: Tx, batch_id: str) -> dict[str, Any] | None: ...

    async def items(self, tx: Tx, batch_id: str) -> list[dict[str, Any]]: ...

    async def set_status(
        self, tx: Tx, batch_id: str, status: str, error_code: str | None = None
    ) -> None: ...

    async def update_item(self, tx: Tx, batch_id: str, index: int, **fields: Any) -> None: ...

    async def is_placeholder(self, tx: Tx, candidate_id: str) -> bool: ...

    async def forget_candidate(self, tx: Tx, candidate_id: str) -> int: ...


class Outbox(Protocol):
    async def append(
        self,
        tx: Tx,
        *,
        topic: str,
        tenant_id: str | None,
        aggregate_type: str,
        aggregate_id: str,
        payload: dict[str, Any],
    ) -> str: ...

"""Ports: what the application needs from the outside world. Adapters live in infrastructure/."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol

from atlas_platform.db import Tx

from llm_gateway.domain.policy import BudgetLimits, BudgetUsage, Level
from llm_gateway.domain.redaction import Detection
from llm_gateway.domain.templates import Effort, PromptTemplate


class Clock(Protocol):
    def now(self) -> datetime: ...


# --- Providers ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class ProviderRequest:
    model: str
    system: str
    messages: list[dict[str, Any]]
    max_tokens: int
    effort: Effort
    output_schema: dict[str, Any] | None = None
    tools: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass(frozen=True)
class ProviderResponse:
    model: str
    text: str
    stop_reason: str
    input_tokens: int
    output_tokens: int
    tool_calls: list[ToolCall] = field(default_factory=list)
    #: The assistant turn as wire-format content blocks (for continuing a tool loop).
    content: list[dict[str, Any]] = field(default_factory=list)
    refusal_category: str | None = None


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class StreamDone:
    response: ProviderResponse


StreamEvent = TextDelta | StreamDone


class ProviderUnavailableError(Exception):
    """Infrastructure failure (5xx, overloaded, timeout, connection): try the next target."""


class ProviderRejectedError(Exception):
    """The provider refused the request itself (4xx): failing over would not help."""


class LlmProvider(Protocol):
    name: str

    async def create(self, request: ProviderRequest) -> ProviderResponse: ...

    def stream(self, request: ProviderRequest) -> AsyncIterator[StreamEvent]: ...


@dataclass(frozen=True)
class RouteTarget:
    provider: str
    model: str


class EmbeddingProvider(Protocol):
    model: str

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], float]:
        """Returns one vector per input and the GPU seconds the batch used."""
        ...


# --- PII ---------------------------------------------------------------------------------------


class PiiDetector(Protocol):
    async def detect(self, text: str) -> list[Detection]: ...


# --- Short-lived state (Redis in production) -------------------------------------------------------


class KeyValueStore(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ttl_seconds: int) -> None: ...


# --- Persistence -------------------------------------------------------------------------------------


class PromptRepository(Protocol):
    async def get(self, tx: Tx, prompt_id: str, version: int) -> PromptTemplate | None: ...

    async def insert(self, tx: Tx, template: PromptTemplate) -> bool: ...

    async def retire(self, tx: Tx, prompt_id: str, version: int) -> bool: ...

    async def versions(self, tx: Tx, prompt_id: str) -> list[PromptTemplate]: ...


class BudgetRepository(Protocol):
    async def limits(self, tx: Tx, tenant_id: str) -> BudgetLimits | None: ...

    async def set_limits(self, tx: Tx, tenant_id: str, limits: BudgetLimits, by: str) -> None: ...

    async def usage(self, tx: Tx, tenant_id: str, period: str) -> BudgetUsage: ...

    async def add(
        self, tx: Tx, tenant_id: str, period: str, tokens: int, gpu_seconds: float
    ) -> tuple[BudgetUsage, BudgetUsage]:
        """Atomically adds usage; returns (before, after)."""
        ...

    async def mark_alerted(self, tx: Tx, tenant_id: str, period: str, level: Level) -> None: ...


@dataclass
class CallRecord:
    tenant_id: str
    call_id: str
    created_at: datetime
    kind: Literal['messages', 'stream', 'embeddings']
    purpose: str
    status: str
    prompt_id: str | None = None
    prompt_version: int | None = None
    route: str | None = None
    model: str | None = None
    provider: str | None = None
    error_code: str | None = None
    attempts: list[dict[str, Any]] = field(default_factory=list)
    input_redacted: Any = None
    output_redacted: Any = None
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    overhead_ms: int = 0
    injection_scores: dict[str, float] = field(default_factory=dict)


class CallLog(Protocol):
    async def insert(self, tx: Tx, record: CallRecord) -> None: ...


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


class PurgeRepository(Protocol):
    async def purge_tenant(self, tx: Tx) -> dict[str, int]: ...

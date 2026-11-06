"""Ports: what the pipeline needs from the outside world. Adapters live in infrastructure/."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from atlas_platform.pii import Detection

from parsing_svc.domain.layout import LayoutDoc
from parsing_svc.domain.redact import Contact


class Clock(Protocol):
    def now(self) -> datetime: ...


class UpstreamError(Exception):
    """A dependency is down or slow (S3, ClamAV, llm-gateway, taxonomy, profile-svc). Retryable."""


class UpdateError(UpstreamError):
    """A dependency answered with an unexpected error. Retried like an outage, then reported."""


class ObjectStorage(Protocol):
    async def get(self, key: str) -> bytes: ...

    async def put(self, key: str, data: bytes, content_type: str) -> None: ...

    async def move(self, source: str, target: str) -> None: ...


class MalwareScanner(Protocol):
    name: str

    async def scan(self, data: bytes) -> str | None:
        """The signature found, or None when the file is clean."""
        ...


class Extractor(Protocol):
    def extract(self, mime: str, data: bytes) -> LayoutDoc:
        """Text and layout (CPU-bound; run in a thread). Raises PipelineError."""
        ...

    def sanitize_pdf(self, data: bytes) -> bytes:
        """Removes JavaScript and embedded files and re-serialises. Raises PipelineError for
        an encrypted or corrupt PDF."""
        ...


class OcrEngine(Protocol):
    async def ocr(self, mime: str, data: bytes) -> LayoutDoc: ...


class PiiDetector(Protocol):
    async def detect(self, text: str) -> list[Detection]: ...


@dataclass(frozen=True)
class LlmExtraction:
    data: dict[str, Any]
    model: str
    injection_score: float


class LlmExtractor(Protocol):
    async def extract(self, tenant_id: str, text: str, known_pii: list[str]) -> LlmExtraction:
        """Raises UpstreamError (retry) or PipelineError (final)."""
        ...


@dataclass(frozen=True)
class NormalizedTerm:
    term: str
    skill_id: str | None
    confidence: float
    method: str  # alias | ann | none


class Taxonomy(Protocol):
    async def normalize(self, tenant_id: str, terms: list[str]) -> list[NormalizedTerm]: ...


class Embedder(Protocol):
    async def embed(self, tenant_id: str, texts: list[str], model: str) -> list[list[float]]:
        """Vectors from exactly `model` (the response's model is checked). Raises
        UpstreamError."""
        ...


@dataclass(frozen=True)
class DocumentInfo:
    document_id: str
    candidate_id: str
    mime_type: str
    byte_size: int
    parse_status: str


@dataclass(frozen=True)
class UploadTarget:
    document_id: str
    url: str
    headers: dict[str, str]


class DuplicateDocumentError(Exception):
    def __init__(self, document_id: str | None) -> None:
        super().__init__('duplicate document')
        self.document_id = document_id


class EmailTakenError(Exception):
    """profile-svc already has a candidate with this email (same person, earlier résumé)."""


class ProfileApi(Protocol):
    async def get_document(self, tenant_id: str, document_id: str) -> DocumentInfo | None: ...

    async def create_candidate(
        self, tenant_id: str, placeholder_name: str, external_ref: str, idempotency_key: str
    ) -> str: ...

    async def initiate_upload(
        self, tenant_id: str, candidate_id: str, mime_type: str, byte_size: int, sha256: str
    ) -> UploadTarget: ...

    async def upload(self, target: UploadTarget, data: bytes) -> None: ...

    async def update_contact(self, tenant_id: str, candidate_id: str, contact: Contact) -> None: ...

    async def get_contact(self, tenant_id: str, candidate_id: str) -> Contact | None:
        """The candidate's known PII (scope pii:read), redacted wherever it appears."""
        ...

"""Pipeline failures. Each carries the stable error code the PRD defines (§2.1(d))."""

from __future__ import annotations

from typing import Literal

ParseErrorCode = Literal[
    'UNREADABLE_DOCUMENT',
    'ENCRYPTED_DOCUMENT',
    'MALICIOUS_FILE',
    'LLM_UNAVAILABLE',
    'UNSUPPORTED_DOCUMENT',
    'DEPENDENCY_UNAVAILABLE',
]
QuarantineReason = Literal['malware', 'zip_bomb', 'active_content', 'mime_mismatch']


class PipelineError(Exception):
    """A document that cannot be parsed. `retryable` failures go to the DLQ for a later re-parse;
    the others are final. A `quarantine` reason moves the object out of the tenant's prefix."""

    def __init__(
        self,
        code: ParseErrorCode,
        detail: str,
        *,
        retryable: bool = False,
        quarantine: QuarantineReason | None = None,
        signature: str | None = None,
    ) -> None:
        super().__init__(detail)
        self.code: ParseErrorCode = code
        self.detail = detail
        self.retryable = retryable
        self.quarantine: QuarantineReason | None = quarantine
        self.signature = signature


def malicious(reason: QuarantineReason, detail: str, signature: str | None = None) -> PipelineError:
    return PipelineError('MALICIOUS_FILE', detail, quarantine=reason, signature=signature)

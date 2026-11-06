"""Domain failures. They subclass the platform's AppError, which carries no HTTP types: the HTTP
layer maps `kind` to a status (RFC 9457)."""

from __future__ import annotations

from atlas_platform.errors import AppError


class PlanError(AppError):
    """An interview plan is invalid (structure, weights, or a blocked question)."""

    def __init__(self, message: str) -> None:
        super().__init__('validation', 'INVALID_PLAN', message)


class InterviewError(AppError):
    """A domain rule refused the request."""

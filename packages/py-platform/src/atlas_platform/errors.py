"""Domain failures, free of HTTP types. The HTTP layer maps `kind` to a status (RFC 9457)."""

from __future__ import annotations

from typing import Any, Literal

ErrorKind = Literal[
    'validation',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'precondition',
    'rule',
    'too_many',
    'upstream_invalid',
    'unavailable',
]

STATUS: dict[ErrorKind, int] = {
    'validation': 400,
    'unauthorized': 401,
    'forbidden': 403,
    'not_found': 404,
    'conflict': 409,
    'precondition': 412,
    'rule': 422,
    'too_many': 429,
    'upstream_invalid': 502,
    'unavailable': 503,
}

TITLES: dict[ErrorKind, str] = {
    'validation': 'Bad request',
    'unauthorized': 'Unauthorized',
    'forbidden': 'Forbidden',
    'not_found': 'Not found',
    'conflict': 'Conflict',
    'precondition': 'Precondition failed',
    'rule': 'Domain rule violated',
    'too_many': 'Too many requests',
    'upstream_invalid': 'Bad gateway',
    'unavailable': 'Service unavailable',
}


class AppError(Exception):
    """A failure with a stable machine-readable code. Extensions become problem members;
    `retry_after` (seconds) also becomes the Retry-After header."""

    def __init__(self, kind: ErrorKind, code: str, message: str, **extensions: Any) -> None:
        super().__init__(message)
        self.kind: ErrorKind = kind
        self.code = code
        self.message = message
        self.extensions = extensions

    @property
    def status(self) -> int:
        return STATUS[self.kind]

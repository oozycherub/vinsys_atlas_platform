"""Domain failures. The gateway uses the platform's AppError (RFC 9457 kinds and codes)."""

from __future__ import annotations

from atlas_platform.errors import AppError as GatewayError
from atlas_platform.errors import ErrorKind

__all__ = ['ErrorKind', 'GatewayError']

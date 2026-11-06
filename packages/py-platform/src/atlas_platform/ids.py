"""Identifiers: UUIDv7 (RFC 9562), as every Atlas service generates them."""

from __future__ import annotations

import time
import uuid


def uuid7() -> str:
    ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(uuid.uuid4().bytes[6:], 'big')
    value = (ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | (rand & ((1 << 76) - 1))
    value = (value & ~(0x3 << 62)) | (0x2 << 62)
    return str(uuid.UUID(int=value))


def is_uuid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return len(value) == 36

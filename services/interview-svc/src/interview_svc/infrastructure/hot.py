"""Hot state (PRD §2.4b): the latest checkpoint in Redis under `t:{tid}:iv:{sid}`, TTL 2 h.
Postgres stays the source of truth; the copy is used only when its seq is current."""

from __future__ import annotations

import contextlib
import json
from typing import Any, cast

from interview_svc.application.ports import Checkpoint
from interview_svc.domain.state import InterviewState

TTL_S = 2 * 60 * 60


def key(tenant_id: str, session_id: str) -> str:
    return f't:{tenant_id}:iv:{session_id}'


def _encode(cp: Checkpoint) -> str:
    return json.dumps({'seq': cp.seq, 'node': cp.node, 'state': cp.state}, separators=(',', ':'))


def _decode(raw: str | bytes | None) -> Checkpoint | None:
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        return Checkpoint(int(data['seq']), str(data['node']), cast(InterviewState, data['state']))
    except (ValueError, KeyError, TypeError):
        return None  # a corrupt copy is just a cache miss


class MemoryHotState:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    async def get(self, tenant_id: str, session_id: str) -> Checkpoint | None:
        return _decode(self.data.get(key(tenant_id, session_id)))

    async def put(self, tenant_id: str, session_id: str, checkpoint: Checkpoint) -> None:
        self.data[key(tenant_id, session_id)] = _encode(checkpoint)

    async def drop(self, tenant_id: str, session_id: str) -> None:
        self.data.pop(key(tenant_id, session_id), None)


class RedisHotState:
    """Failures degrade to Postgres reads: the hot copy is an optimisation, never required."""

    def __init__(self, client: Any) -> None:
        self.redis = client

    async def get(self, tenant_id: str, session_id: str) -> Checkpoint | None:
        try:
            return _decode(await self.redis.get(key(tenant_id, session_id)))
        except Exception:  # noqa: BLE001 - cache miss
            return None

    async def put(self, tenant_id: str, session_id: str, checkpoint: Checkpoint) -> None:
        with contextlib.suppress(Exception):  # the next read falls back to Postgres
            await self.redis.set(key(tenant_id, session_id), _encode(checkpoint), ex=TTL_S)

    async def drop(self, tenant_id: str, session_id: str) -> None:
        with contextlib.suppress(Exception):
            await self.redis.delete(key(tenant_id, session_id))

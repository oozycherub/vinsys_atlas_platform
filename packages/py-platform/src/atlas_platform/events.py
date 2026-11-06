"""Transactional outbox and consumer de-duplication (MASTER_ORCHESTRATION_PROMPT §4.4)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from psycopg.types.json import Jsonb

from atlas_platform.db import Tx
from atlas_platform.ids import is_uuid, uuid7


class PgOutbox:
    async def append(
        self,
        tx: Tx,
        *,
        topic: str,
        tenant_id: str | None,
        aggregate_type: str,
        aggregate_id: str,
        payload: dict[str, Any],
    ) -> str:
        event_id = uuid7()
        await tx.execute(
            """INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, topic, payload)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (event_id, tenant_id, aggregate_type, aggregate_id, topic, Jsonb(payload)),
        )
        return event_id


class PgProcessedEvents:
    async def first_time(self, tx: Tx, consumer: str, event_id: str) -> bool:
        count = await tx.execute(
            'INSERT INTO processed_events (consumer, event_id) VALUES (%s, %s) ON CONFLICT DO NOTHING',
            (consumer, event_id),
        )
        return count == 1


def parse_outbox_record(
    headers: Mapping[str, bytes | None], value: bytes | None
) -> tuple[str, dict[str, Any]]:
    """(event_id, payload) from a Debezium outbox-router record, as @atlas/platform parses it:
    `event_id` header, JSON value (unwrapped once if Debezium encoded the jsonb as a string).
    Raises ValueError for a poison record (send it to the DLQ)."""
    raw_id = headers.get('event_id')
    event_id = raw_id.decode() if raw_id else ''
    if not is_uuid(event_id):
        raise ValueError('missing or invalid event_id header')
    if value is None:
        raise ValueError('empty value')
    try:
        payload = json.loads(value)
        if isinstance(payload, str):
            payload = json.loads(payload)
    except json.JSONDecodeError as error:
        raise ValueError('value is not JSON') from error
    if not isinstance(payload, dict):
        raise ValueError('payload is not an object')
    return event_id, payload

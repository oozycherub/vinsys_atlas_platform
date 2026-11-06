"""Consumed events (at-least-once; each is applied and de-duplicated in one transaction)."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from atlas_platform.db import Database
from atlas_platform.events import PgProcessedEvents
from atlas_platform.ids import is_uuid

from interview_svc.application.ports import Clock, Outbox, Recorder, Store

log = logging.getLogger('interview_svc')

CONSUMER = 'interview-svc'
SERVICE = 'interview-svc'
SESSION_STARTED = 'assessment.session.started.v1'
ERASURE = 'privacy.erasure.requested.v1'
PURGED = 'tenant.tenant.purged.v1'
TOPICS = (SESSION_STARTED, ERASURE, PURGED)


def _uuid(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not is_uuid(value):
        raise ValueError(f'{key} missing or invalid')
    return str(value)


class EventHandlers:
    def __init__(
        self, db: Database, store: Store, outbox: Outbox, recorder: Recorder, clock: Clock
    ) -> None:
        self.db = db
        self.store = store
        self.outbox = outbox
        self.recorder = recorder
        self.clock = clock
        self.seen = PgProcessedEvents()

    async def handle(self, topic: str, event_id: str, payload: dict[str, Any]) -> bool:
        """True when the event had an effect, False for a duplicate. ValueError: poison (DLQ)."""
        tenant_id = _uuid(payload, 'tenant_id')
        recordings: list[str] = []
        async with self.db.tenant_tx(tenant_id) as tx:
            if topic == SESSION_STARTED:
                assessment_id = _uuid(payload, 'assessment_id')
                session_id = _uuid(payload, 'session_id')
                deadline = datetime.fromisoformat(str(payload['deadline_at']))
                if not await self.seen.first_time(tx, CONSUMER, event_id):
                    return False
                # Allocation hint (ADR-0008 §3): an assessment that has had voice interviews will
                # likely need an agent soon, so KEDA can scale before the candidate gets there.
                if await self.store.assessment_has_voice(tx, assessment_id):
                    await self.store.add_demand(tx, tenant_id, session_id, assessment_id, deadline)
                return True
            if topic == ERASURE:
                candidate_id = _uuid(payload, 'candidate_id')
                if not await self.seen.first_time(tx, CONSUMER, event_id):
                    return False
                count, recordings = await self.store.delete_candidate(tx, candidate_id)
                if SERVICE in payload.get('ack_required_from', []):
                    await self.outbox.append(
                        tx,
                        topic='privacy.erasure.acknowledged.v1',
                        tenant_id=tenant_id,
                        aggregate_type='privacy_request',
                        aggregate_id=_uuid(payload, 'request_id'),
                        payload={
                            'tenant_id': tenant_id,
                            'request_id': payload['request_id'],
                            'service': SERVICE,
                            'occurred_at': self.clock.now().isoformat(),
                        },
                    )
                log.info('candidate erased', extra={'tenant_id': tenant_id, 'sessions': count})
            elif topic == PURGED:
                if not await self.seen.first_time(tx, CONSUMER, event_id):
                    return False
                counts = await self.store.purge_tenant(tx)
                log.info('tenant purged', extra={'tenant_id': tenant_id, **counts})
            else:
                raise ValueError(f'unexpected topic {topic}')
        if recordings:
            await self.recorder.delete(recordings)
        return True

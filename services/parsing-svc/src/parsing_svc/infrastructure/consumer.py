"""Kafka consumers (Debezium outbox records, at-least-once): uploads start jobs, erasure and
tenant purge delete data. Each event is processed and de-duplicated in one transaction."""

from __future__ import annotations

import logging
from typing import Any

from atlas_platform.db import Database
from atlas_platform.events import PgProcessedEvents, parse_outbox_record
from atlas_platform.ids import is_uuid

from parsing_svc.application.admin import DataProtection
from parsing_svc.application.jobs import JobService

log = logging.getLogger('parsing_svc')

CONSUMER = 'parsing-svc'
UPLOADED = 'profile.resume.uploaded.v1'
ERASURE = 'privacy.erasure.requested.v1'
PURGED = 'tenant.tenant.purged.v1'
TOPICS = (UPLOADED, ERASURE, PURGED)


class EventHandlers:
    def __init__(self, db: Database, jobs: JobService, protection: DataProtection) -> None:
        self.db = db
        self.jobs = jobs
        self.protection = protection
        self.seen = PgProcessedEvents()

    async def handle(self, topic: str, event_id: str, payload: dict[str, Any]) -> bool:
        """True when the event had an effect, False for a duplicate. Raises ValueError for a
        malformed payload (DLQ)."""
        tenant_id = payload.get('tenant_id')
        if not is_uuid(tenant_id):
            raise ValueError('tenant_id missing or invalid')
        assert isinstance(tenant_id, str)
        if topic == UPLOADED:
            for key in ('document_id', 'candidate_id'):
                if not is_uuid(payload.get(key)):
                    raise ValueError(f'{key} missing or invalid')
            job = self.jobs.job_from_upload(payload)
            async with self.db.tenant_tx(tenant_id) as tx:
                if not await self.seen.first_time(tx, CONSUMER, event_id):
                    return False
                await self.jobs.jobs.insert(tx, job)  # the live job is reused if one exists
            return True
        async with self.db.tenant_tx(tenant_id) as tx:
            if not await self.seen.first_time(tx, CONSUMER, event_id):
                return False
            if topic == ERASURE:
                if not is_uuid(payload.get('candidate_id')):
                    raise ValueError('candidate_id missing or invalid')
                counts = await self.protection.erase(tx, payload)
            elif topic == PURGED:
                counts = await self.protection.purge_tenant(tx)
            else:
                raise ValueError(f'unexpected topic {topic}')
        log.info('event applied', extra={'topic': topic, 'tenant_id': tenant_id, **counts})
        return True


async def run_consumer(
    handlers: EventHandlers, brokers: str, dlq: str = 'parsing-svc.dlq'
) -> None:  # pragma: no cover
    from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

    consumer = AIOKafkaConsumer(
        *TOPICS,
        bootstrap_servers=brokers,
        group_id=CONSUMER,
        enable_auto_commit=False,
        auto_offset_reset='earliest',
    )
    producer = AIOKafkaProducer(bootstrap_servers=brokers)
    await consumer.start()
    await producer.start()
    try:
        async for message in consumer:
            try:
                event_id, payload = parse_outbox_record(dict(message.headers or []), message.value)
                await handlers.handle(message.topic, event_id, payload)
            except (ValueError, KeyError, TypeError) as error:
                log.error(
                    'poison event sent to DLQ',
                    extra={'topic': message.topic, 'error': str(error)[:200]},
                )
                await producer.send_and_wait(dlq, message.value, key=message.key)
            await consumer.commit()
    finally:
        await consumer.stop()
        await producer.stop()

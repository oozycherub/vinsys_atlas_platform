"""Kafka consumer for `tenant.tenant.purged.v1` (Debezium outbox records, at-least-once).

Processing and de-duplication share one transaction, so a redelivered event has no second
effect. A malformed record goes to the DLQ instead of blocking the partition.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from atlas_platform.db import PgDatabase
from atlas_platform.events import PgProcessedEvents, parse_outbox_record

from llm_gateway.infrastructure.repositories import PgPurgeRepository

log = logging.getLogger('llm_gateway')

CONSUMER = 'llm-gateway'
PURGED_TOPIC = 'tenant.tenant.purged.v1'


async def handle_purged(db: PgDatabase, event_id: str, payload: dict[str, Any]) -> bool:
    """True when the purge ran, False for a duplicate."""
    tenant_id = str(payload['tenant_id'])
    uuid.UUID(tenant_id)
    seen = PgProcessedEvents()
    async with db.tenant_tx(tenant_id) as tx:
        if not await seen.first_time(tx, CONSUMER, event_id):
            return False
        counts = await PgPurgeRepository().purge_tenant(tx)
    log.info(
        'tenant purged',
        extra={'tenant_id': tenant_id, **{f'deleted_{k}': v for k, v in counts.items()}},
    )
    return True


async def run_consumer(
    db: PgDatabase, brokers: str, dlq_topic: str = 'llm-gateway.dlq'
) -> None:  # pragma: no cover
    from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

    consumer = AIOKafkaConsumer(
        PURGED_TOPIC,
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
                await handle_purged(db, event_id, payload)
            except (ValueError, KeyError, TypeError) as error:
                log.error(
                    'poison event sent to DLQ',
                    extra={'topic': message.topic, 'error': str(error)[:200]},
                )
                await producer.send_and_wait(dlq_topic, message.value, key=message.key)
            await consumer.commit()
    finally:
        await consumer.stop()
        await producer.stop()

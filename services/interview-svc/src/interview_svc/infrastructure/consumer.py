"""Kafka consumer (Debezium outbox records, at-least-once, commit after handling)."""

from __future__ import annotations

import logging

from atlas_platform.events import parse_outbox_record

from interview_svc.application.events import CONSUMER, TOPICS, EventHandlers

log = logging.getLogger('interview_svc')


async def run_consumer(
    handlers: EventHandlers, brokers: str, dlq: str = 'interview-svc.dlq'
) -> None:  # pragma: no cover - needs Kafka
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

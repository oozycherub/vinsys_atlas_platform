"""Object storage (S3/MinIO), the proctoring-svc result client, the audio decoder and the Kafka
consumer loop."""

from __future__ import annotations

import asyncio
import io
import logging
from typing import Any, Protocol

import httpx
import numpy as np
import numpy.typing as npt
from atlas_platform.events import parse_outbox_record

from cv_inference.application.analyser import TOPIC, Analyser

log = logging.getLogger('cv_inference')


class S3Storage:
    """Reads uploaded frames (boto3 in a thread: the client is synchronous)."""

    def __init__(self, client: Any, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    async def get(self, key: str, max_bytes: int) -> bytes | None:
        def fetch() -> bytes | None:
            try:
                obj = self.client.get_object(Bucket=self.bucket, Key=key)
            except self.client.exceptions.NoSuchKey:
                return None
            if int(obj.get('ContentLength', 0)) > max_bytes:
                return None
            data: bytes = obj['Body'].read(max_bytes + 1)
            return None if len(data) > max_bytes else data

        return await asyncio.to_thread(fetch)


class TokenSource(Protocol):
    async def token(self) -> str: ...


class TransientError(Exception):
    """proctoring-svc is unavailable: the event is retried."""


class ProctoringResults:
    """POST /v1/proctoring/frames/{id}:inference (scope proctoring:inference)."""

    def __init__(self, base_url: str, tokens: TokenSource, client: httpx.AsyncClient) -> None:
        self.base_url = base_url.rstrip('/')
        self.tokens = tokens
        self.client = client

    async def post(self, tenant_id: str, frame_id: str, body: dict[str, Any]) -> None:
        url = f'{self.base_url}/v1/proctoring/frames/{frame_id}:inference'
        try:
            res = await self.client.post(
                url,
                params={'tenant_id': tenant_id},
                json=body,
                headers={'Authorization': f'Bearer {await self.tokens.token()}'},
                timeout=10,
            )
        except httpx.HTTPError as error:
            raise TransientError(str(error)) from error
        if res.status_code == 404:
            # The session was erased (or the tenant purged) while the frame waited: drop it.
            log.info('result dropped: frame no longer exists', extra={'tenant_id': tenant_id})
            return
        if res.status_code >= 500 or res.status_code in (401, 409, 429):
            raise TransientError(f'proctoring-svc: HTTP {res.status_code}')
        if res.status_code >= 400:
            raise ValueError(f'proctoring-svc rejected the result: HTTP {res.status_code}')


class PyAvDecoder:
    """MediaRecorder audio (WebM/Ogg Opus) → 16 kHz mono float32 PCM."""

    def __init__(self, rate: int = 16_000) -> None:
        self.rate = rate

    def decode(self, data: bytes) -> tuple[npt.NDArray[np.float32], int] | None:
        import av

        try:
            with av.open(io.BytesIO(data), mode='r') as container:
                resampler = av.AudioResampler(format='flt', layout='mono', rate=self.rate)
                chunks = []
                for frame in container.decode(audio=0):
                    for out in resampler.resample(frame):
                        chunks.append(out.to_ndarray().reshape(-1))
                for out in resampler.resample(None):
                    chunks.append(out.to_ndarray().reshape(-1))
        except (av.error.FFmpegError, ValueError, IndexError):
            return None
        if not chunks:
            return None
        return np.concatenate(chunks).astype(np.float32), self.rate


async def run_consumer(
    analyser: Analyser, brokers: str, dlq: str = 'cv-inference.dlq'
) -> None:  # pragma: no cover - needs Kafka
    from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

    consumer = AIOKafkaConsumer(
        TOPIC,
        bootstrap_servers=brokers,
        group_id='cv-inference',
        enable_auto_commit=False,
        auto_offset_reset='earliest',
        max_poll_records=32,
    )
    producer = AIOKafkaProducer(bootstrap_servers=brokers)
    await consumer.start()
    await producer.start()
    try:
        async for message in consumer:
            for attempt in range(1, 100):
                try:
                    _, payload = parse_outbox_record(dict(message.headers or []), message.value)
                    await analyser.handle(payload)
                    break
                except TransientError as error:
                    log.warning(
                        'result post failed; retrying',
                        extra={'attempt': attempt, 'error': str(error)},
                    )
                    await asyncio.sleep(min(30, attempt))
                except (ValueError, KeyError, TypeError) as error:
                    log.error('poison event sent to DLQ', extra={'error': str(error)[:200]})
                    await producer.send_and_wait(dlq, message.value, key=message.key)
                    break
            await consumer.commit()
    finally:
        await consumer.stop()
        await producer.stop()

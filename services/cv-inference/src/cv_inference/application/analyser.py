"""Handles `proctoring.frame.uploaded.v1`: fetch the object, run the cascade, post the result to
proctoring-svc. Stateless: proctoring-svc ignores a result for a frame it already has, so a
redelivered event is harmless (ADR-0007)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

import numpy as np
import numpy.typing as npt
from atlas_platform.ids import is_uuid

from cv_inference.domain.cascade import Cascade
from cv_inference.domain.vision import decode_jpeg

log = logging.getLogger('cv_inference')

TOPIC = 'proctoring.frame.uploaded.v1'
KINDS = ('frame', 'selfie', 'id_document', 'audio')
MAX_OBJECT_BYTES = 4 * 1024 * 1024


class ObjectStorage(Protocol):
    async def get(self, key: str, max_bytes: int) -> bytes | None: ...


class ResultSink(Protocol):
    async def post(self, tenant_id: str, frame_id: str, body: dict[str, Any]) -> None: ...


class AudioDecoder(Protocol):
    def decode(self, data: bytes) -> tuple[npt.NDArray[np.float32], int] | None: ...


@dataclass(frozen=True)
class FrameJob:
    tenant_id: str
    session_id: str
    frame_id: str
    kind: str
    object_key: str
    captured_at: datetime
    triggered: bool

    @staticmethod
    def parse(payload: dict[str, Any]) -> FrameJob:
        """Raises ValueError for a malformed payload (the consumer dead-letters it)."""
        for key in ('tenant_id', 'session_id', 'frame_id'):
            if not is_uuid(payload.get(key)):
                raise ValueError(f'{key} missing or invalid')
        kind, object_key = payload.get('kind'), payload.get('object_key')
        if kind not in KINDS:
            raise ValueError('kind missing or invalid')
        if not isinstance(object_key, str) or not object_key.startswith(
            f't/{payload["tenant_id"]}/proctor/'
        ):
            raise ValueError('object_key must be inside the tenant proctor prefix')
        try:
            captured = datetime.fromisoformat(str(payload.get('captured_at')))
        except ValueError as error:
            raise ValueError('captured_at missing or invalid') from error
        return FrameJob(
            tenant_id=str(payload['tenant_id']),
            session_id=str(payload['session_id']),
            frame_id=str(payload['frame_id']),
            kind=str(kind),
            object_key=object_key,
            captured_at=captured,
            triggered=bool(payload.get('triggered', False)),
        )


class Analyser:
    def __init__(
        self, storage: ObjectStorage, cascade: Cascade, results: ResultSink, audio: AudioDecoder
    ) -> None:
        self.storage = storage
        self.cascade = cascade
        self.results = results
        self.audio = audio

    async def handle(self, payload: dict[str, Any]) -> str:
        """Returns the outcome (analysed, object_missing, undecodable)."""
        job = FrameJob.parse(payload)
        data = await self.storage.get(job.object_key, MAX_OBJECT_BYTES)
        if data is None:
            # The client asked for an upload URL but never uploaded (or the object expired):
            # reported so the timeline shows a frame gap.
            await self.results.post(job.tenant_id, job.frame_id, {'error': 'object_missing'})
            return 'object_missing'
        if job.kind == 'audio':
            decoded = self.audio.decode(data)
            if decoded is None:
                await self.results.post(job.tenant_id, job.frame_id, {'error': 'undecodable'})
                return 'undecodable'
            pcm, rate = decoded
            await self.results.post(
                job.tenant_id, job.frame_id, await self.cascade.audio(pcm, rate)
            )
            return 'analysed'
        img = decode_jpeg(data)
        if img is None:
            await self.results.post(job.tenant_id, job.frame_id, {'error': 'undecodable'})
            return 'undecodable'
        analysis = await self.cascade.frame(
            img, triggered=job.triggered, reference=job.kind in ('selfie', 'id_document')
        )
        await self.results.post(
            job.tenant_id, job.frame_id, analysis.to_result(self.cascade.models.versions)
        )
        log.info(
            'frame analysed',
            extra={'tenant_id': job.tenant_id, 'kind': job.kind, 'faces': analysis.faces},
        )
        return 'analysed'

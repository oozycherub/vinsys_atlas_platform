"""Temporal: ParseResumeWorkflow, its activities, the runner that starts it, and the payload
codec that encrypts everything Temporal stores (stage payloads carry the redaction map)."""

from __future__ import annotations

import base64
import dataclasses
import os
from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.api.common.v1 import Payload
from temporalio.common import RetryPolicy, WorkflowIDConflictPolicy
from temporalio.converter import DataConverter, PayloadCodec
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from parsing_svc.application.pipeline import (
        Embedded,
        Enriched,
        Extraction,
        Failure,
        ParsePipeline,
        Prepared,
    )
    from parsing_svc.application.ports import UpstreamError
    from parsing_svc.application.store import Job, JobRepository
    from parsing_svc.domain.errors import PipelineError

TASK_QUEUE = 'parsing'
FINAL_CODES = [
    'UNREADABLE_DOCUMENT',
    'ENCRYPTED_DOCUMENT',
    'MALICIOUS_FILE',
    'UNSUPPORTED_DOCUMENT',
    'LLM_UNAVAILABLE',
]


@dataclasses.dataclass(frozen=True)
class JobRef:
    tenant_id: str
    job_id: str


class ParseActivities:
    """Thin adapters: load the job, run the pipeline stage, translate failures for Temporal
    (a PipelineError is final; UpstreamError is retried by the activity retry policy)."""

    def __init__(self, pipeline: ParsePipeline, jobs: JobRepository) -> None:
        self.pipeline = pipeline
        self.jobs = jobs

    async def _job(self, ref: JobRef) -> Job:
        async with self.pipeline.d.db.tenant_tx(ref.tenant_id) as tx:
            job = await self.jobs.get(tx, ref.job_id)
        if job is None:
            raise ApplicationError('job not found', type='JOB_NOT_FOUND', non_retryable=True)
        return job

    async def _guard(self, call: Any) -> Any:
        try:
            return await call
        except PipelineError as error:
            raise ApplicationError(
                error.detail,
                dataclasses.asdict(Failure.of(error)),
                type=error.code,
                non_retryable=True,
            ) from error
        except UpstreamError as error:
            raise ApplicationError(str(error), type='UPSTREAM_UNAVAILABLE') from error

    @activity.defn(name='parse.intake')
    async def intake(self, ref: JobRef) -> Prepared:
        job = await self._job(ref)
        result: Prepared = await self._guard(self.pipeline.intake(job))
        return result

    @activity.defn(name='parse.extract')
    async def extract(self, ref: JobRef, prepared: Prepared) -> Extraction:
        job = await self._job(ref)
        result: Extraction = await self._guard(self.pipeline.extract(job, prepared))
        return result

    @activity.defn(name='parse.enrich')
    async def enrich(self, ref: JobRef, prepared: Prepared, extraction: Extraction) -> Enriched:
        job = await self._job(ref)
        result: Enriched = await self._guard(self.pipeline.enrich(job, prepared, extraction))
        return result

    @activity.defn(name='parse.embed')
    async def embed(self, ref: JobRef, enriched: Enriched) -> Embedded:
        job = await self._job(ref)
        result: Embedded = await self._guard(self.pipeline.embed(job, enriched))
        return result

    @activity.defn(name='parse.persist')
    async def persist(
        self, ref: JobRef, prepared: Prepared, enriched: Enriched, embedded: Embedded
    ) -> bool:
        job = await self._job(ref)
        result: bool = await self._guard(self.pipeline.persist(job, prepared, enriched, embedded))
        return result

    @activity.defn(name='parse.fail')
    async def fail(self, ref: JobRef, failure: Failure, attempts: int) -> bool:
        job = await self._job(ref)
        result: bool = await self._guard(self.pipeline.fail(job, failure, attempts))
        return result

    def all(self) -> list[Any]:
        return [self.intake, self.extract, self.enrich, self.embed, self.persist, self.fail]


@workflow.defn(name='ParseResumeWorkflow')
class ParseResumeWorkflow:
    """PRD §2.1(b): stages as activities. Retry policy (§2.1(d)): 3 attempts with backoff
    2 s → 30 s; after that the job is failed_retryable and announced on the DLQ topic."""

    @workflow.run
    async def run(self, ref: JobRef) -> str:
        retry = RetryPolicy(
            initial_interval=timedelta(seconds=2),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
            maximum_attempts=3,
            non_retryable_error_types=FINAL_CODES,
        )
        short: dict[str, Any] = {
            'start_to_close_timeout': timedelta(minutes=2),
            'retry_policy': retry,
        }
        llm: dict[str, Any] = {
            'start_to_close_timeout': timedelta(minutes=3),
            'retry_policy': retry,
        }
        stage = 'intake'
        try:
            prepared = await workflow.execute_activity(
                'parse.intake', ref, result_type=Prepared, **short
            )
            stage = 'llm_extract'
            extraction = await workflow.execute_activity(
                'parse.extract', args=[ref, prepared], result_type=Extraction, **llm
            )
            stage = 'enrich'
            enriched = await workflow.execute_activity(
                'parse.enrich', args=[ref, prepared, extraction], result_type=Enriched, **short
            )
            stage = 'embed'
            embedded = await workflow.execute_activity(
                'parse.embed', args=[ref, enriched], result_type=Embedded, **short
            )
            stage = 'persist'
            await workflow.execute_activity(
                'parse.persist', args=[ref, prepared, enriched, embedded], result_type=bool, **short
            )
            return 'succeeded'
        except ActivityError as error:
            failure = _failure(error, stage)
            await workflow.execute_activity(
                'parse.fail',
                args=[ref, failure, retry.maximum_attempts],
                result_type=bool,
                start_to_close_timeout=timedelta(minutes=1),
                retry_policy=RetryPolicy(maximum_attempts=10),
            )
            return 'failed_retryable' if failure.retryable else 'failed'


def _failure(error: ActivityError, stage: str) -> Failure:
    cause = error.cause
    if isinstance(cause, ApplicationError) and cause.non_retryable and cause.details:
        return Failure(**cause.details[0])
    code = 'LLM_UNAVAILABLE' if stage in ('llm_extract', 'embed') else 'DEPENDENCY_UNAVAILABLE'
    return Failure(code, str(cause or error), retryable=True)


class TemporalRunner:
    def __init__(self, client: Any, task_queue: str = TASK_QUEUE) -> None:
        self.client = client
        self.task_queue = task_queue

    async def start(self, job: Job) -> None:
        # One workflow per job; starting it twice (a re-delivered dispatch) joins the running one.
        await self.client.start_workflow(
            ParseResumeWorkflow.run,
            JobRef(job.tenant_id, job.job_id),
            id=f'parse-{job.job_id}',
            task_queue=self.task_queue,
            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
        )


class AesGcmCodec(PayloadCodec):
    """Encrypts every payload Temporal persists (inputs, results, failures)."""

    ENCODING = b'binary/encrypted'

    def __init__(self, key: bytes, key_id: str = 'k1') -> None:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        if len(key) != 32:
            raise ValueError('The Temporal payload key must be 32 bytes.')
        self._aes = AESGCM(key)
        self._key_id = key_id.encode()

    async def encode(self, payloads: Sequence[Payload]) -> list[Payload]:
        out = []
        for p in payloads:
            nonce = os.urandom(12)
            sealed = self._aes.encrypt(nonce, p.SerializeToString(), self._key_id)
            out.append(
                Payload(
                    metadata={'encoding': self.ENCODING, 'key-id': self._key_id},
                    data=nonce + sealed,
                )
            )
        return out

    async def decode(self, payloads: Sequence[Payload]) -> list[Payload]:
        out = []
        for p in payloads:
            if p.metadata.get('encoding') != self.ENCODING:
                out.append(p)
                continue
            plain = self._aes.decrypt(
                p.data[:12], p.data[12:], p.metadata.get('key-id', self._key_id)
            )
            decoded = Payload()
            decoded.ParseFromString(plain)
            out.append(decoded)
        return out


def data_converter(key_b64: str | None) -> DataConverter:
    if not key_b64:
        return DataConverter.default
    return dataclasses.replace(
        DataConverter.default, payload_codec=AesGcmCodec(base64.b64decode(key_b64))
    )

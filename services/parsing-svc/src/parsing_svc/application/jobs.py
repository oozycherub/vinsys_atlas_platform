"""Parse jobs: creation (event, API, bulk), fair-share dispatch, inline orchestration."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol, TypeVar

from atlas_platform.db import Database
from atlas_platform.errors import AppError
from atlas_platform.ids import uuid7

from parsing_svc.application.pipeline import Failure, ParsePipeline
from parsing_svc.application.ports import ProfileApi, UpstreamError
from parsing_svc.application.store import Job, JobRepository
from parsing_svc.domain.errors import PipelineError

log = logging.getLogger('parsing_svc')
T = TypeVar('T')


def storage_key(tenant_id: str, document_id: str) -> str:
    return f't/{tenant_id}/resumes/{document_id}'


@dataclass(frozen=True)
class RetryPolicy:
    """PRD §2.1(d): 3 attempts, exponential backoff 2 s → 30 s."""

    attempts: int = 3
    initial: float = 2.0
    maximum: float = 30.0

    def delay(self, attempt: int) -> float:
        return float(min(self.maximum, self.initial * 2 ** (attempt - 1)))


DEFAULT_POLICY = RetryPolicy()


class Runner(Protocol):
    async def start(self, job: Job) -> None: ...


class JobService:
    def __init__(
        self,
        db: Database,
        jobs: JobRepository,
        profile: ProfileApi,
        parser_version: str,
    ) -> None:
        self.db = db
        self.jobs = jobs
        self.profile = profile
        self.parser_version = parser_version

    def job_from_upload(self, payload: dict[str, object], origin: str = 'event') -> Job:
        """`profile.resume.uploaded.v1` → the job to queue."""
        return Job(
            tenant_id=str(payload['tenant_id']),
            job_id=uuid7(),
            document_id=str(payload['document_id']),
            candidate_id=str(payload['candidate_id']),
            storage_key=str(payload['storage_key']),
            mime_type=str(payload['mime_type']),
            byte_size=int(str(payload['byte_size'])),
            origin=origin,
            parser_version=self.parser_version,
        )

    async def from_upload(self, payload: dict[str, object], origin: str = 'event') -> Job:
        job = self.job_from_upload(payload, origin)
        async with self.db.tenant_tx(job.tenant_id) as tx:
            return await self.jobs.insert(tx, job)

    async def request(self, tenant_id: str, document_id: str, idempotency_key: str) -> Job:
        """`POST /v1/resumes/{id}:parse`: a re-parse on demand."""
        doc = await self.profile.get_document(tenant_id, document_id)
        if doc is None:
            raise AppError('not_found', 'DOCUMENT_NOT_FOUND', 'No such document in this tenant.')
        if doc.parse_status in ('pending_upload', 'quarantined'):
            raise AppError('rule', 'DOCUMENT_NOT_PARSEABLE', f'The document is {doc.parse_status}.')
        job = Job(
            tenant_id=tenant_id,
            job_id=uuid7(),
            document_id=doc.document_id,
            candidate_id=doc.candidate_id,
            storage_key=storage_key(tenant_id, doc.document_id),
            mime_type=doc.mime_type,
            byte_size=doc.byte_size,
            origin='api',
            parser_version=self.parser_version,
            idempotency_key=idempotency_key,
        )
        async with self.db.tenant_tx(tenant_id) as tx:
            stored = await self.jobs.insert(tx, job)
        if stored.idempotency_key == idempotency_key and stored.document_id != document_id:
            raise AppError(
                'conflict',
                'IDEMPOTENCY_KEY_REUSED',
                'This Idempotency-Key was used for another document.',
            )
        return stored

    async def get(self, tenant_id: str, job_id: str) -> Job:
        async with self.db.tenant_tx(tenant_id) as tx:
            job = await self.jobs.get(tx, job_id)
        if job is None:
            raise AppError('not_found', 'JOB_NOT_FOUND', 'No such parse job in this tenant.')
        return job


class Dispatcher:
    """Weighted fair scheduling (PRD §1.2.3): queued jobs are started round-robin across tenants,
    and no tenant runs more than `per_tenant_cap` at once, so one tenant's 10k bulk upload
    cannot starve the others."""

    def __init__(
        self, db: Database, jobs: JobRepository, runner: Runner, per_tenant_cap: int
    ) -> None:
        self.db = db
        self.jobs = jobs
        self.runner = runner
        self.cap = per_tenant_cap

    async def tick(self, limit: int = 50) -> list[Job]:
        async with self.db.system_tx() as tx:
            claimed = await self.jobs.claim(tx, limit, self.cap)
        for job in claimed:
            await self.runner.start(job)
        return claimed

    async def run_forever(self, interval: float = 0.5) -> None:  # pragma: no cover - process loop
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception('dispatch failed')
            await asyncio.sleep(interval)


async def run_job(
    pipeline: ParsePipeline,
    job: Job,
    policy: RetryPolicy = DEFAULT_POLICY,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> str:
    """Inline orchestration of ParseResumeWorkflow (same stages, same retry policy, same DLQ),
    for development and tests. Production runs the Temporal workflow in temporal.py."""
    stage = 'intake'
    attempts = 0

    async def retrying(name: str, call: Callable[[], Awaitable[T]]) -> T:
        nonlocal stage, attempts
        stage = name
        for attempt in range(1, policy.attempts + 1):
            attempts = attempt
            try:
                return await call()
            except UpstreamError:
                if attempt == policy.attempts:
                    raise
                await sleep(policy.delay(attempt))
        raise AssertionError('unreachable')

    try:
        prepared = await retrying('intake', lambda: pipeline.intake(job))
        extraction = await retrying('llm_extract', lambda: pipeline.extract(job, prepared))
        enriched = await retrying('enrich', lambda: pipeline.enrich(job, prepared, extraction))
        embedded = await retrying('embed', lambda: pipeline.embed(job, enriched))
        await retrying('persist', lambda: pipeline.persist(job, prepared, enriched, embedded))
        return 'succeeded'
    except PipelineError as error:
        await pipeline.fail(job, Failure.of(error), attempts)
        return 'failed'
    except UpstreamError as error:
        code = 'LLM_UNAVAILABLE' if stage in ('llm_extract', 'embed') else 'DEPENDENCY_UNAVAILABLE'
        await pipeline.fail(job, Failure(code, str(error), retryable=True), attempts)
        return 'failed_retryable'


class InlineRunner:
    """Runs jobs as asyncio tasks in this process (single-process development and tests)."""

    def __init__(self, pipeline: ParsePipeline, policy: RetryPolicy = DEFAULT_POLICY) -> None:
        self.pipeline = pipeline
        self.policy = policy
        self.tasks: set[asyncio.Task[str]] = set()

    async def start(self, job: Job) -> None:
        task = asyncio.create_task(run_job(self.pipeline, job, self.policy))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def drain(self) -> None:
        while self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)

"""ParseResumeWorkflow on Temporal's time-skipping test server (real workflow sandbox), with the
activities running the real pipeline against Postgres."""

from __future__ import annotations

import base64
import dataclasses
import os
import uuid
from collections.abc import AsyncIterator

import pytest
from temporalio.api.common.v1 import Payload
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from parsing_svc.application.store import Job
from parsing_svc.infrastructure.temporal import (
    AesGcmCodec,
    ParseActivities,
    ParseResumeWorkflow,
    TemporalRunner,
    data_converter,
)
from tests.conftest import World, golden_file

KEY = base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(scope='module')
async def env() -> AsyncIterator[WorkflowEnvironment]:
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=data_converter(KEY)
    ) as e:
        yield e


async def run(env: WorkflowEnvironment, world: World, job: Job) -> str:
    queue = f'parsing-{uuid.uuid4()}'
    activities = ParseActivities(world.pipeline, world.pipeline.d.jobs)
    async with Worker(
        env.client, task_queue=queue, workflows=[ParseResumeWorkflow], activities=activities.all()
    ):
        await TemporalRunner(env.client, queue).start(job)
        handle = env.client.get_workflow_handle(f'parse-{job.job_id}')
        result: str = await handle.result()
        return result


async def queued(world: World, ref: str) -> Job:
    data, mime = golden_file(ref)
    world.llm.ref = ref
    return await world.upload(data, mime)


async def test_workflow_parses_and_retries_transient_failures(
    env: WorkflowEnvironment, world: World
) -> None:
    job = await queued(world, 'G11')
    world.llm.failures = 2  # Temporal's retry policy absorbs them (backoff is time-skipped)
    assert await run(env, world, job) == 'succeeded'
    stored = await world.jobs.get(job.tenant_id, job.job_id)
    assert (stored.status, stored.progress) == ('succeeded', 100)
    assert len(world.llm.texts) == 3
    count = await world.rows(
        'SELECT count(*) AS n FROM resume_embeddings WHERE candidate_id = %s', (job.candidate_id,)
    )

    # The same workflow id runs again for the job (a replay after the first run closed): the
    # stages re-run, persist sees the job already succeeded, and nothing is duplicated.
    assert await run(env, world, job) == 'succeeded'
    assert (
        await world.rows(
            'SELECT count(*) AS n FROM resume_embeddings WHERE candidate_id = %s',
            (job.candidate_id,),
        )
        == count
    )
    parsed = [
        e
        for e in await world.events('profile.resume.parsed.v1')
        if e['document_id'] == job.document_id
    ]
    assert len(parsed) == 1


async def test_workflow_sends_exhausted_retries_to_the_dlq(
    env: WorkflowEnvironment, world: World
) -> None:
    job = await queued(world, 'G12')
    world.llm.failures = 99
    assert await run(env, world, job) == 'failed_retryable'
    stored = await world.jobs.get(job.tenant_id, job.job_id)
    assert (stored.status, stored.error_code) == ('failed_retryable', 'LLM_UNAVAILABLE')
    dlq = (await world.events('profile.resume.parse_failed.v1'))[-1]
    assert (dlq['retryable'], dlq['attempts']) == (True, 3)


async def test_workflow_final_failure_is_not_retried(
    env: WorkflowEnvironment, world: World
) -> None:
    job = await world.upload(b'%PDF-1.4\nthis is not really a pdf', 'application/pdf')
    assert await run(env, world, job) == 'failed'
    stored = await world.jobs.get(job.tenant_id, job.job_id)
    assert stored.error_code == 'UNREADABLE_DOCUMENT'
    assert world.llm.texts == []


async def test_payloads_are_encrypted_at_rest(env: WorkflowEnvironment) -> None:
    codec = AesGcmCodec(base64.b64decode(KEY))
    plain = Payload(
        metadata={'encoding': b'json/plain'}, data=b'{"pii_map": {"<PERSON_1>": "Real Name"}}'
    )
    sealed = await codec.encode([plain])
    assert b'Real Name' not in sealed[0].data
    assert (await codec.decode(sealed))[0] == plain
    assert (await codec.decode([plain]))[0] == plain  # unencrypted payloads pass through
    with pytest.raises(ValueError, match='32 bytes'):
        AesGcmCodec(b'short')
    assert data_converter(None) is not None
    assert dataclasses.replace(env.client.data_converter).payload_codec is not None
    assert isinstance(env.client, Client)

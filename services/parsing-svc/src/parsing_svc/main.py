"""Composition root: the API process (HTTP, consumer, dispatcher) and the Temporal worker."""

from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import uvicorn
from atlas_platform.auth import ClientCredentialsTokenProvider, JwtVerifier
from atlas_platform.db import PgDatabase
from atlas_platform.events import PgOutbox
from atlas_platform.logs import configure_logging
from fastapi import FastAPI

from parsing_svc.application.admin import DataProtection, EmbeddingIndex
from parsing_svc.application.bulk import BulkImporter
from parsing_svc.application.jobs import Dispatcher, InlineRunner, JobService, Runner
from parsing_svc.application.pipeline import Deps, ParsePipeline
from parsing_svc.application.ports import MalwareScanner, ObjectStorage, OcrEngine
from parsing_svc.config import Config
from parsing_svc.http.app import Container, create_app
from parsing_svc.infrastructure.clients import GatewayClient, ProfileClient, TaxonomyClient
from parsing_svc.infrastructure.consumer import EventHandlers, run_consumer
from parsing_svc.infrastructure.extract import DocumentExtractor
from parsing_svc.infrastructure.repositories import (
    PgBatchRepository,
    PgEmbeddingRepository,
    PgJobRepository,
    PgModelSlots,
)
from parsing_svc.infrastructure.scanner import ClamdScanner, SignatureScanner
from parsing_svc.infrastructure.storage import MemoryStorage, S3Storage

log = logging.getLogger('parsing_svc')


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


@dataclass
class Built:
    config: Config
    db: PgDatabase
    pipeline: ParsePipeline
    jobs: JobService
    bulk: BulkImporter
    index: EmbeddingIndex
    handlers: EventHandlers
    gateway: GatewayClient


def build(config: Config) -> Built:
    from atlas_platform.presidio import PresidioDetector

    clock = SystemClock()
    db = PgDatabase(config.database_url, app_role=config.db_app_role)
    tokens = ClientCredentialsTokenProvider(
        token_url=config.token_url,
        client_id=config.client_id,
        client_secret=config.client_secret,
        scopes=['llm:invoke', 'embeddings:create', 'prompts:write', 'pii:read'],
    )
    storage: ObjectStorage = (
        S3Storage(config.s3_bucket or '', endpoint_url=config.s3_endpoint)
        if config.storage == 's3'
        else MemoryStorage()
    )
    scanner: MalwareScanner = (
        ClamdScanner(config.clamd_host, config.clamd_port)
        if config.clamd_host
        else SignatureScanner()
    )
    ocr: OcrEngine | None = None
    if config.ocr:  # pragma: no cover - OCR worker image only
        from parsing_svc.infrastructure.ocr import PaddleOcrEngine

        ocr = PaddleOcrEngine()
    gateway = GatewayClient(config.gateway_url, tokens, locale=config.summary_locale)
    profile = ProfileClient(config.profile_url, tokens)
    jobs_repo, embeddings, slots, batches = (
        PgJobRepository(),
        PgEmbeddingRepository(),
        PgModelSlots(),
        PgBatchRepository(),
    )
    outbox = PgOutbox()
    pipeline = ParsePipeline(
        Deps(
            db=db,
            jobs=jobs_repo,
            embeddings=embeddings,
            slots=slots,
            batches=batches,
            outbox=outbox,
            storage=storage,
            scanner=scanner,
            extractor=DocumentExtractor(),
            ocr=ocr,
            detector=PresidioDetector(config.spacy_model),
            llm=gateway,
            taxonomy=TaxonomyClient(config.taxonomy_url, tokens),
            embedder=gateway,
            profile=profile,
            clock=clock,
        )
    )
    jobs = JobService(db, jobs_repo, profile, config.parser_version)
    protection = DataProtection(db, jobs_repo, embeddings, batches, outbox, clock)
    return Built(
        config=config,
        db=db,
        pipeline=pipeline,
        jobs=jobs,
        bulk=BulkImporter(db, batches, storage, profile),
        index=EmbeddingIndex(db, embeddings, slots, gateway),
        handlers=EventHandlers(db, jobs, protection),
        gateway=gateway,
    )


async def temporal_client(config: Config) -> Any:  # pragma: no cover - needs a Temporal server
    from temporalio.client import Client

    from parsing_svc.infrastructure.temporal import data_converter

    return await Client.connect(
        config.temporal_address,
        namespace=config.temporal_namespace,
        data_converter=data_converter(config.temporal_payload_key),
    )


def app_from_env() -> FastAPI:  # pragma: no cover - process wiring
    config = Config.from_env()
    built = build(config)
    background: set[asyncio.Task[Any]] = set()

    def spawn(coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        background.add(task)
        task.add_done_callback(background.discard)

    async def start_bulk(tenant_id: str, batch_id: str) -> None:
        spawn(built.bulk.run(tenant_id, batch_id))

    container = Container(
        jobs=built.jobs,
        bulk=built.bulk,
        index=built.index,
        verifier=JwtVerifier(
            issuer=config.issuer,
            audience=config.audience,
            jwks_url=config.jwks_url,
            shared_secret=config.jwt_secret,
        ),
        start_bulk=start_bulk,
        readiness=[built.db.ping],
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await built.db.open()
        try:
            await built.gateway.register_prompt()
        except Exception:
            log.exception('prompt registration failed; parses will fail until it succeeds')
        runner: Runner
        if config.runner == 'temporal':
            from parsing_svc.infrastructure.temporal import TemporalRunner

            runner = TemporalRunner(await temporal_client(config))
        else:
            runner = InlineRunner(built.pipeline)
        spawn(
            Dispatcher(
                built.db, built.pipeline.d.jobs, runner, config.per_tenant_concurrency
            ).run_forever()
        )
        if config.kafka_brokers:
            spawn(run_consumer(built.handlers, config.kafka_brokers))
        try:
            yield
        finally:
            for task in list(background):
                task.cancel()
            await built.db.close()

    app = create_app(container)
    app.router.lifespan_context = lifespan
    return app


async def run_worker() -> None:  # pragma: no cover - needs a Temporal server
    from temporalio.worker import Worker

    from parsing_svc.infrastructure.temporal import TASK_QUEUE, ParseActivities, ParseResumeWorkflow

    config = Config.from_env()
    built = build(config)
    await built.db.open()
    activities = ParseActivities(built.pipeline, built.pipeline.d.jobs)
    worker = Worker(
        await temporal_client(config),
        task_queue=TASK_QUEUE,
        workflows=[ParseResumeWorkflow],
        activities=activities.all(),
        max_concurrent_activities=20,
    )
    await worker.run()


def main() -> None:  # pragma: no cover - process entry point
    configure_logging('parsing-svc')
    if sys.argv[1:] == ['worker']:
        asyncio.run(run_worker())
        return
    config = Config.from_env()
    uvicorn.run(
        'parsing_svc.main:app_from_env',
        factory=True,
        host='0.0.0.0',  # noqa: S104 - the container's only interface
        port=config.port,
        log_config=None,
        # The app's own middleware logs requests by path only; uvicorn's would add query strings.
        access_log=False,
    )


if __name__ == '__main__':  # pragma: no cover
    main()


__all__ = ['Callable', 'build', 'main']

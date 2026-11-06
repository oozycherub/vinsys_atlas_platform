"""Composition root: wires adapters from configuration and runs the HTTP server and consumer."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import uvicorn
from atlas_platform.auth import JwtVerifier
from atlas_platform.db import PgDatabase
from atlas_platform.events import PgOutbox
from atlas_platform.logs import configure_logging
from fastapi import FastAPI

from llm_gateway.application.admin import BudgetAdmin, PromptRegistry
from llm_gateway.application.gateway import Gateway, GatewaySettings
from llm_gateway.application.ports import EmbeddingProvider, KeyValueStore, LlmProvider, PiiDetector
from llm_gateway.config import Config
from llm_gateway.domain.policy import BudgetLimits
from llm_gateway.http.app import Container, create_app
from llm_gateway.infrastructure.adapters import (
    MemoryKeyValueStore,
    PresidioDetector,
    RedisKeyValueStore,
    StubEmbeddings,
    TritonEmbeddings,
)
from llm_gateway.infrastructure.consumer import run_consumer
from llm_gateway.infrastructure.providers import AnthropicProvider, StubProvider
from llm_gateway.infrastructure.repositories import (
    PgBudgetRepository,
    PgCallLog,
    PgPromptRepository,
)


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


def build(config: Config) -> tuple[Container, PgDatabase, list[Callable[[], Awaitable[None]]]]:
    clock = SystemClock()
    db = PgDatabase(config.database_url, app_role=config.db_app_role)
    providers: dict[str, LlmProvider] = {}
    if config.provider == 'stub':
        providers['stub'] = StubProvider()
    else:
        assert config.anthropic_api_key
        providers['anthropic'] = AnthropicProvider(config.anthropic_api_key)
    embeddings: EmbeddingProvider = (
        TritonEmbeddings(config.triton_url, model=config.embedding_model)
        if config.triton_url
        else StubEmbeddings()
    )
    detector: PiiDetector = PresidioDetector(config.spacy_model)
    store: KeyValueStore
    readiness: list[Callable[[], Awaitable[None]]] = [db.ping]
    if config.redis_url:
        redis_store = RedisKeyValueStore(config.redis_url)
        readiness.append(redis_store.ping)
        store = redis_store
    else:
        store = MemoryKeyValueStore()
    defaults = BudgetLimits(config.default_monthly_tokens, config.default_monthly_gpu_seconds)
    gateway = Gateway(
        db=db,
        prompts=PgPromptRepository(),
        budgets=PgBudgetRepository(),
        calls=PgCallLog(),
        outbox=PgOutbox(),
        providers=providers,
        embeddings=embeddings,
        detector=detector,
        sessions=store,
        cache=store,
        clock=clock,
        settings=GatewaySettings(
            routes=config.routes,
            default_limits=defaults,
            pseudonym_secret=config.pseudonym_secret,
            embedding_model=embeddings.model,
            embedding_redact_purposes=frozenset({'resume_chunk', 'profile_summary'}),
        ),
    )
    verifier = JwtVerifier(
        issuer=config.issuer,
        audience=config.audience,
        jwks_url=config.jwks_url,
        shared_secret=config.jwt_secret,
    )
    container = Container(
        gateway=gateway,
        prompts=PromptRegistry(db, PgPromptRepository()),
        budgets=BudgetAdmin(db, PgBudgetRepository(), clock, defaults),
        verifier=verifier,
        readiness=readiness,
    )
    return container, db, readiness


def app_from_env() -> FastAPI:  # pragma: no cover - process wiring
    config = Config.from_env()
    container, db, _ = build(config)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await db.open()
        task = (
            asyncio.create_task(run_consumer(db, config.kafka_brokers))
            if config.kafka_brokers
            else None
        )
        try:
            yield
        finally:
            if task:
                task.cancel()
            await db.close()

    app = create_app(container)
    app.router.lifespan_context = lifespan
    return app


def main() -> None:  # pragma: no cover - process entry point
    configure_logging('llm-gateway')
    config = Config.from_env()
    uvicorn.run(
        'llm_gateway.main:app_from_env',
        factory=True,
        host='0.0.0.0',  # noqa: S104 - the container's only interface
        port=config.port,
        log_config=None,
        # The app's own middleware logs requests by path only; uvicorn's would add query strings.
        access_log=False,
    )


if __name__ == '__main__':  # pragma: no cover
    main()

"""Composition root: the API process (HTTP, text WebSocket, consumer, maintenance) and the voice
agent worker (`python -m interview_svc.main worker`)."""

from __future__ import annotations

import asyncio
import logging
import signal
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
from atlas_platform.ids import uuid7
from atlas_platform.logs import configure_logging
from fastapi import FastAPI

from interview_svc.application.contexts import Contexts
from interview_svc.application.events import EventHandlers
from interview_svc.application.interviewer import ResilientInterviewer
from interview_svc.application.interviews import InterviewService
from interview_svc.application.maintenance import Maintenance
from interview_svc.application.ports import HotState, Recorder, SessionRow
from interview_svc.application.runner import SessionRunner
from interview_svc.application.scoring import ScoringService
from interview_svc.config import Config
from interview_svc.domain.state import Turn
from interview_svc.http.app import Container, create_app
from interview_svc.infrastructure.clients import GatewayClient, TaxonomyClient, TenantsClient
from interview_svc.infrastructure.hot import MemoryHotState, RedisHotState
from interview_svc.infrastructure.livekit import LiveKitTokens
from interview_svc.infrastructure.recorder import MemoryRecorder, S3Recorder
from interview_svc.infrastructure.repositories import PgStore
from interview_svc.prompts import PROMPTS

log = logging.getLogger('interview_svc')


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


@dataclass
class Built:
    config: Config
    db: PgDatabase
    store: PgStore
    gateway: GatewayClient
    contexts: Contexts
    scoring: ScoringService
    runner: SessionRunner
    new_runner: Callable[..., SessionRunner]
    interviews: InterviewService
    handlers: EventHandlers
    maintenance: Maintenance
    recorder: Recorder
    rooms: LiveKitTokens
    background: set[asyncio.Task[Any]]

    def spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self.background.add(task)
        task.add_done_callback(self.background.discard)


def build(config: Config) -> Built:  # pragma: no cover - process wiring
    clock = SystemClock()
    db = PgDatabase(config.database_url, app_role=config.db_app_role)
    tokens = ClientCredentialsTokenProvider(
        token_url=config.token_url,
        client_id=config.client_id,
        client_secret=config.client_secret,
        scopes=['llm:invoke', 'prompts:write', 'tenant-settings:read'],
    )
    gateway = GatewayClient(config.gateway_url, tokens, 30.0, None)
    store = PgStore()
    outbox = PgOutbox()
    hot: HotState = MemoryHotState()
    if config.redis_url:
        from redis.asyncio import Redis

        hot = RedisHotState(Redis.from_url(config.redis_url))
    recorder: Recorder = (
        S3Recorder(config.s3_bucket, config.s3_endpoint) if config.s3_bucket else MemoryRecorder()
    )
    scoring = ScoringService(db, store, outbox, gateway, clock, calibration=config.calibration)
    contexts = Contexts(db, store, ResilientInterviewer(gateway), scoring)
    background: set[asyncio.Task[Any]] = set()

    def on_turn_eval(session: SessionRow, qid: str, turns: list[Turn]) -> None:
        async def evaluate() -> None:
            try:
                plan, _, _ = await contexts.plan(session)
                await scoring.evaluate_turn(session, plan, qid, turns)
            except Exception:
                log.exception('turn evaluation failed; SCORING will retry it')

        task = asyncio.ensure_future(evaluate())
        background.add(task)
        task.add_done_callback(background.discard)

    def new_runner(suffix: str | None = None) -> SessionRunner:
        # Each lease holder (agent worker, maintenance, every WebSocket) has its own id.
        holder = f'{config.worker_id}:{suffix or uuid7()[-12:]}'
        return SessionRunner(
            db=db,
            store=store,
            hot=hot,
            outbox=outbox,
            clock=clock,
            contexts=contexts,
            worker_id=holder,
            lease_ttl_s=config.lease_ttl_s,
            on_turn_eval=on_turn_eval,
        )

    runner = new_runner('agent')
    rooms = LiveKitTokens(config.livekit_api_key, config.livekit_api_secret, config.livekit_url)
    interviews = InterviewService(
        db=db,
        store=store,
        outbox=outbox,
        llm=gateway,
        taxonomy=TaxonomyClient(config.taxonomy_url, tokens, 10.0, None),
        tenants=TenantsClient(config.tenant_url, tokens, 10.0, None),
        rooms=rooms,
        clock=clock,
        ws_base_url=config.ws_base_url,
    )
    return Built(
        config=config,
        db=db,
        store=store,
        gateway=gateway,
        contexts=contexts,
        scoring=scoring,
        runner=runner,
        new_runner=new_runner,
        interviews=interviews,
        handlers=EventHandlers(db, store, outbox, recorder, clock),
        maintenance=Maintenance(db, store, new_runner('maintenance'), clock),
        recorder=recorder,
        rooms=rooms,
        background=background,
    )


async def maintenance_loop(m: Maintenance, every_s: float = 10.0) -> None:  # pragma: no cover
    while True:
        try:
            await m.run_once()
        except Exception:
            log.exception('maintenance pass failed')
        await asyncio.sleep(every_s)


def app_from_env() -> FastAPI:  # pragma: no cover - process wiring
    config = Config.from_env()
    built = build(config)
    container = Container(
        interviews=built.interviews,
        new_runner=built.new_runner,
        verifier=JwtVerifier(
            issuer=config.issuer,
            audience=config.audience,
            jwks_url=config.jwks_url,
            shared_secret=config.jwt_secret,
        ),
        readiness=[built.db.ping],
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await built.db.open()
        try:
            await built.gateway.register_prompts(PROMPTS)
        except Exception:
            log.exception('prompt registration failed; LLM calls fail until it succeeds')
        if config.kafka_brokers:
            from interview_svc.infrastructure.consumer import run_consumer

            built.spawn(run_consumer(built.handlers, config.kafka_brokers))
        built.spawn(maintenance_loop(built.maintenance))
        try:
            yield
        finally:
            for task in list(built.background):
                task.cancel()
            await built.db.close()

    app = create_app(container)
    app.router.lifespan_context = lifespan
    return app


async def run_worker() -> None:  # pragma: no cover - needs LiveKit, GPUs and models
    from interview_svc.infrastructure.repositories import PgStore as _Store
    from interview_svc.voice.adapters import (
        GatewayEndpointer,
        HttpTts,
        LiveKitTransport,
        SileroVad,
        WhisperStt,
    )
    from interview_svc.voice.agent import VoiceAgent
    from interview_svc.voice.audio import EnergyVad
    from interview_svc.voice.ports import Vad
    from interview_svc.voice.worker import AgentWorker

    config = Config.from_env()
    built = build(config)
    await built.db.open()
    stt = WhisperStt(config.stt_model)
    if not config.tts_url:
        raise ValueError('ATLAS_INTERVIEW_TTS_URL is required for the agent worker.')
    tts = HttpTts(config.tts_url, config.tts_voice)
    store = _Store()

    async def on_recording(session: SessionRow, key: str) -> None:
        async with built.db.tenant_tx(session.tenant_id) as tx:
            await store.set_recording(tx, session.session_id, key)

    async def make_agent(session: SessionRow) -> VoiceAgent:
        room = f'iv_{session.session_id}'
        token = built.rooms.agent(room, f'agent:{config.worker_id}', 3 * 60 * 60)
        transport = LiveKitTransport(config.livekit_url, token)
        await transport.connect()
        vad: Vad = SileroVad() if config.vad == 'silero' else EnergyVad()
        return VoiceAgent(
            runner=built.runner,
            session=session,
            transport=transport,
            vad=vad,
            stt=stt,
            tts=tts,
            endpointer=GatewayEndpointer(built.gateway, session.tenant_id),
            recorder=built.recorder,
            on_recording=on_recording,
        )

    worker = AgentWorker(
        db=built.db,
        store=built.store,
        runner=built.runner,
        maintenance=built.maintenance,
        make_agent=make_agent,
        capacity=config.worker_capacity,
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await worker.run_forever(stop)
    await built.db.close()


def main() -> None:  # pragma: no cover - process entry point
    configure_logging('interview-svc')
    if sys.argv[1:] == ['worker']:
        asyncio.run(run_worker())
        return
    config = Config.from_env()
    uvicorn.run(
        'interview_svc.main:app_from_env',
        factory=True,
        host='0.0.0.0',  # noqa: S104 - the container's only interface
        port=config.port,
        log_config=None,
        access_log=False,  # the app logs requests by path only
    )


if __name__ == '__main__':  # pragma: no cover
    main()

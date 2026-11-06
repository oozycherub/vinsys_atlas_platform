"""HTTP API (PRD §2.4b "APIs") and the text-mode WebSocket."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from atlas_platform.auth import Principal
from atlas_platform.errors import AppError
from atlas_platform.web import (
    UUID_PATTERN,
    Verifier,
    authenticate,
    install,
    problem,
    require_service,
)
from fastapi import Depends, FastAPI, Path, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from interview_svc.application.interviews import Actor, InterviewService
from interview_svc.application.maintenance import NullSink
from interview_svc.application.ports import UpstreamError
from interview_svc.application.runner import LeaseLostError, SessionRunner
from interview_svc.domain.dialogue import MOVE_ON_MS, NUDGE_MS, OFFER_MOVE_ON_MS
from interview_svc.domain.state import Utterance

log = logging.getLogger('interview_svc')

SESSION_SCOPE = 'interviews:sessions'
MAX_MESSAGE_CHARS = 5000
AUTH_TIMEOUT_S = 10.0


@dataclass
class Container:
    interviews: InterviewService
    # One lease holder per WebSocket: two tabs on the same replica must not share a lease.
    new_runner: Callable[[], SessionRunner]
    verifier: Verifier | None
    readiness: list[Callable[[], Awaitable[None]]] = field(default_factory=list)
    silence_tick_s: float = 1.0


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Thresholds(Strict):
    advance: float = Field(default=3.5, ge=1, le=5)
    hold: float = Field(default=2.5, ge=1, le=5)


class CreateInterview(Strict):
    job_profile_id: str = Field(pattern=UUID_PATTERN)
    mode: Literal['voice', 'text']
    title: str | None = Field(default=None, min_length=1, max_length=200)
    language: str = Field(default='en', pattern=r'^[a-z]{2}(-[A-Z]{2})?$')
    max_minutes: int = Field(default=20, ge=5, le=60)
    questions_per_skill: int = Field(default=1, ge=1, le=3)
    thresholds: Thresholds | None = None
    plan: dict[str, Any] | None = Field(
        default=None, description='A plan to use as-is; omitted, one is generated from the profile.'
    )


class PlanBody(Strict):
    plan: dict[str, Any]


class CreateSession(Strict):
    tenant_id: str = Field(pattern=UUID_PATTERN)
    assessment_id: str = Field(pattern=UUID_PATTERN)
    assessment_session_id: str = Field(pattern=UUID_PATTERN)
    question_id: str = Field(pattern=UUID_PATTERN)
    candidate_id: str = Field(pattern=UUID_PATTERN)


class OverrideBody(Strict):
    reason: str = Field(min_length=3, max_length=2000)
    recommendation: Literal['advance', 'hold', 'do_not_advance'] | None = None
    scores: dict[str, Annotated[int, Field(ge=1, le=5)] | None] = Field(default_factory=dict)


Caller = Annotated[Principal, Depends(authenticate)]
Id = Annotated[str, Path(pattern=UUID_PATTERN)]
TenantParam = Annotated[str | None, Query(pattern=UUID_PATTERN)]


def actor(p: Principal, tenant_id: str | None) -> Actor:
    """Tenant staff act in their own tenant; platform staff name the tenant."""
    if p.tenant_id is not None:
        if tenant_id is not None and tenant_id.lower() != p.tenant_id.lower():
            raise AppError('forbidden', 'TENANT_MISMATCH', 'The token is bound to another tenant.')
        return Actor(p.subject, p.tenant_id.lower(), p.roles)
    if 'super_admin' in p.roles and tenant_id is not None:
        return Actor(p.subject, tenant_id.lower(), p.roles)
    raise AppError('validation', 'TENANT_REQUIRED', 'tenant_id is required for this caller.')


def interview_token(request: Request | WebSocket) -> str:
    scheme, _, token = request.headers.get('authorization', '').partition(' ')
    if scheme.lower() != 'interview' or not token:
        raise AppError('unauthorized', 'UNAUTHENTICATED', 'An interview token is required.')
    return token.strip()


class WsSink:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.ended = False
        self.last_activity = time.monotonic()

    async def utter(self, u: Utterance) -> None:
        self.last_activity = time.monotonic()
        await self.ws.send_json({'type': 'utterance', **u})

    async def notice(self, kind: str, data: dict[str, Any]) -> None:
        if kind == 'ended':
            self.ended = True
            data = {'outcome': data.get('outcome')}  # the evaluation is not the candidate's
        await self.ws.send_json({'type': kind, **data})


def create_app(container: Container) -> FastAPI:
    app = FastAPI(
        title='Atlas interview-svc',
        version='1.0.0',
        description='AI voice and text interviews (brick 11): plans, sessions, transcripts, '
        'evaluations and overrides.',
        docs_url=None,
        redoc_url=None,
    )
    c = container
    install(app, c.verifier if c is not None else None)

    @app.exception_handler(UpstreamError)
    async def upstream(request: Request, error: UpstreamError) -> JSONResponse:
        log.warning('dependency unavailable', extra={'error': str(error)[:200]})
        return problem(
            request,
            503,
            'UPSTREAM_UNAVAILABLE',
            'Service unavailable',
            'A dependency is unavailable.',
        )

    # -- health

    @app.get('/healthz', include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {'status': 'ok'}

    @app.get('/readyz', include_in_schema=False)
    async def readyz(request: Request) -> Response:
        try:
            for check in c.readiness:
                await check()
        except Exception:  # noqa: BLE001 - any dependency failure means not ready
            return problem(
                request, 503, 'NOT_READY', 'Service unavailable', 'A dependency is unavailable.'
            )
        return JSONResponse({'status': 'ready'})

    # -- interviews (recruiters)

    @app.post('/v1/interviews', status_code=201, tags=['interviews'])
    async def create_interview(
        body: CreateInterview, p: Caller, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        data = body.model_dump()
        data['thresholds'] = body.thresholds.model_dump() if body.thresholds else None
        return await c.interviews.create(actor(p, tenant_id), data)

    @app.post('/v1/interviews/{interview_id}:publish', tags=['interviews'])
    async def publish_interview(
        interview_id: Id, p: Caller, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        return await c.interviews.publish(actor(p, tenant_id), interview_id.lower())

    @app.get('/v1/interviews/{interview_id}', tags=['interviews'])
    async def get_interview(
        interview_id: Id, p: Caller, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        return await c.interviews.get(actor(p, tenant_id), interview_id.lower())

    @app.put('/v1/interviews/{interview_id}/plan', tags=['interviews'])
    async def update_plan(
        interview_id: Id, body: PlanBody, p: Caller, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        return await c.interviews.update_plan(actor(p, tenant_id), interview_id.lower(), body.plan)

    # -- sessions (assessment-svc)

    @app.post('/v1/interviews/{interview_id}/sessions', status_code=201, tags=['sessions'])
    async def create_session(interview_id: Id, body: CreateSession, p: Caller) -> dict[str, Any]:
        require_service(p, SESSION_SCOPE)
        if p.tenant_id is not None and p.tenant_id.lower() != body.tenant_id.lower():
            raise AppError('forbidden', 'TENANT_MISMATCH', 'The token is bound to another tenant.')
        data = {k: v.lower() for k, v in body.model_dump().items()}
        return await c.interviews.create_session(data['tenant_id'], interview_id.lower(), data)

    # -- the candidate (interview token)

    @app.post('/v1/interview-sessions/{session_id}:join', tags=['sessions'])
    async def join(session_id: Id, request: Request) -> dict[str, Any]:
        return await c.interviews.join(session_id.lower(), interview_token(request))

    @app.get('/v1/interview-sessions/{session_id}/transcript', tags=['sessions'])
    async def transcript(
        session_id: Id, request: Request, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        scheme = request.headers.get('authorization', '').partition(' ')[0].lower()
        if scheme == 'interview':
            s = await c.interviews.by_token(session_id.lower(), interview_token(request))
            return await c.interviews.transcript(s.tenant_id, s.session_id)
        a = actor(await authenticate(request), tenant_id)
        a.require(
            frozenset({'recruiter', 'hiring_manager', 'tenant_admin', 'super_admin', 'reviewer'})
        )
        return await c.interviews.transcript(a.tenant_id, session_id.lower())

    @app.get('/v1/interview-sessions/{session_id}/evaluation', tags=['evaluations'])
    async def evaluation(
        session_id: Id, p: Caller, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        return await c.interviews.evaluation(actor(p, tenant_id), session_id.lower())

    @app.post('/v1/interview-sessions/{session_id}/evaluation:override', tags=['evaluations'])
    async def override(
        session_id: Id, body: OverrideBody, p: Caller, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        scores = {k.lower(): v for k, v in body.scores.items()}
        return await c.interviews.override(
            actor(p, tenant_id), session_id.lower(), body.reason, body.recommendation, scores
        )

    # -- text mode

    @app.websocket('/v1/interviews/{session_id}/ws')
    async def text_mode(ws: WebSocket, session_id: str) -> None:
        await ws.accept()
        await run_text_session(c, ws, session_id.lower())

    return app


async def run_text_session(c: Container, ws: WebSocket, session_id: str) -> None:
    """Protocol: the client sends {"type": "auth", "token": "ivt_..."} first (never in the URL),
    then {"type": "consent", "accepted": bool} and {"type": "message", "text": ...}. The server
    sends ready, utterance, phase, offer_text, error and ended messages."""
    runner = c.new_runner()
    try:
        first = await asyncio.wait_for(ws.receive_json(), AUTH_TIMEOUT_S)
        token = (
            first.get('token') if isinstance(first, dict) and first.get('type') == 'auth' else None
        )
        session = await c.interviews.by_token(session_id, str(token or ''))
        session = await runner.acquire(session.session_id)
    except (TimeoutError, WebSocketDisconnect, ValueError):
        await _close(ws, 4400)
        return
    except AppError as error:
        await _error(ws, error)
        await _close(ws, 4401 if error.kind == 'unauthorized' else 4409)
        return
    sink = WsSink(ws)
    renewer = asyncio.ensure_future(_renew(runner, session.session_id))
    try:
        await ws.send_json({'type': 'ready', 'status': session.status})
        kind = 'start' if session.started_at is None else 'rejoin'
        session, state = await runner.submit(session, kind, {}, sink)
        marks: set[int] = set()
        while not sink.ended:
            try:
                msg = await asyncio.wait_for(ws.receive_json(), c.silence_tick_s)
            except TimeoutError:
                idle_ms = int((time.monotonic() - sink.last_activity) * 1000)
                mark = max(
                    (m for m in (NUDGE_MS, OFFER_MOVE_ON_MS, MOVE_ON_MS) if idle_ms >= m), default=0
                )
                if mark and mark not in marks and state['phase'] == 'LISTEN':
                    marks.add(mark)
                    session, state = await runner.submit(
                        session, 'silence', {'silent_ms': idle_ms}, sink
                    )
                continue
            sink.last_activity = time.monotonic()
            marks.clear()
            payload = _input(msg)
            if payload is None:
                await ws.send_json({'type': 'error', 'code': 'INVALID_MESSAGE'})
                continue
            try:
                session, state = await runner.submit(session, payload[0], payload[1], sink)
            except AppError as error:
                await _error(ws, error)
            except UpstreamError:
                # A dependency failed mid-node (e.g. the scorer after the wrap-up). The checkpoint
                # keeps the pending node: maintenance finishes it; the candidate is told politely.
                await ws.send_json({'type': 'error', 'code': 'UPSTREAM_UNAVAILABLE'})
                state = (await runner.load(session)).state
                if state['next'] == 'SCORING' or state['phase'] in ('WRAP_UP', 'SCORING'):
                    await ws.send_json({'type': 'ended', 'outcome': state['outcome']})
                    sink.ended = True
        await _close(ws, 1000)
    except WebSocketDisconnect:
        if not sink.ended:
            with contextlib.suppress(AppError, LeaseLostError):
                await runner.submit(session, 'disconnect', {}, NullSink())
    except LeaseLostError:
        await _close(ws, 4409)
    finally:
        renewer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await renewer
        await runner.release(session.session_id)


def _input(msg: object) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(msg, dict):
        return None
    if msg.get('type') == 'consent' and isinstance(msg.get('accepted'), bool):
        return 'consent', {'accepted': msg['accepted']}
    text = msg.get('text')
    if (
        msg.get('type') == 'message'
        and isinstance(text, str)
        and 0 < len(text) <= MAX_MESSAGE_CHARS
    ):
        return 'utterance', {'text': text}
    return None


async def _renew(runner: SessionRunner, session_id: str) -> None:
    while True:
        await asyncio.sleep(max(1.0, runner.lease_ttl_s / 4))
        await runner.renew(session_id)


async def _error(ws: WebSocket, error: AppError) -> None:
    with contextlib.suppress(Exception):
        await ws.send_json({'type': 'error', 'code': error.code, 'detail': error.message})


async def _close(ws: WebSocket, code: int) -> None:
    with contextlib.suppress(Exception):
        await ws.close(code)

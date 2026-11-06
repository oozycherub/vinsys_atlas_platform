"""Fixtures: a real Postgres (pgserver) with migrations 0001 + 0015, a scripted llm-gateway,
and the service wired as in production (minus Kafka, Redis, LiveKit and GPUs)."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import jwt
import psycopg
import pytest
from atlas_platform.auth import JwtVerifier
from atlas_platform.db import PgDatabase
from atlas_platform.events import PgOutbox

from interview_svc.application.contexts import Contexts
from interview_svc.application.events import EventHandlers
from interview_svc.application.interviewer import ResilientInterviewer
from interview_svc.application.interviews import Actor, InterviewService
from interview_svc.application.maintenance import Maintenance
from interview_svc.application.ports import JobProfile, SessionRow, UpstreamError
from interview_svc.application.runner import SessionRunner
from interview_svc.application.scoring import ScoringService
from interview_svc.domain.state import Turn, Utterance
from interview_svc.http.app import Container
from interview_svc.infrastructure.hot import MemoryHotState
from interview_svc.infrastructure.livekit import LiveKitTokens
from interview_svc.infrastructure.recorder import MemoryRecorder
from interview_svc.infrastructure.repositories import PgStore
from interview_svc.prompts import (
    ENDPOINTING,
    INTERVIEWER,
    INTERVIEWER_FAILOVER,
    PLANNER,
    SCORER,
    TURN_EVALUATOR,
)

MIGRATIONS = Path(__file__).resolve().parents[3] / 'db' / 'migrations'
JWT_SECRET = 'test-secret-for-interview-svc-0123456789'
ISSUER = 'https://identity.atlas.test'
AUDIENCE = 'atlas-api'
LIVEKIT_SECRET = 'livekit-secret-for-tests-0123456789abcdef'

SKILL_A = '0192f0c1-0000-7000-8000-0000000000c1'
SKILL_B = '0192f0c1-0000-7000-8000-0000000000c2'


def plan_doc(**overrides: Any) -> dict[str, Any]:
    """A 3-question plan: two competencies, a knockout and an FAQ."""
    doc: dict[str, Any] = {
        'language': 'en',
        'max_minutes': 20,
        'competencies': [
            {
                'skill_id': SKILL_A,
                'name': 'Cash-flow analysis',
                'weight': 0.6,
                'questions': [
                    {
                        'qid': 'q1',
                        'text': "Walk me through how you'd assess a client's working-capital needs.",
                        'probes': [
                            'Which ratios would you use?',
                            'What red flags change your view?',
                        ],
                        'rubric': {
                            '1': 'Generic',
                            '3': 'One ratio',
                            '5': 'Structured, seasonality',
                        },
                    },
                    {
                        'qid': 'q2',
                        'text': 'How do you forecast cash for a seasonal business?',
                        'probes': [],
                        'rubric': {'1': 'Guess', '3': 'Monthly model', '5': 'Scenarios'},
                    },
                ],
            },
            {
                'skill_id': SKILL_B,
                'name': 'Stakeholder communication',
                'weight': 0.4,
                'questions': [
                    {
                        'qid': 'q3',
                        'text': 'Tell me about a time you explained a risk to a client.',
                        'probes': ['How did the client react?'],
                        'rubric': {'1': 'Vague', '3': 'Clear', '5': 'Tailored and followed up'},
                    }
                ],
            },
        ],
        'knockouts': [],
        'faq': [
            {
                'question': 'How long does this interview take?',
                'answer': 'It takes up to twenty minutes.',
            }
        ],
    }
    doc.update(overrides)
    return doc


class FixedClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 11, 6, 9, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += timedelta(seconds=seconds)


Script = Callable[[dict[str, str]], dict[str, Any]]


@dataclass
class FakeLlm:
    """llm-gateway: each prompt answers from a script; calls are recorded. A script may raise
    or sleep (latency) to exercise the fallbacks."""

    scripts: dict[str, Script] = field(default_factory=dict)
    delays: dict[str, float] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)
    registered: list[dict[str, Any]] = field(default_factory=list)

    async def complete(
        self,
        tenant_id: str,
        purpose: str,
        prompt: str,
        variables: dict[str, str],
        known_pii: Any = (),
    ) -> dict[str, Any]:
        self.calls.append((prompt, variables))
        if self.delays.get(prompt):
            await asyncio.sleep(self.delays[prompt])
        script = self.scripts.get(prompt)
        if script is None:
            raise UpstreamError(f'no script for {prompt}')
        return {**script(variables), '_model': 'fake-model'}

    async def register_prompts(self, prompts: Any) -> None:
        self.registered.extend(prompts)

    def called(self, prompt: str) -> list[dict[str, str]]:
        return [v for p, v in self.calls if p == prompt]


def quote_from(transcript: str, turn: int, words: int = 6) -> str:
    """The first words of a numbered turn in a scorer prompt (an honest citation)."""
    for line in transcript.splitlines():
        if line.startswith(f'[turn {turn}] '):
            return ' '.join(line.split(' ', 2)[2].split()[:words])
    return ''


def turns_in(transcript: str) -> list[int]:
    return [
        int(line.split(']')[0][6:]) for line in transcript.splitlines() if line.startswith('[turn ')
    ]


def default_scripts(scores: dict[str, int | None] | None = None) -> dict[str, Script]:
    wanted = scores or {SKILL_A: 4, SKILL_B: 3}

    def interviewer(v: dict[str, str]) -> dict[str, Any]:
        if v['task'] == 'ask':
            return {'action': 'ask', 'utterance': 'Thank you.'}
        remaining = int(v['probes_remaining'])
        last = v['recent_turns'].splitlines()[-1] if v['recent_turns'] else ''
        if remaining > 0 and len(last.split()) < 12:
            return {'action': 'probe', 'probe_index': 0, 'utterance': 'Which ratios would you use?'}
        return {'action': 'next', 'utterance': ''}

    def evaluator(v: dict[str, str]) -> dict[str, Any]:
        turns = turns_in(v['answer_turns'])
        return {
            'evidence': [{'turn': t, 'quote': quote_from(v['answer_turns'], t)} for t in turns[:2]],
            'provisional_level': 3,
        }

    def scorer(v: dict[str, str]) -> dict[str, Any]:
        turns = turns_in(v['transcript'])
        out = []
        for i, (skill, score) in enumerate(wanted.items()):
            t = turns[min(i, len(turns) - 1)] if turns else 0
            out.append(
                {
                    'skill_id': skill,
                    'score': score,
                    'rationale': 'Grounded in the answer.',
                    'evidence': [{'turn': t, 'quote': quote_from(v['transcript'], t)}]
                    if score is not None
                    else [],
                }
            )
        return {'competencies': out}

    return {
        INTERVIEWER: interviewer,
        INTERVIEWER_FAILOVER: interviewer,
        TURN_EVALUATOR: evaluator,
        SCORER: scorer,
        ENDPOINTING: lambda v: {'complete': True},
        PLANNER: lambda v: plan_doc(),
    }


class FakeTaxonomy:
    def __init__(self) -> None:
        self.profiles: dict[str, JobProfile] = {}

    async def job_profile(self, tenant_id: str, job_profile_id: str) -> JobProfile | None:
        return self.profiles.get(job_profile_id)


class FakeTenants:
    def __init__(self) -> None:
        self.by_tenant: dict[str, list[str]] = {}
        self.fail = False

    async def jurisdictions(self, tenant_id: str) -> list[str]:
        if self.fail:
            raise UpstreamError('tenant-svc down')
        return self.by_tenant.get(tenant_id, [])


class RecordingSink:
    def __init__(self) -> None:
        self.utterances: list[Utterance] = []
        self.notices: list[tuple[str, dict[str, Any]]] = []

    async def utter(self, u: Utterance) -> None:
        self.utterances.append(u)

    async def notice(self, kind: str, data: dict[str, Any]) -> None:
        self.notices.append((kind, data))

    def texts(self) -> list[str]:
        return [u['text'] for u in self.utterances]

    def kinds(self) -> list[str]:
        return [u['kind'] for u in self.utterances]


@pytest.fixture(scope='session')
def postgres_uri(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    import pgserver

    server = pgserver.get_server(tmp_path_factory.mktemp('pg'), cleanup_mode='stop')  # type: ignore[attr-defined]
    uri: str = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        for name in ('0001_foundation.sql', '0015_interviews.sql'):
            conn.execute((MIGRATIONS / name).read_text())
    yield uri
    server.cleanup()


@pytest.fixture(scope='session')
async def db(postgres_uri: str) -> AsyncIterator[PgDatabase]:
    database = PgDatabase(postgres_uri, app_role='atlas_app', max_size=6)
    await database.open()
    yield database
    await database.close()


def token(
    roles: list[str] | None = None,
    tid: str | None = None,
    scopes: list[str] | None = None,
    sub: str = 'user-1',
) -> str:
    claims: dict[str, Any] = {
        'sub': sub,
        'iss': ISSUER,
        'aud': AUDIENCE,
        'exp': int(time.time()) + 600,
        'roles': roles or ['recruiter'],
        'scopes': scopes or [],
    }
    if tid:
        claims['tid'] = tid
    return str(jwt.encode(claims, JWT_SECRET, algorithm='HS256'))


@dataclass
class Harness:
    db: PgDatabase
    store: PgStore
    clock: FixedClock
    llm: FakeLlm
    taxonomy: FakeTaxonomy
    tenants: FakeTenants
    hot: MemoryHotState
    recorder: MemoryRecorder
    scoring: ScoringService
    contexts: Contexts
    interviews: InterviewService
    handlers: EventHandlers
    rooms: LiveKitTokens
    evals: list[asyncio.Task[None]] = field(default_factory=list)

    def runner(
        self,
        worker: str = 'worker-a',
        failpoint: Callable[[str], None] | None = None,
        flush_every_s: float = 30.0,
    ) -> SessionRunner:
        def on_turn_eval(session: SessionRow, qid: str, turns: list[Turn]) -> None:
            async def run() -> None:
                plan, _, _ = await self.contexts.plan(session)
                await self.scoring.evaluate_turn(session, plan, qid, turns)

            self.evals.append(asyncio.ensure_future(run()))

        return SessionRunner(
            db=self.db,
            store=self.store,
            hot=self.hot,
            outbox=PgOutbox(),
            clock=self.clock,
            contexts=self.contexts,
            worker_id=worker,
            lease_ttl_s=60,
            flush_every_s=flush_every_s,
            on_turn_eval=on_turn_eval,
            failpoint=failpoint,
        )

    def maintenance(self, runner: SessionRunner) -> Maintenance:
        return Maintenance(self.db, self.store, runner, self.clock)

    def container(self) -> Container:
        return Container(
            interviews=self.interviews,
            new_runner=lambda: self.runner(f'api-1:{uuid.uuid4().hex[:8]}'),
            verifier=JwtVerifier(issuer=ISSUER, audience=AUDIENCE, shared_secret=JWT_SECRET),
            readiness=[self.db.ping],
        )

    async def settle(self) -> None:
        if self.evals:
            await asyncio.gather(*self.evals)
            self.evals.clear()

    async def published(
        self,
        tenant_id: str,
        mode: str = 'text',
        plan: dict[str, Any] | None = None,
        thresholds: dict[str, float] | None = None,
    ) -> str:
        actor = Actor('recruiter-1', tenant_id, frozenset({'recruiter'}))
        view = await self.interviews.create(
            actor,
            {
                'job_profile_id': str(uuid.uuid4()),
                'mode': mode,
                'title': 'Finance analyst screen',
                'plan': plan or plan_doc(),
                'thresholds': thresholds,
            },
        )
        await self.interviews.publish(actor, view['interview_id'])
        return str(view['interview_id'])

    async def session(
        self, tenant_id: str, interview_id: str, *, assessment_id: str | None = None
    ) -> tuple[SessionRow, str]:
        created = await self.interviews.create_session(
            tenant_id,
            interview_id,
            {
                'assessment_id': assessment_id or str(uuid.uuid4()),
                'assessment_session_id': str(uuid.uuid4()),
                'question_id': str(uuid.uuid4()),
                'candidate_id': str(uuid.uuid4()),
            },
        )
        async with self.db.tenant_tx(tenant_id) as tx:
            row = await self.store.session(tx, created['session_id'])
        assert row is not None
        return row, str(created['interview_token'])

    async def outbox(self, tenant_id: str, topic: str) -> list[dict[str, Any]]:
        async with self.db.tenant_tx(tenant_id) as tx:
            rows = await tx.fetch(
                'SELECT payload FROM outbox_events WHERE topic = %s ORDER BY created_at, event_id',
                (topic,),
            )
        return [r['payload'] for r in rows]


@pytest.fixture
def harness(db: PgDatabase) -> Harness:
    clock = FixedClock()
    llm = FakeLlm(scripts=default_scripts())
    store = PgStore()
    outbox = PgOutbox()
    taxonomy = FakeTaxonomy()
    tenants = FakeTenants()
    recorder = MemoryRecorder()
    scoring = ScoringService(db, store, outbox, llm, clock)
    interviewer = ResilientInterviewer(
        llm, filler_after=0.05, failover_after=0.15, failover_timeout=0.15
    )
    contexts = Contexts(db, store, interviewer, scoring)
    rooms = LiveKitTokens('lk-key', LIVEKIT_SECRET, 'wss://rtc.atlas.test')
    interviews = InterviewService(
        db=db,
        store=store,
        outbox=outbox,
        llm=llm,
        taxonomy=taxonomy,
        tenants=tenants,
        rooms=rooms,
        clock=clock,
        ws_base_url='wss://api.atlas.test',
    )
    return Harness(
        db=db,
        store=store,
        clock=clock,
        llm=llm,
        taxonomy=taxonomy,
        tenants=tenants,
        hot=MemoryHotState(),
        recorder=recorder,
        scoring=scoring,
        contexts=contexts,
        interviews=interviews,
        handlers=EventHandlers(db, store, outbox, recorder, clock),
        rooms=rooms,
    )


@pytest.fixture
def tenant() -> str:
    return str(uuid.uuid4())

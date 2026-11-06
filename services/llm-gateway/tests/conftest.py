"""Fixtures: a real Postgres (pgserver) with migrations 0001 + 0008, Presidio, stub providers."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import jwt
import psycopg
import pytest
from atlas_platform.auth import JwtVerifier
from atlas_platform.db import PgDatabase
from atlas_platform.events import PgOutbox

from llm_gateway.application.admin import BudgetAdmin, PromptRegistry
from llm_gateway.application.gateway import Gateway, GatewaySettings
from llm_gateway.application.ports import PiiDetector, RouteTarget
from llm_gateway.domain.policy import BudgetLimits
from llm_gateway.domain.redaction import Detection
from llm_gateway.domain.templates import PromptTemplate, VariableSpec
from llm_gateway.http.app import Container
from llm_gateway.infrastructure.adapters import (
    MemoryKeyValueStore,
    PresidioDetector,
    StubEmbeddings,
)
from llm_gateway.infrastructure.providers import StubProvider
from llm_gateway.infrastructure.repositories import (
    PgBudgetRepository,
    PgCallLog,
    PgPromptRepository,
)

MIGRATIONS = Path(__file__).resolve().parents[3] / 'db' / 'migrations'
JWT_SECRET = 'test-secret-for-llm-gateway-0123456789'
ISSUER = 'https://identity.atlas.test'
AUDIENCE = 'atlas-api'


class FixedClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 11, 5, 9, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


@pytest.fixture(scope='session')
def postgres_uri(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    import pgserver

    server = pgserver.get_server(tmp_path_factory.mktemp('pg'), cleanup_mode='stop')  # type: ignore[attr-defined]
    uri: str = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        for name in ('0001_foundation.sql', '0008_llm_gateway.sql'):
            conn.execute((MIGRATIONS / name).read_text())
    yield uri
    server.cleanup()


@pytest.fixture(scope='session')
async def db(postgres_uri: str) -> AsyncIterator[PgDatabase]:
    # SET LOCAL ROLE atlas_app: every test runs under RLS, as production does.
    database = PgDatabase(postgres_uri, app_role='atlas_app', max_size=4)
    await database.open()
    yield database
    await database.close()


@pytest.fixture(scope='session')
def presidio() -> PresidioDetector:
    return PresidioDetector('en_core_web_sm')


@dataclass
class Harness:
    gateway: Gateway
    providers: dict[str, StubProvider]
    cache: MemoryKeyValueStore
    clock: FixedClock
    db: PgDatabase
    registry: PromptRegistry
    budgets: BudgetAdmin
    embeddings: StubEmbeddings
    tenant: str = field(default_factory=lambda: str(uuid.uuid4()))

    async def register(self, **overrides: Any) -> PromptTemplate:
        template = make_template(**overrides)
        return await self.registry.register(template)

    async def rows(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        async with self.db.tenant_tx(self.tenant) as tx:
            rows: list[dict[str, Any]] = await tx.fetch(sql, params)
            return rows

    async def events(self, topic: str) -> list[dict[str, Any]]:
        rows = await self.rows(
            'SELECT payload FROM outbox_events WHERE tenant_id = %s AND topic = %s ORDER BY created_at',
            (self.tenant, topic),
        )
        return [r['payload'] for r in rows]


def make_template(**overrides: Any) -> PromptTemplate:
    base: dict[str, Any] = {
        'prompt_id': f'test.prompt-{uuid.uuid4().hex[:10]}',
        'version': 1,
        'purpose': 'resume_extraction',
        'route': 'primary',
        'system_template': 'Extract the candidate profile as JSON.',
        'user_template': 'Résumé:\n{{resume}}',
        'variables': {'resume': VariableSpec(required=True, untrusted=True)},
        'output_schema': {
            'type': 'object',
            'properties': {
                'name': {'type': 'string'},
                'email': {'type': 'string'},
                'summary': {'type': 'string'},
                'skills': {'type': 'array', 'items': {'type': 'string'}},
            },
            'required': ['name', 'email', 'summary', 'skills'],
            'additionalProperties': False,
        },
        'contains_candidate_text': True,
        'reidentify_fields': ('/name', '/email'),
        'max_tokens': 2048,
        'deterministic': False,
        'registered_by': 'test',
    }
    base.update(overrides)
    return PromptTemplate(**base)


class FailingDetector:
    async def detect(self, text: str) -> list[Detection]:
        raise RuntimeError('NER model crashed')


def build_harness(
    db: PgDatabase,
    detector: PiiDetector,
    *,
    providers: dict[str, StubProvider] | None = None,
    routes: dict[str, list[RouteTarget]] | None = None,
    defaults: BudgetLimits | None = None,
    cache: MemoryKeyValueStore | None = None,
) -> Harness:
    clock = FixedClock()
    providers = providers or {'stub': StubProvider(name='stub')}
    routes = routes or {
        name: [RouteTarget('stub', model)]
        for name, model in (
            ('primary', 'claude-sonnet-5-5'),
            ('fast', 'claude-haiku-5-5'),
            ('eval', 'claude-opus-5-5'),
        )
    }
    cache = cache or MemoryKeyValueStore(clock)
    defaults = defaults or BudgetLimits(1_000_000, 1_000.0)
    embeddings = StubEmbeddings()
    gateway = Gateway(
        db=db,
        prompts=PgPromptRepository(),
        budgets=PgBudgetRepository(),
        calls=PgCallLog(),
        outbox=PgOutbox(),
        providers=providers,
        embeddings=embeddings,
        detector=detector,
        sessions=cache,
        cache=cache,
        clock=clock,
        settings=GatewaySettings(
            routes=routes,
            default_limits=defaults,
            pseudonym_secret=b'pseudonym-secret-for-tests-0123456789',
            embedding_model=embeddings.model,
            embedding_redact_purposes=frozenset({'resume_chunk'}),
        ),
    )
    return Harness(
        gateway=gateway,
        providers=providers,
        cache=cache,
        clock=clock,
        db=db,
        registry=PromptRegistry(db, PgPromptRepository()),
        budgets=BudgetAdmin(db, PgBudgetRepository(), clock, defaults),
        embeddings=embeddings,
    )


@pytest.fixture
def harness(db: PgDatabase, presidio: PresidioDetector) -> Harness:
    return build_harness(db, presidio)


def container_for(h: Harness) -> Container:
    verifier = JwtVerifier(issuer=ISSUER, audience=AUDIENCE, shared_secret=JWT_SECRET)
    return Container(
        gateway=h.gateway,
        prompts=h.registry,
        budgets=h.budgets,
        verifier=verifier,
        readiness=[h.db.ping],
    )


def token(
    *,
    roles: list[str] | None = None,
    scopes: list[str] | None = None,
    tid: str | None = None,
    sub: str = 'svc:test',
    exp_in: int = 600,
) -> str:
    claims: dict[str, Any] = {
        'sub': sub,
        'iss': ISSUER,
        'aud': AUDIENCE,
        'exp': int(time.time()) + exp_in,
        'roles': roles or ['service'],
        'scopes': scopes if scopes is not None else ['llm:invoke', 'embeddings:create'],
    }
    if tid:
        claims['tid'] = tid
    return str(jwt.encode(claims, JWT_SECRET, algorithm='HS256'))


def user_text(request: Any) -> str:
    """Everything a provider request would send, as one string."""
    return f'{request.system}\n{json.dumps(request.messages)}'

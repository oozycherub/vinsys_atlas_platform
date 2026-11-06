"""Fixtures: real Postgres (pgserver, migrations 0001 + 0009, RLS on), real Presidio and the
real extractors; fakes only for the network services parsing-svc calls."""

from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from atlas_platform.db import PgDatabase
from atlas_platform.events import PgOutbox
from atlas_platform.presidio import PresidioDetector
from atlas_platform.testing import start_postgres

from parsing_svc.application.admin import DataProtection, EmbeddingIndex
from parsing_svc.application.bulk import BulkImporter
from parsing_svc.application.jobs import Dispatcher, InlineRunner, JobService, RetryPolicy
from parsing_svc.application.pipeline import Deps, ParsePipeline
from parsing_svc.application.ports import (
    DocumentInfo,
    DuplicateDocumentError,
    EmailTakenError,
    LlmExtraction,
    NormalizedTerm,
    UploadTarget,
    UpstreamError,
)
from parsing_svc.application.store import Job
from parsing_svc.domain.redact import Contact
from parsing_svc.infrastructure.consumer import EventHandlers
from parsing_svc.infrastructure.extract import DocumentExtractor
from parsing_svc.infrastructure.repositories import (
    PgBatchRepository,
    PgEmbeddingRepository,
    PgJobRepository,
    PgModelSlots,
)
from parsing_svc.infrastructure.scanner import SignatureScanner
from parsing_svc.infrastructure.storage import MemoryStorage

GOLDEN = Path(__file__).resolve().parent / 'golden'
PDF_MIME = 'application/pdf'
DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
SKILL_NS = uuid.UUID('6f1c4a52-35c1-4bb7-9b6e-1b2f9b2d7a10')
#: The fake taxonomy: canonical skills and a few aliases.
CANONICAL = [
    'Python',
    'SQL',
    'Kafka',
    'Spark',
    'Airflow',
    'dbt',
    'Kubernetes',
    'Docker',
    'Terraform',
    'AWS',
    'PostgreSQL',
    'Go',
    'Java',
    'TypeScript',
    'React',
    'Snowflake',
    'Redis',
    'GraphQL',
    'Pandas',
    'PyTorch',
    'Scala',
    'Elasticsearch',
    'Grafana',
    'Linux',
    'Rust',
    'AWS Certified Solutions Architect',
    'Certified Kubernetes Administrator',
    'Google Professional Data Engineer',
    'Terraform Associate',
]
ALIASES = {'k8s': 'Kubernetes', 'postgres': 'PostgreSQL', 'js': 'TypeScript'}
CERT_SKILL = {
    'Certified Kubernetes Administrator': 'Kubernetes',
    'AWS Certified Solutions Architect': 'AWS',
    'Terraform Associate': 'Terraform',
    'Google Professional Data Engineer': 'SQL',
}


def skill_id(name: str) -> str:
    return str(uuid.uuid5(SKILL_NS, CERT_SKILL.get(name, name).lower()))


class FixedClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 11, 5, 9, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


class FakeTaxonomy:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.down = False

    async def normalize(self, tenant_id: str, terms: list[str]) -> list[NormalizedTerm]:
        if self.down:
            raise UpstreamError('taxonomy down')
        self.calls.append(terms)
        canon = {c.lower(): c for c in CANONICAL}
        out = []
        for t in terms:
            key = re.sub(r'[^a-z0-9+# ]', '', t.lower()).strip()
            name = canon.get(key) or ALIASES.get(key)
            out.append(
                NormalizedTerm(
                    t,
                    skill_id(name) if name else None,
                    1.0 if name else 0.0,
                    'alias' if name else 'none',
                )
            )
        return out


class FakeEmbedder:
    """Deterministic hashed bag-of-words vectors, 1024-d, L2-normalised."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self.down = False

    async def embed(self, tenant_id: str, texts: list[str], model: str) -> list[list[float]]:
        if self.down:
            raise UpstreamError('embeddings down')
        self.calls.append((model, texts))
        return [vector(t) for t in texts]


def vector(text: str) -> list[float]:
    v = [0.0] * 1024
    for word in re.findall(r'\w+', text.lower()):
        h = int.from_bytes(hashlib.sha256(word.encode()).digest()[:8], 'big')
        v[h % 1024] += 1.0
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v] if any(v) else [1.0] + [0.0] * 1023


Script = Callable[[str], dict[str, Any] | Exception]


class FakeLlm:
    """llm-gateway stand-in. By default an *oracle* for the golden set: given the résumé id the
    test is parsing (`ref`), it answers with that résumé's expected data, quoting its evidence lines exactly as
    the generator wrote them. If redaction or extraction mangled a line, the verifier will not
    find the quote and the item is dropped, which lowers the golden-set F1."""

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.known: list[list[str]] = []
        self.script: Script | None = None
        self.failures = 0  # the next N calls raise UpstreamError
        self.ref: str | None = None

    async def extract(self, tenant_id: str, text: str, known_pii: list[str]) -> LlmExtraction:
        self.texts.append(text)
        self.known.append(known_pii)
        if self.failures:
            self.failures -= 1
            raise UpstreamError('gateway 503')
        out = self.script(text) if self.script else oracle(self.ref)
        if isinstance(out, Exception):
            raise out
        score = 0.95 if re.search(r'ignore (all )?previous instructions', text, re.I) else 0.0
        return LlmExtraction(out, 'claude-sonnet-5-5', score)


def human(month: str) -> str:
    months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    year, mon = month.split('-')
    return f'{months[int(mon) - 1]} {year}'


def expected(ref: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((GOLDEN / 'expected' / f'{ref}.json').read_text())
    return data


def oracle(ref: str | None) -> dict[str, Any]:
    if ref is None:
        return {'summary': '', 'document_language': 'en', 'work_history': [], 'skills': []}
    e = expected(ref)
    skills_lines = [', '.join(e['skills'][i : i + 4]) for i in range(0, len(e['skills']), 4)]
    work = []
    for role in e['work_history']:
        work.append(
            {
                'employer': role['employer'],
                'title': role['title'],
                'start': role['start'],
                'end': role['end'],
                'is_current': role['is_current'],
                'location_country': None,
                'responsibilities': role['responsibilities'],
                'skills_mentioned': role['skills'],
                'evidence': f'{role["title"]} - {role["employer"]}',
            }
        )
    skills = []
    for s in e['skills']:
        role_line = next(
            (
                r
                for role in e['work_history']
                for r in role['responsibilities']
                if re.search(rf'\b{re.escape(s)}\b', r)
            ),
            None,
        )
        line = role_line or next(x for x in skills_lines if s in x.split(', '))
        skills.append(
            {'raw': s, 'evidence': line, 'context': 'skills', 'years_used': None, 'last_used': None}
        )
    return {
        'summary': e['summary'],
        'document_language': 'en',
        'current_title': e['work_history'][0]['title'],
        'total_experience_months': 60,
        'work_history': work,
        'education': [
            {
                'institution': x['institution'],
                'degree': x['degree'],
                'field': x['field'],
                'end_year': x['end_year'],
                'evidence': f'{x["degree"]} in {x["field"]}, {x["institution"]}, {x["end_year"]}',
            }
            for x in e['education']
        ],
        'certifications': [
            {
                'certificate': c['certificate'],
                'issuer': c['issuer'],
                'issued': c['issued'],
                'credential_id': None,
                'evidence': f'{c["certificate"]} - {c["issuer"]}',
            }
            for c in e['certifications']
        ],
        'projects': [],
        'skills': skills,
        'languages': [{'language': 'English', 'level': 'fluent'}],
    }


@dataclass
class FakeProfile:
    storage: MemoryStorage
    documents: dict[str, DocumentInfo] = field(default_factory=dict)
    candidates: dict[str, str] = field(default_factory=dict)  # idempotency key → candidate id
    contacts: dict[str, Contact] = field(default_factory=dict)
    taken_emails: set[str] = field(default_factory=set)
    shas: dict[str, str] = field(default_factory=dict)
    uploads: list[str] = field(default_factory=list)

    async def get_document(self, tenant_id: str, document_id: str) -> DocumentInfo | None:
        return self.documents.get(document_id)

    async def create_candidate(
        self, tenant_id: str, placeholder_name: str, external_ref: str, idempotency_key: str
    ) -> str:
        return self.candidates.setdefault(idempotency_key, str(uuid.uuid4()))

    async def initiate_upload(
        self, tenant_id: str, candidate_id: str, mime_type: str, byte_size: int, sha256: str
    ) -> UploadTarget:
        if sha256 in self.shas:
            raise DuplicateDocumentError(self.shas[sha256])
        doc = str(uuid.uuid4())
        self.shas[sha256] = doc
        self.documents[doc] = DocumentInfo(
            doc, candidate_id, mime_type, byte_size, 'pending_upload'
        )
        return UploadTarget(doc, f'memory://t/{tenant_id}/resumes/{doc}', {})

    async def upload(self, target: UploadTarget, data: bytes) -> None:
        key = target.url.removeprefix('memory://')
        await self.storage.put(key, data, 'application/octet-stream')
        self.uploads.append(key)

    known: dict[str, Contact] = field(default_factory=dict)

    async def get_contact(self, tenant_id: str, candidate_id: str) -> Contact | None:
        return self.known.get(candidate_id)

    async def update_contact(self, tenant_id: str, candidate_id: str, contact: Contact) -> None:
        if contact.email and contact.email in self.taken_emails:
            raise EmailTakenError()
        self.contacts[candidate_id] = contact


@pytest.fixture(scope='session')
def postgres_uri(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    server, uri = start_postgres(
        tmp_path_factory.mktemp('pg'), ['0001_foundation.sql', '0009_parsing.sql']
    )
    yield uri
    server.cleanup()


@pytest.fixture(scope='session')
async def db(postgres_uri: str) -> AsyncIterator[PgDatabase]:
    database = PgDatabase(postgres_uri, app_role='atlas_app', max_size=6)
    await database.open()
    yield database
    await database.close()


@pytest.fixture(scope='session')
def presidio() -> PresidioDetector:
    return PresidioDetector('en_core_web_sm')


async def no_sleep(_: float) -> None:
    return None


@dataclass
class World:
    db: PgDatabase
    storage: MemoryStorage
    llm: FakeLlm
    taxonomy: FakeTaxonomy
    embedder: FakeEmbedder
    profile: FakeProfile
    clock: FixedClock
    pipeline: ParsePipeline
    jobs: JobService
    runner: InlineRunner
    dispatcher: Dispatcher
    bulk: BulkImporter
    index: EmbeddingIndex
    handlers: EventHandlers
    tenant: str = field(default_factory=lambda: str(uuid.uuid4()))

    async def upload(
        self, data: bytes, mime: str, *, tenant: str | None = None, candidate: str | None = None
    ) -> Job:
        """Simulates profile-svc: object stored, `profile.resume.uploaded.v1` consumed."""
        tenant = tenant or self.tenant
        document = str(uuid.uuid4())
        candidate = candidate or str(uuid.uuid4())
        key = f't/{tenant}/resumes/{document}'
        await self.storage.put(key, data, mime)
        self.profile.documents[document] = DocumentInfo(
            document, candidate, mime, len(data), 'uploaded'
        )
        payload = {
            'tenant_id': tenant,
            'candidate_id': candidate,
            'document_id': document,
            'storage_key': key,
            'mime_type': mime,
            'sha256': hashlib.sha256(data).hexdigest(),
            'byte_size': len(data),
            'occurred_at': self.clock.now().isoformat(),
        }
        assert await self.handlers.handle('profile.resume.uploaded.v1', str(uuid.uuid4()), payload)
        return await self.jobs.from_upload(payload)  # returns the live job just created

    async def parse(self, data: bytes, mime: str, **kwargs: Any) -> Job:
        """Upload, dispatch and run to completion; returns the final job."""
        job = await self.upload(data, mime, **kwargs)
        await self.dispatcher.tick()
        await self.runner.drain()
        return await self.jobs.get(job.tenant_id, job.job_id)

    async def rows(
        self, sql: str, params: tuple[Any, ...] = (), tenant: str | None = None
    ) -> list[dict[str, Any]]:
        async with self.db.tenant_tx(tenant or self.tenant) as tx:
            result: list[dict[str, Any]] = await tx.fetch(sql, params)
            return result

    async def events(self, topic: str, tenant: str | None = None) -> list[dict[str, Any]]:
        rows = await self.rows(
            'SELECT payload FROM outbox_events WHERE topic = %s ORDER BY created_at, event_id',
            (topic,),
            tenant,
        )
        return [r['payload'] for r in rows]


def build_world(db: PgDatabase, detector: Any) -> World:
    storage = MemoryStorage()
    llm, taxonomy, embedder = FakeLlm(), FakeTaxonomy(), FakeEmbedder()
    profile = FakeProfile(storage)
    clock = FixedClock()
    jobs_repo, embeddings, slots, batches, outbox = (
        PgJobRepository(),
        PgEmbeddingRepository(),
        PgModelSlots(),
        PgBatchRepository(),
        PgOutbox(),
    )
    pipeline = ParsePipeline(
        Deps(
            db=db,
            jobs=jobs_repo,
            embeddings=embeddings,
            slots=slots,
            batches=batches,
            outbox=outbox,
            storage=storage,
            scanner=SignatureScanner(),
            extractor=DocumentExtractor(),
            ocr=None,
            detector=detector,
            llm=llm,
            taxonomy=taxonomy,
            embedder=embedder,
            profile=profile,
            clock=clock,
        )
    )
    runner = InlineRunner(pipeline, RetryPolicy(initial=0.0, maximum=0.0))
    jobs = JobService(db, jobs_repo, profile, 'v3.0.0-test')
    return World(
        db=db,
        storage=storage,
        llm=llm,
        taxonomy=taxonomy,
        embedder=embedder,
        profile=profile,
        clock=clock,
        pipeline=pipeline,
        jobs=jobs,
        runner=runner,
        dispatcher=Dispatcher(db, jobs_repo, runner, per_tenant_cap=10),
        bulk=BulkImporter(db, batches, storage, profile),
        index=EmbeddingIndex(db, embeddings, slots, embedder),
        handlers=EventHandlers(
            db, jobs, DataProtection(db, jobs_repo, embeddings, batches, outbox, clock)
        ),
    )


@pytest.fixture
def world(db: PgDatabase, presidio: PresidioDetector) -> World:
    return build_world(db, presidio)


def golden_file(ref: str) -> tuple[bytes, str]:
    e = expected(ref)
    mime = {'pdf': PDF_MIME, 'docx': DOCX_MIME, 'txt': 'text/plain'}[e['file'].rsplit('.', 1)[1]]
    return (GOLDEN / 'files' / e['file']).read_bytes(), mime

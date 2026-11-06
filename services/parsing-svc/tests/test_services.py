"""Security gate, quality rules, bulk import, fair-share dispatch, data protection, model swap."""

from __future__ import annotations

import io
import uuid
import zipfile
from typing import Any

import pymupdf
import pytest
from atlas_platform.errors import AppError

from parsing_svc.application.jobs import Dispatcher
from parsing_svc.application.store import Job
from tests.conftest import DOCX_MIME, PDF_MIME, World, golden_file, vector

# --- security gate ------------------------------------------------------------------------------


def docx_with(extra: dict[str, bytes], compress: int = zipfile.ZIP_DEFLATED) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compress) as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', '<w:document/>')
        for name, data in extra.items():
            z.writestr(name, data)
    return out.getvalue()


@pytest.mark.parametrize(
    ('name', 'data', 'mime', 'status', 'code'),
    [
        (
            'zip bomb',
            docx_with({'word/media/big.bin': b'\0' * 60_000_000}),
            DOCX_MIME,
            'quarantined',
            'MALICIOUS_FILE',
        ),
        (
            'macros',
            docx_with({'word/vbaProject.bin': b'macro'}),
            DOCX_MIME,
            'quarantined',
            'MALICIOUS_FILE',
        ),
        ('zip declared as pdf', docx_with({}), PDF_MIME, 'quarantined', 'MALICIOUS_FILE'),
        ('binary junk', b'\x00\x01\x02' * 100, PDF_MIME, 'quarantined', 'MALICIOUS_FILE'),
        (
            'legacy doc',
            bytes.fromhex('D0CF11E0A1B11AE1') + b'\0' * 600,
            'application/msword',
            'failed',
            'UNSUPPORTED_DOCUMENT',
        ),
        (
            'encrypted office',
            bytes.fromhex('D0CF11E0A1B11AE1') + 'EncryptedPackage'.encode('utf-16-le'),
            DOCX_MIME,
            'failed',
            'ENCRYPTED_DOCUMENT',
        ),
        (
            'corrupt pdf',
            b'%PDF-1.7\n' + b'garbage ' * 50,
            PDF_MIME,
            'failed',
            'UNREADABLE_DOCUMENT',
        ),
        ('empty docx', docx_with({}), DOCX_MIME, 'failed', 'UNREADABLE_DOCUMENT'),
    ],
)
async def test_security_gate(
    world: World, name: str, data: bytes, mime: str, status: str, code: str
) -> None:
    job = await world.parse(data, mime)
    assert (job.status, job.error_code) == (status, code), name
    assert world.llm.texts == []  # nothing that fails the gate reaches the model


async def test_pdf_javascript_is_stripped_before_extraction(world: World) -> None:
    import pikepdf

    data, _ = golden_file('G00')
    pdf = pikepdf.open(io.BytesIO(data))
    pdf.Root.OpenAction = pikepdf.Dictionary(
        S=pikepdf.Name.JavaScript, JS=pikepdf.String('app.alert(1)')
    )
    out = io.BytesIO()
    pdf.save(out)
    cleaned = world.pipeline.d.extractor.sanitize_pdf(out.getvalue())
    assert b'app.alert' not in cleaned
    assert '/OpenAction' not in pikepdf.open(io.BytesIO(cleaned)).Root


async def test_scanned_pdf_without_ocr_is_unreadable(world: World) -> None:
    doc = pymupdf.open()
    doc.new_page()
    job = await world.parse(doc.tobytes(), PDF_MIME)
    assert (job.status, job.error_code) == ('failed', 'UNREADABLE_DOCUMENT')


async def test_scanned_pdf_uses_ocr(world: World) -> None:
    from parsing_svc.domain.layout import Block, LayoutDoc, Page

    class FakeOcr:
        async def ocr(self, mime: str, data: bytes) -> LayoutDoc:
            lines = ['Experience', 'Data Engineer - Northwind Systems', 'Skills', 'Python, SQL']
            blocks = tuple(
                Block(t, (40, 40 + 20 * n, 400, 55 + 20 * n)) for n, t in enumerate(lines)
            )
            return LayoutDoc((Page(595, 842, blocks),), 'ocr', 0.93)

    world.pipeline.d.ocr = FakeOcr()
    doc = pymupdf.open()
    doc.new_page().insert_text((40, 40), 'x')  # almost no text layer: a scan
    job = await world.parse(doc.tobytes(), PDF_MIME)
    assert job.status == 'succeeded'
    assert 'Northwind Systems' in world.llm.texts[-1]


async def test_keyword_stuffing_caps_confidence(world: World) -> None:
    skills = [
        'Python',
        'SQL',
        'Kafka',
        'Spark',
        'Airflow',
        'Docker',
        'Go',
        'Java',
        'Redis',
        'Linux',
    ]
    text = (
        'Skills\n'
        + '\n'.join(', '.join(skills) for _ in range(6))
        + '\nExperience\nEngineer - Northwind Systems\n'
    )

    def stuffed(_: str) -> dict[str, Any]:
        return {
            'summary': '',
            'document_language': 'en',
            'current_title': None,
            'total_experience_months': None,
            'work_history': [],
            'education': [],
            'certifications': [],
            'projects': [],
            'languages': [],
            'skills': [
                {
                    'raw': s,
                    'evidence': ', '.join(skills),
                    'context': 'skills',
                    'years_used': 6,
                    'last_used': '2026-09',
                }
                for s in skills
            ],
        }

    world.llm.script = stuffed
    job = await world.parse(text.encode(), 'text/plain')
    assert 'keyword_stuffing' in job.flags
    event = (await world.events('profile.resume.parsed.v1'))[-1]
    assert event['skills']
    assert all(s['confidence'] == 0.2 for s in event['skills'])


# --- fair-share dispatch -------------------------------------------------------------------------


class Recorder:
    def __init__(self) -> None:
        self.started: list[Job] = []

    async def start(self, job: Job) -> None:
        self.started.append(job)


async def test_dispatch_is_round_robin_with_a_per_tenant_cap(world: World) -> None:
    async with world.db.system_tx() as tx:  # drain whatever earlier tests left queued
        await tx.execute(
            "UPDATE parse_jobs SET status = 'failed' WHERE status IN ('queued', 'running')"
        )
    tenant_a, tenant_b = str(uuid.uuid4()), str(uuid.uuid4())
    for n in range(5):
        await world.upload(f'resume a{n}'.encode(), 'text/plain', tenant=tenant_a)
    for n in range(2):
        await world.upload(f'resume b{n}'.encode(), 'text/plain', tenant=tenant_b)
    recorder = Recorder()
    dispatcher = Dispatcher(world.db, world.pipeline.d.jobs, recorder, per_tenant_cap=2)

    first = await dispatcher.tick(limit=10)
    assert [j.tenant_id for j in first] == [tenant_a, tenant_b, tenant_a, tenant_b]
    assert await dispatcher.tick(limit=10) == []  # both tenants at their cap
    async with world.db.tenant_tx(tenant_a) as tx:
        await world.pipeline.d.jobs.finish(tx, first[0].job_id, 'succeeded')
    third = await dispatcher.tick(limit=10)
    assert [j.tenant_id for j in third] == [tenant_a]
    assert all(j.status == 'running' and j.attempts == 1 for j in first + third)


# --- bulk import -------------------------------------------------------------------------------------


def archive(files: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for name, data in files.items():
            z.writestr(name, data)
    return out.getvalue()


async def test_bulk_import(world: World) -> None:
    g0, _ = golden_file('G00')
    g2, _ = golden_file('G02')
    data = archive(
        {
            'batch/G00.pdf': g0,
            'batch/G02.docx': g2,
            'batch/copy-of-G00.pdf': g0,
            'batch/tool.exe': b'MZ' * 10,
            '__MACOSX/._G00.pdf': b'junk',
            'batch/.DS_Store': b'junk',
        }
    )
    accepted = await world.bulk.accept(world.tenant, data, 'user:recruiter')
    assert accepted['total'] == 4
    counts = await world.bulk.run(world.tenant, accepted['batch_id'])
    assert counts == {'submitted': 2, 'skipped': 2, 'failed': 0}
    assert len(world.profile.uploads) == 2
    status = await world.bulk.status(world.tenant, accepted['batch_id'])
    assert status['status'] == 'imported'
    assert status['items'] == {'submitted': 2, 'skipped': 2}
    assert await world.bulk.run(world.tenant, accepted['batch_id']) == {
        'submitted': 0,
        'skipped': 0,
        'failed': 0,
    }

    for bad, code in (
        (b'not a zip', 'INVALID_ARCHIVE'),
        (archive({'__MACOSX/x': b'1'}), 'EMPTY_ARCHIVE'),
        (archive({f'f{n}.pdf': b'x' for n in range(501)}), 'TOO_MANY_FILES'),
    ):
        with pytest.raises(AppError) as caught:
            await world.bulk.accept(world.tenant, bad, 'user:recruiter')
        assert caught.value.code == code
    with pytest.raises(AppError):
        await world.bulk.status(world.tenant, str(uuid.uuid4()))


# --- data protection -------------------------------------------------------------------------------


async def test_erasure_deletes_and_acknowledges_once(world: World) -> None:
    world.llm.ref = 'G07'
    data, mime = golden_file('G07')
    job = await world.parse(data, mime)
    payload = {
        'tenant_id': world.tenant,
        'request_id': str(uuid.uuid4()),
        'candidate_id': job.candidate_id,
        'reason': 'data_subject',
        'ack_required_from': ['parsing-svc', 'matching-svc'],
        'due_at': '2026-12-05T00:00:00Z',
        'occurred_at': '2026-11-05T00:00:00Z',
    }
    event_id = str(uuid.uuid4())
    assert await world.handlers.handle('privacy.erasure.requested.v1', event_id, payload)
    assert not await world.handlers.handle('privacy.erasure.requested.v1', event_id, payload)
    assert (
        await world.rows(
            'SELECT 1 FROM resume_embeddings WHERE candidate_id = %s', (job.candidate_id,)
        )
        == []
    )
    assert (
        await world.rows('SELECT 1 FROM parse_jobs WHERE candidate_id = %s', (job.candidate_id,))
        == []
    )
    acks = await world.events('privacy.erasure.acknowledged.v1')
    assert [a['service'] for a in acks] == ['parsing-svc']


async def test_tenant_purge_and_poison_events(world: World) -> None:
    world.llm.ref = 'G09'
    data, mime = golden_file('G09')
    await world.parse(data, mime)
    assert await world.handlers.handle(
        'tenant.tenant.purged.v1', str(uuid.uuid4()), {'tenant_id': world.tenant}
    )
    for table in ('resume_embeddings', 'parse_jobs'):
        assert await world.rows(f'SELECT 1 FROM {table}') == []
    for topic, payload in (
        ('profile.resume.uploaded.v1', {'tenant_id': 'nope'}),
        ('profile.resume.uploaded.v1', {'tenant_id': world.tenant}),
        ('privacy.erasure.requested.v1', {'tenant_id': world.tenant}),
        ('something.else.happened.v1', {'tenant_id': world.tenant}),
    ):
        with pytest.raises(ValueError):  # noqa: PT011 - the consumer sends these to the DLQ
            await world.handlers.handle(topic, str(uuid.uuid4()), payload)


# --- embedding model upgrade ------------------------------------------------------------------------


async def test_shadow_backfill_and_promote(world: World) -> None:
    world.llm.ref = 'G13'
    data, mime = golden_file('G13')
    job = await world.parse(data, mime)
    try:
        assert (await world.index.set_shadow('bge-m3-v2', 'staff:ana'))['shadow'] == 'bge-m3-v2'
        result = await world.index.backfill(world.tenant, limit=2)
        assert result['embedded'] == 2
        assert result['remaining'] == 1
        while (await world.index.backfill(world.tenant))['remaining']:
            pass
        # New parses write both models while the shadow exists (dual write).
        world.llm.ref = 'G14'
        data2, mime2 = golden_file('G14')
        second = await world.parse(data2, mime2)
        models = await world.rows(
            'SELECT DISTINCT model_id FROM resume_embeddings WHERE candidate_id = %s',
            (second.candidate_id,),
        )
        assert {m['model_id'] for m in models} == {'bge-m3', 'bge-m3-v2'}

        query = vector('anything')
        with pytest.raises(AppError) as caught:
            await world.index.search(world.tenant, query, 'bge-m3-v2', 5, None)
        assert caught.value.code == 'EMBEDDING_MODEL_MISMATCH'
        assert (await world.index.promote('staff:ana')) == {
            'active': 'bge-m3-v2',
            'shadow': 'bge-m3',
        }
        hits = await world.index.search(world.tenant, query, 'bge-m3-v2', 50, ['skills'])
        assert {h.candidate_id for h in hits} == {job.candidate_id, second.candidate_id}
        assert all(h.chunk_type == 'skills' for h in hits)
        with pytest.raises(AppError):
            await world.index.set_shadow('bge-m3-v2', 'staff:ana')  # already active
    finally:
        async with world.db.system_tx() as tx:  # restore the shared slots for other tests
            await world.pipeline.d.slots.set(tx, 'active', 'bge-m3', 'test')
            await world.pipeline.d.slots.set(tx, 'shadow', None, 'test')
    with pytest.raises(AppError):
        await world.index.promote('staff:ana')
    with pytest.raises(AppError):
        await world.index.backfill(world.tenant)
    with pytest.raises(AppError):
        await world.index.search(world.tenant, [0.1] * 3, 'bge-m3', 5, None)


async def test_pii_detection_failure_fails_closed(world: World) -> None:
    class Broken:
        async def detect(self, text: str) -> list[Any]:
            raise RuntimeError('spaCy model crashed')

    world.pipeline.d.detector = Broken()
    job = await world.parse(b'Experience\nData Engineer - Northwind Systems\n', 'text/plain')
    assert (job.status, job.error_code) == ('failed_retryable', 'DEPENDENCY_UNAVAILABLE')
    assert world.llm.texts == []  # nothing unredacted ever left the worker

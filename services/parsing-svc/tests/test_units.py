"""Pure domain rules and adapters that need no database."""

from __future__ import annotations

import asyncio
import struct
from datetime import date
from typing import Any

import httpx
import pytest

from parsing_svc.application.ports import DuplicateDocumentError, EmailTakenError, UpstreamError
from parsing_svc.config import Config
from parsing_svc.domain.chunks import build_chunks
from parsing_svc.domain.errors import PipelineError
from parsing_svc.domain.layout import Block, LayoutDoc, Page, drop_hidden, reading_order
from parsing_svc.domain.proficiency import SkillFacts, confidence, is_stuffed, proficiency, recency
from parsing_svc.domain.redact import Contact, header_name, redact, scrub
from parsing_svc.domain.schema import from_llm
from parsing_svc.domain.sections import heading_type, segment
from parsing_svc.domain.sniff import DOCX, OLE, PDF, PNG, TEXT, ZIP, check_declared, sniff
from parsing_svc.domain.verify import locate, supported, verify
from parsing_svc.infrastructure.clients import GatewayClient, ProfileClient, TaxonomyClient
from parsing_svc.infrastructure.scanner import EICAR, ClamdScanner, SignatureScanner

# --- domain ------------------------------------------------------------------------------------


def test_sniffing_never_trusts_the_declared_type() -> None:
    assert sniff(b'%PDF-1.7 ...') == PDF
    assert sniff(b'\x89PNG\r\n\x1a\n....') == PNG
    assert sniff(b'PK\x03\x04....') == ZIP
    assert sniff('Résumé\nPython'.encode()) == TEXT
    assert sniff(b'\x00\xff\x00') is None
    assert check_declared(DOCX, ZIP) == DOCX
    assert check_declared('application/msword', OLE) == OLE
    for declared, actual in ((PDF, TEXT), (PDF, ZIP), (PDF, None)):
        with pytest.raises(PipelineError) as caught:
            check_declared(declared, actual)
        assert caught.value.quarantine == 'mime_mismatch'


def test_hidden_text_and_reading_order() -> None:
    page = Page(
        595,
        842,
        (
            Block('visible', (40, 40, 200, 50)),
            Block('white', (40, 60, 200, 70), color=0xFFFFFF),
            Block('tiny', (40, 80, 200, 82), font_size=1.0),
            Block('away', (700, 900, 800, 910)),
        ),
    )
    visible, report = drop_hidden(LayoutDoc((page,), 'pdf'))
    assert [b.text for b in visible.pages[0].blocks] == ['visible']
    assert report.reasons == {'white_text', 'tiny_font', 'off_page'}

    banner = Block('Full Width Name Banner Across The Page', (40, 20, 560, 40))
    left = [Block(f'L{n}', (40, 100 + 20 * n, 220, 110 + 20 * n)) for n in range(4)]
    right = [Block(f'R{n}', (300, 100 + 20 * n, 560, 110 + 20 * n)) for n in range(4)]
    ordered = [b.text for b in reading_order([*right, banner, *left], 595)]
    assert ordered == [banner.text, 'L0', 'L1', 'L2', 'L3', 'R0', 'R1', 'R2', 'R3']
    single = [Block(f'S{n}', (40, 100 + 20 * n, 400, 110 + 20 * n)) for n in range(8)]
    assert [b.text for b in reading_order(single[::-1], 595)] == [b.text for b in single]


def test_sections_and_redaction() -> None:
    assert heading_type('Work Experience') == 'experience'
    assert heading_type('Skills & Tools') == 'skills'
    assert heading_type('I have many skills in Python and Go') is None
    lines = [
        'Lior Ashkenazi',
        'lior@mailbox.example | +44 7700 900123 | 12 Elm Road, Leeds',
        'Summary',
        'Engineer at Quarry Lane Software',
        'References',
        'Dana Whitfield, Head of Data',
    ]
    doc = LayoutDoc(
        (
            Page(
                595,
                842,
                tuple(Block(t, (40, 40 + 20 * n, 560, 55 + 20 * n)) for n, t in enumerate(lines)),
            ),
        ),
        'text',
    )
    seg = segment(doc)
    assert [s.type for s in seg.sections] == ['header', 'summary', 'other']
    assert header_name(seg)[0].start == 0
    from atlas_platform.pii import Detection

    ner = [
        Detection(seg.text.index('Leeds'), seg.text.index('Leeds') + 5, 'LOCATION', 0.85),
        Detection(seg.text.index('Quarry'), seg.text.index('Quarry') + 20, 'PERSON', 0.85),
        Detection(seg.text.index('Dana'), seg.text.index('Dana') + 14, 'PERSON', 0.85),
    ]
    red = redact(seg, ner, known=['lior ashkenazi'])
    assert 'Lior' not in red.text
    assert 'lior@' not in red.text
    assert '7700' not in red.text
    assert 'Leeds' not in red.text
    assert 'Quarry Lane Software' in red.text  # employers survive
    assert 'Dana Whitfield' not in red.text  # references do not
    assert red.contact == Contact('Lior Ashkenazi', 'lior@mailbox.example', '+44 7700 900123')
    assert red.sections[1].start == red.text.index('Summary')
    assert scrub({'a': ['x Lior Ashkenazi y']}, red.pii_map) == {'a': ['x <PERSON_1> y']}


def test_schema_normalisation_ignores_unknown_fields() -> None:
    resume = from_llm(
        {
            'summary': '  a  b ',
            'document_language': 'EN',
            'total_experience_months': 9999,
            'score': 5,
            'work_history': [
                {
                    'title': 'Eng',
                    'employer': 'X',
                    'start': '2020-13',
                    'end': '2021-02',
                    'is_current': True,
                    'skills_mentioned': ['Go', 7],
                    'evidence': 'Eng at X',
                    'rating': 10,
                }
            ],
            'education': [{'institution': 'U', 'end_year': 1800, 'evidence': 'U'}],
            'certifications': [{'certificate': 'CKA', 'evidence': 'CKA'}],
            'skills': [
                {'raw': 'Go', 'evidence': 'Go'},
                {'raw': 'go', 'evidence': 'go'},
                {'raw': ''},
            ],
            'languages': [{'language': 'English'}, 'junk'],
        }
    )
    assert (resume.summary, resume.language, resume.total_experience_months) == ('a b', 'en', None)
    role = resume.items[0].data
    assert (role['start'], role['end'], role['skills_mentioned']) == (None, None, ['Go'])
    assert 'rating' not in role
    assert [i.kind for i in resume.items].count('skills') == 1
    assert resume.items[1].data['end_year'] is None


def test_evidence_verification() -> None:
    source = 'Experience\nData Engineer - Northwind Systems\nBuilt pipelines with Python and Go\nSkills\nPython, SQL\n'
    assert locate('data engineer - northwind systems', source) is not None
    assert locate('Data  Engineer -\nNorthwind Systemz', source) is not None  # fuzzy ≥ 0.85
    assert locate('Chief Executive of Everything Inc', source) is None
    assert supported('Go', 'with Python and Go')
    assert not supported('Go', 'Google Cloud')
    resume = from_llm(
        {
            'work_history': [
                {
                    'title': 'Data Engineer',
                    'employer': 'Northwind Systems',
                    'evidence': 'Data Engineer - Northwind Systems',
                    'skills_mentioned': ['Python', 'Rust'],
                }
            ],
            'skills': [
                {'raw': 'Python', 'evidence': 'Python, SQL'},
                {'raw': 'Haskell', 'evidence': 'Python, SQL'},
                {'raw': 'Rust', 'evidence': 'Rust wizard for 20 years'},
            ],
        }
    )
    verified = verify(resume, source)
    assert [d['raw'] for d, _ in verified.items['skills']] == ['Python']
    assert verified.items['work_history'][0][0]['skills_mentioned'] == ['Python']
    assert len(verified.dropped) == 3


def test_proficiency_formula() -> None:
    today = date(2026, 11, 5)
    assert recency('2026-06', today) == 1.0
    assert recency('2023-11', today) == pytest.approx(1 - 24 / 48)
    assert recency('2020-01', today) == 0.0
    assert recency(None, today) == 0.0
    best = SkillFacts(years_used=40, last_used='2026-10', roles=3, certified=True, evidence_spans=5)
    assert proficiency(best, today) == 3.5  # the ceiling: a résumé alone cannot prove expertise
    strong = SkillFacts(
        years_used=12, last_used='2026-10', roles=3, certified=True, evidence_spans=5
    )
    assert proficiency(strong, today) == 3.49
    plain = SkillFacts(
        years_used=4, last_used='2026-10', roles=1, certified=False, evidence_spans=1
    )
    assert proficiency(plain, today) == round(1.0 + 1.2 * 0.7615941559557649 + 0.6, 2)
    assert confidence(plain, stuffed=False) == 0.45
    assert confidence(best, stuffed=False) == 0.6
    assert confidence(best, stuffed=True) == 0.2
    assert is_stuffed(100, 30, 10, 0)
    assert not is_stuffed(1000, 30, 10, 0)
    assert is_stuffed(5000, 40, 30, 25)
    assert not is_stuffed(5000, 40, 30, 5)


def test_chunks() -> None:
    profile = {
        'summary': 'S',
        'work_history': [
            {'title': 'T', 'employer': 'E', 'responsibilities': ['r'], 'skills_mentioned': ['Go']}
        ],
        'projects': [{'title': 'P', 'description': 'D'}],
    }
    chunks = build_chunks(profile, ['Go', 'Go', 'SQL'])
    assert [(c.chunk_type, c.chunk_index) for c in chunks] == [
        ('profile_summary', 0),
        ('experience', 0),
        ('projects', 0),
        ('skills', 0),
    ]
    assert chunks[1].content == 'T at E\nr\nSkills: Go'
    assert chunks[3].content == 'Go, SQL'
    assert build_chunks({}, []) == []


# --- adapters ---------------------------------------------------------------------------------------


class Tokens:
    async def token(self) -> str:
        return 'tok'


def mock(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_gateway_client() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == '/v1/prompts':
            return httpx.Response(201, json={'prompt': 'resume.extract@1'})
        if request.url.path == '/v1/embeddings':
            body = httpx.Request('POST', '/', content=request.content).read()
            n = len(__import__('json').loads(body)['input'])
            return httpx.Response(
                200,
                json={
                    'model': 'bge-m3',
                    'data': [{'index': i, 'embedding': [float(i)]} for i in range(n)][::-1],
                },
            )
        return httpx.Response(
            200,
            json={
                'output': {'summary': 'x'},
                'model': 'claude-sonnet-5-5',
                'injection_scores': {'resume': 0.7},
            },
        )

    gateway = GatewayClient('http://gw/', Tokens(), http=mock(handler))
    await gateway.register_prompt()
    registered = __import__('json').loads(seen[0].content)
    assert registered['contains_candidate_text'] is True
    assert registered['reidentify_fields'] == []
    assert '{{locale}}' in registered['system_template']
    assert registered['output_schema']['additionalProperties'] is False
    result = await gateway.extract('t', 'text', ['a', 'Real Name'])
    assert (result.injection_score, result.data) == (0.7, {'summary': 'x'})
    assert __import__('json').loads(seen[1].content)['known_pii'] == ['Real Name']
    assert seen[1].headers['authorization'] == 'Bearer tok'
    vectors = await gateway.embed('t', [f'c{i}' for i in range(70)], 'bge-m3')  # two batches
    assert len(vectors) == 70
    assert vectors[1] == [1.0]
    with pytest.raises(UpstreamError, match='not other'):
        await gateway.embed('t', ['x'], 'other')


@pytest.mark.parametrize(
    ('status', 'error'),
    [(503, UpstreamError), (429, UpstreamError), (422, PipelineError), (400, PipelineError)],
)
async def test_gateway_errors(status: int, error: type[Exception]) -> None:
    gateway = GatewayClient(
        'http://gw', Tokens(), http=mock(lambda r: httpx.Response(status, json={'code': 'X'}))
    )
    with pytest.raises(error):
        await gateway.extract('t', 'text', [])


async def test_network_failure_is_retryable() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError('down')

    with pytest.raises(UpstreamError):
        await TaxonomyClient('http://tax', Tokens(), http=mock(boom)).normalize('t', ['Go'])


async def test_taxonomy_and_profile_clients() -> None:
    def tax(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                'results': [{'term': 'Go', 'skill_id': 's1', 'confidence': 1, 'method': 'alias'}]
            },
        )

    taxonomy = TaxonomyClient('http://tax', Tokens(), http=mock(tax))
    assert (await taxonomy.normalize('t', ['Go']))[0].skill_id == 's1'
    assert await taxonomy.normalize('t', []) == []

    calls: list[tuple[str, str, dict[str, str]]] = []

    def prof(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, dict(request.headers)))
        path = request.url.path
        if request.method == 'GET' and path.startswith('/v1/documents/'):
            if path.endswith('missing'):
                return httpx.Response(404, json={'code': 'NOT_FOUND'})
            return httpx.Response(
                200,
                json={
                    'document_id': 'd',
                    'candidate_id': 'c',
                    'mime_type': 'application/pdf',
                    'byte_size': 5,
                    'parse_status': 'parsed',
                },
            )
        if request.method == 'GET':
            return httpx.Response(
                200, headers={'ETag': '"3"'}, json={'pii': {'full_name': 'A B', 'email': None}}
            )
        if request.method == 'PATCH':
            taken = b'taken@' in request.content
            return (
                httpx.Response(409, json={'code': 'CANDIDATE_EMAIL_TAKEN'})
                if taken
                else httpx.Response(200, json={})
            )
        if path == '/v1/candidates':
            return httpx.Response(201, json={'candidate_id': 'c9'})
        if path == '/v1/documents:initiateUpload':
            if b'"dupe"' in request.content:
                return httpx.Response(409, json={'code': 'DOCUMENT_DUPLICATE', 'document_id': 'd0'})
            return httpx.Response(
                201,
                json={
                    'document_id': 'd1',
                    'upload_url': 'http://s3/put',
                    'upload_headers': {'x-amz-checksum-sha256': 'abc'},
                },
            )
        return httpx.Response(200)

    profile = ProfileClient('http://prof', Tokens(), http=mock(prof))
    assert (await profile.get_document('t', 'd')).parse_status == 'parsed'  # type: ignore[union-attr]
    assert await profile.get_document('t', 'missing') is None
    assert await profile.create_candidate('t', 'Imported', 'bulk:1:0', 'bulk:1:0:candidate') == 'c9'
    target = await profile.initiate_upload('t', 'c9', 'application/pdf', 5, 'f' * 64)
    await profile.upload(target, b'bytes')
    assert calls[-1][2]['x-amz-checksum-sha256'] == 'abc'
    with pytest.raises(DuplicateDocumentError):
        await profile.initiate_upload('t', 'c9', 'application/pdf', 5, 'dupe')
    assert await profile.get_contact('t', 'c9') == Contact('A B', None, None)
    await profile.update_contact('t', 'c9', Contact('A B', 'ok@x.example', None))
    assert calls[-1][2]['if-match'] == '"3"'
    with pytest.raises(EmailTakenError):
        await profile.update_contact('t', 'c9', Contact('A B', 'taken@x.example', None))


async def test_clamd_instream_protocol() -> None:
    received = bytearray()

    async def clamd(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        assert await reader.readexactly(10) == b'zINSTREAM\0'
        data = bytearray()
        while True:
            size = struct.unpack('>I', await reader.readexactly(4))[0]
            if size == 0:
                break
            data += await reader.readexactly(size)
        received[:] = data
        writer.write(b'stream: Eicar-Signature FOUND\0' if EICAR in data else b'stream: OK\0')
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(clamd, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        scanner = ClamdScanner('127.0.0.1', port, chunk=7)
        assert await scanner.scan(b'clean resume text') is None
        assert bytes(received) == b'clean resume text'
        assert await scanner.scan(b'x' + EICAR) == 'Eicar-Signature'
    with pytest.raises(UpstreamError):
        await ClamdScanner('127.0.0.1', port, timeout=1).scan(b'x')  # server closed: fail closed
    assert await SignatureScanner().scan(EICAR) == 'Eicar-Test-Signature'


def test_config() -> None:
    env = {
        'ATLAS_PARSE_DATABASE_URL': 'postgresql://x',
        'ATLAS_PARSE_JWT_ISSUER': 'https://id',
        'ATLAS_PARSE_GATEWAY_URL': 'http://gw',
        'ATLAS_PARSE_TAXONOMY_URL': 'http://tax',
        'ATLAS_PARSE_PROFILE_URL': 'http://prof',
        'ATLAS_PARSE_TOKEN_URL': 'http://id/token',
        'ATLAS_PARSE_CLIENT_ID': 'svc_parsing',
        'ATLAS_PARSE_CLIENT_SECRET': 's',
    }
    assert Config.from_env(env).runner == 'inline'
    with pytest.raises(ValueError, match='Production requires'):
        Config.from_env({**env, 'ATLAS_ENV': 'production'})
    with pytest.raises(ValueError, match='S3_BUCKET'):
        Config.from_env({**env, 'ATLAS_PARSE_STORAGE': 's3'})
    with pytest.raises(ValueError, match='GATEWAY_URL'):
        Config.from_env({k: v for k, v in env.items() if k != 'ATLAS_PARSE_GATEWAY_URL'})
    production = Config.from_env(
        {
            **env,
            'ATLAS_ENV': 'production',
            'ATLAS_PARSE_CLAMD_HOST': 'clamd',
            'ATLAS_PARSE_STORAGE': 's3',
            'ATLAS_PARSE_S3_BUCKET': 'b',
            'ATLAS_PARSE_RUNNER': 'temporal',
            'ATLAS_PARSE_TEMPORAL_PAYLOAD_KEY': 'k',
        }
    )
    assert production.runner == 'temporal'


async def test_s3_storage_against_a_stubbed_client() -> None:
    from botocore.stub import Stubber

    from parsing_svc.infrastructure.storage import S3Storage

    storage = S3Storage('resumes', region='eu-west-1', endpoint_url='http://minio:9000')
    stub = Stubber(storage._s3)
    stub.add_response(
        'get_object', {'Body': __import__('io').BytesIO(b'pdf')}, {'Bucket': 'resumes', 'Key': 'k'}
    )
    stub.add_client_error(
        'get_object', 'NoSuchKey', expected_params={'Bucket': 'resumes', 'Key': 'gone'}
    )
    stub.add_client_error(
        'get_object',
        'SlowDown',
        http_status_code=503,
        expected_params={'Bucket': 'resumes', 'Key': 'busy'},
    )
    stub.add_response(
        'put_object',
        {},
        {'Bucket': 'resumes', 'Key': 'k', 'Body': b'x', 'ContentType': 'text/plain'},
    )
    stub.add_response(
        'copy_object',
        {},
        {
            'Bucket': 'resumes',
            'Key': 'quarantine/k',
            'CopySource': {'Bucket': 'resumes', 'Key': 'k'},
        },
    )
    stub.add_response('delete_object', {}, {'Bucket': 'resumes', 'Key': 'k'})
    stub.add_client_error('copy_object', 'NoSuchKey')
    with stub:
        assert await storage.get('k') == b'pdf'
        with pytest.raises(FileNotFoundError):
            await storage.get('gone')
        with pytest.raises(UpstreamError):
            await storage.get('busy')
        await storage.put('k', b'x', 'text/plain')
        await storage.move('k', 'quarantine/k')
        with pytest.raises(FileNotFoundError):
            await storage.move('k', 'quarantine/k')


def test_pdfplumber_fallback_and_docx_styles() -> None:
    import io

    import docx
    import pymupdf
    from docx.shared import Pt, RGBColor

    from parsing_svc.infrastructure.extract import DocumentExtractor, _pdf_plumber

    pdf = pymupdf.open()
    pdf.new_page().insert_text((40, 60), 'Experience at Northwind Systems')
    layout = _pdf_plumber(pdf.tobytes())
    assert 'Northwind' in layout.pages[0].blocks[0].text
    with pytest.raises(PipelineError):
        _pdf_plumber(b'not a pdf')

    document = docx.Document()
    run = document.add_paragraph().add_run('hidden keywords')
    run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    run.font.size = Pt(10)
    document.add_paragraph('Visible line')
    out = io.BytesIO()
    document.save(out)
    extracted = DocumentExtractor().extract(DOCX, out.getvalue())
    hidden, visible = extracted.pages[0].blocks
    assert hidden.color == 0xFFFFFF
    assert visible.text == 'Visible line'
    with pytest.raises(PipelineError):
        DocumentExtractor().extract('image/png', b'x')


def test_composition_root_builds() -> None:
    from parsing_svc.main import build

    built = build(
        Config.from_env(
            {
                'ATLAS_PARSE_DATABASE_URL': 'postgresql://localhost/none',
                'ATLAS_PARSE_JWT_ISSUER': 'https://id',
                'ATLAS_PARSE_JWT_SECRET': 'x' * 40,
                'ATLAS_PARSE_GATEWAY_URL': 'http://gw',
                'ATLAS_PARSE_TAXONOMY_URL': 'http://tax',
                'ATLAS_PARSE_PROFILE_URL': 'http://prof',
                'ATLAS_PARSE_TOKEN_URL': 'http://id/token',
                'ATLAS_PARSE_CLIENT_ID': 'svc_parsing',
                'ATLAS_PARSE_CLIENT_SECRET': 's',
                'ATLAS_PARSE_CLAMD_HOST': 'clamd',
            }
        )
    )
    assert built.pipeline.d.scanner.name == 'clamav'
    assert built.pipeline.d.ocr is None
    assert built.jobs.parser_version == 'v3.0.0'


def test_docx_archive_limits_each_on_their_own() -> None:
    import io
    import zipfile

    from parsing_svc.domain.sniff import inspect_docx

    def docx(entries: dict[str, bytes]) -> bytes:
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('[Content_Types].xml', '<Types/>')
            z.writestr('word/document.xml', '<w:document/>')
            for name, data in entries.items():
                z.writestr(name, data)
        return out.getvalue()

    # 60 entries of 0.9 MB: no single entry trips the ratio rule, the total does.
    with pytest.raises(PipelineError, match='Uncompressed size') as total:
        inspect_docx(docx({f'word/media/{n}.bin': b'\0' * 900_000 for n in range(60)}))
    assert total.value.quarantine == 'zip_bomb'
    with pytest.raises(PipelineError, match='archive entries') as entries:
        inspect_docx(docx({f'word/x{n}.xml': b'' for n in range(2001)}))
    assert entries.value.quarantine == 'zip_bomb'
    assert inspect_docx(docx({'word/styles.xml': b'<s/>'})).entries == 3


def test_checked_in_openapi_is_current() -> None:
    from parsing_svc.openapi import OPENAPI_PATH, render

    assert OPENAPI_PATH.read_text() == render(), 'run: uv run python -m parsing_svc.openapi'

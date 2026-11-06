"""HTTP API: auth and tenancy, parse requests with Idempotency-Key, job status, SSE progress,
bulk import, vector search and the model-upgrade controls."""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from atlas_platform.auth import JwtVerifier
from atlas_platform.testing import TEST_AUDIENCE, TEST_ISSUER, TEST_JWT_SECRET, make_token

from parsing_svc.application.ports import DocumentInfo
from parsing_svc.http.app import Container, create_app
from tests.conftest import World, golden_file, vector


@pytest.fixture
async def client(world: World) -> AsyncIterator[httpx.AsyncClient]:
    started: list[tuple[str, str]] = []

    async def start_bulk(tenant: str, batch: str) -> None:
        started.append((tenant, batch))
        await world.bulk.run(tenant, batch)

    container = Container(
        jobs=world.jobs,
        bulk=world.bulk,
        index=world.index,
        verifier=JwtVerifier(
            issuer=TEST_ISSUER, audience=TEST_AUDIENCE, shared_secret=TEST_JWT_SECRET
        ),
        start_bulk=start_bulk,
        readiness=[world.db.ping],
        sse_interval=0.01,
    )
    app = create_app(container)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://parse'
    ) as c:
        yield c


def auth(**kwargs: Any) -> dict[str, str]:
    return {'Authorization': f'Bearer {make_token(**kwargs)}'}


def recruiter(world: World) -> dict[str, str]:
    return auth(roles=['recruiter'], tid=world.tenant, sub='user:rec')


async def a_document(world: World, ref: str = 'G15') -> str:
    data, mime = golden_file(ref)
    document, candidate = str(uuid.uuid4()), str(uuid.uuid4())
    await world.storage.put(f't/{world.tenant}/resumes/{document}', data, mime)
    world.profile.documents[document] = DocumentInfo(document, candidate, mime, len(data), 'parsed')
    world.llm.ref = ref
    return document


async def test_parse_request_lifecycle(client: httpx.AsyncClient, world: World) -> None:
    document = await a_document(world)
    headers = {**recruiter(world), 'Idempotency-Key': 'reparse-0001'}
    first = await client.post(f'/v1/resumes/{document}:parse', headers=headers)
    assert first.status_code == 202, first.text
    again = await client.post(f'/v1/resumes/{document}:parse', headers=headers)
    assert again.json()['job_id'] == first.json()['job_id']  # same key, same job
    other_key = await client.post(
        f'/v1/resumes/{document}:parse', headers={**headers, 'Idempotency-Key': 'reparse-0002'}
    )
    assert other_key.json()['job_id'] == first.json()['job_id']  # one live job per document

    job_id = first.json()['job_id']
    queued = await client.get(f'/v1/parse-jobs/{job_id}', headers=recruiter(world))
    assert queued.json()['status'] == 'queued'
    await world.dispatcher.tick()
    await world.runner.drain()

    events = await client.get(f'/v1/parse-jobs/{job_id}/events', headers=recruiter(world))
    assert events.headers['content-type'].startswith('text/event-stream')
    blocks = [b for b in events.text.strip().split('\n\n') if b]
    assert blocks[-1].startswith('event: done')
    assert '"succeeded"' in blocks[-1]
    done = await client.get(f'/v1/parse-jobs/{job_id}', headers=recruiter(world))
    assert done.json() == {
        **done.json(),
        'status': 'succeeded',
        'progress': 100,
        'origin': 'api',
        'error': None,
    }

    reused = await client.post(f'/v1/resumes/{uuid.uuid4()!s}:parse', headers=headers)
    assert reused.status_code == 404  # unknown document (checked before the key)


async def test_parse_request_rules(client: httpx.AsyncClient, world: World) -> None:
    document = await a_document(world)
    url = f'/v1/resumes/{document}:parse'
    assert (await client.post(url)).status_code == 401
    assert (
        await client.post(url, headers=recruiter(world))
    ).status_code == 400  # no Idempotency-Key
    key = {'Idempotency-Key': 'k-12345678'}
    candidate = await client.post(
        url, headers={**auth(roles=['candidate'], tid=world.tenant), **key}
    )
    assert candidate.status_code == 403
    mismatch = await client.post(
        f'{url}?tenant_id={uuid.uuid4()}', headers={**recruiter(world), **key}
    )
    assert mismatch.json()['code'] == 'TENANT_MISMATCH'
    staff = await client.post(url, headers={**auth(roles=['super_admin']), **key})
    assert staff.json()['code'] == 'TENANT_REQUIRED'
    service = await client.post(
        f'{url}?tenant_id={world.tenant}',
        headers={**auth(roles=['service'], scopes=['resumes:parse']), **key},
    )
    assert service.status_code == 202
    world.profile.documents[document] = DocumentInfo(
        document, str(uuid.uuid4()), 'application/pdf', 10, 'quarantined'
    )
    blocked = await client.post(url, headers={**recruiter(world), 'Idempotency-Key': 'k-87654321'})
    assert blocked.json()['code'] == 'DOCUMENT_NOT_PARSEABLE'
    missing = await client.get(f'/v1/parse-jobs/{uuid.uuid4()}', headers=recruiter(world))
    assert missing.status_code == 404
    assert (await client.get('/v1/parse-jobs/not-a-uuid', headers=recruiter(world))).json()[
        'code'
    ] == 'INVALID_ID'


async def test_bulk_import_endpoint(client: httpx.AsyncClient, world: World) -> None:
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr('a.pdf', golden_file('G16')[0])
        z.writestr('b.txt', golden_file('G18')[0])
    headers = {**recruiter(world), 'Content-Type': 'application/zip'}
    accepted = await client.post('/v1/resumes:bulkImport', content=out.getvalue(), headers=headers)
    assert accepted.status_code == 202, accepted.text
    batch = await client.get(
        f'/v1/parse-batches/{accepted.json()["batch_id"]}', headers=recruiter(world)
    )
    assert batch.json()['items'] == {'submitted': 2}
    wrong_type = await client.post('/v1/resumes:bulkImport', content=b'x', headers=recruiter(world))
    assert wrong_type.json()['code'] == 'UNSUPPORTED_MEDIA_TYPE'
    reviewer = await client.post(
        '/v1/resumes:bulkImport',
        content=b'x',
        headers={**auth(roles=['reviewer'], tid=world.tenant), 'Content-Type': 'application/zip'},
    )
    assert reviewer.status_code == 403


async def test_search_and_model_controls(client: httpx.AsyncClient, world: World) -> None:
    world.llm.ref = 'G17'
    data, mime = golden_file('G17')
    job = await world.parse(data, mime)
    service = auth(roles=['service'], scopes=['embeddings:search'])
    body = {
        'tenant_id': world.tenant,
        'model_id': 'bge-m3',
        'vector': vector('Python Kafka'),
        'k': 5,
    }
    hits = await client.post('/v1/resume-embeddings:search', json=body, headers=service)
    assert hits.status_code == 200
    assert {h['candidate_id'] for h in hits.json()['results']} == {job.candidate_id}
    wrong = await client.post(
        '/v1/resume-embeddings:search', json={**body, 'model_id': 'other'}, headers=service
    )
    assert (wrong.status_code, wrong.json()['active_model']) == (409, 'bge-m3')
    no_scope = await client.post(
        '/v1/resume-embeddings:search', json=body, headers=auth(roles=['service'])
    )
    assert no_scope.status_code == 403
    bound = await client.post(
        '/v1/resume-embeddings:search',
        json=body,
        headers=auth(roles=['service'], scopes=['embeddings:search'], tid=str(uuid.uuid4())),
    )
    assert bound.json()['code'] == 'TENANT_MISMATCH'
    short = await client.post(
        '/v1/resume-embeddings:search', json={**body, 'vector': [0.1]}, headers=service
    )
    assert short.status_code == 400

    # Re-ranking: each named candidate's closest chunks, with their vectors.
    per = await client.post(
        '/v1/resume-embeddings:search',
        json={
            **body,
            'candidate_ids': [job.candidate_id, str(uuid.uuid4())],
            'per_candidate': 2,
            'include_vectors': True,
        },
        headers=service,
    )
    results = per.json()['results']
    assert len(results) == 2
    assert {r['candidate_id'] for r in results} == {job.candidate_id}
    assert all(len(r['embedding']) == 1024 for r in results)
    assert results[0]['score'] >= results[1]['score']
    assert 'embedding' not in hits.json()['results'][0]
    needs_ids = await client.post(
        '/v1/resume-embeddings:search', json={**body, 'per_candidate': 2}, headers=service
    )
    assert needs_ids.json()['code'] == 'CANDIDATES_REQUIRED'
    too_many = await client.post(
        '/v1/resume-embeddings:search', json={**body, 'k': 900}, headers=service
    )
    assert too_many.json()['code'] == 'K_TOO_LARGE'
    filtered = await client.post(
        '/v1/resume-embeddings:search',
        json={**body, 'candidate_ids': [str(uuid.uuid4())]},
        headers=service,
    )
    assert filtered.json()['results'] == []

    assert (await client.get('/v1/embedding-models', headers=service)).json() == {
        'active': 'bge-m3',
        'shadow': None,
    }
    assert (await client.get('/v1/embedding-models', headers=recruiter(world))).status_code == 403
    staff = auth(roles=['super_admin'], sub='staff:ana')
    assert (
        await client.put(
            '/v1/embedding-models/shadow', json={'model_id': 'x'}, headers=recruiter(world)
        )
    ).status_code == 403
    try:
        assert (
            await client.put(
                '/v1/embedding-models/shadow', json={'model_id': 'bge-m3-v2'}, headers=staff
            )
        ).json()['shadow'] == 'bge-m3-v2'
        filled = await client.post(
            '/v1/embedding-models:backfill', json={'tenant_id': world.tenant}, headers=staff
        )
        assert filled.json()['remaining'] == 0
        assert (await client.post('/v1/embedding-models:promote', headers=staff)).json()[
            'active'
        ] == 'bge-m3-v2'
    finally:
        async with world.db.system_tx() as tx:
            await world.pipeline.d.slots.set(tx, 'active', 'bge-m3', 'test')
            await world.pipeline.d.slots.set(tx, 'shadow', None, 'test')


async def test_health_and_problems(client: httpx.AsyncClient) -> None:
    assert (await client.get('/healthz')).json() == {'status': 'ok'}
    assert (await client.get('/readyz')).json() == {'status': 'ready'}
    missing = await client.get('/v1/nowhere')
    assert missing.headers['content-type'] == 'application/problem+json'
    assert json.loads(missing.text)['code'] == 'ROUTE_NOT_FOUND'

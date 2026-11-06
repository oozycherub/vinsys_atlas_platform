"""The HTTP API and the text-mode WebSocket, through the ASGI app."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

import httpx
import jwt
import pytest
from httpx_ws import AsyncWebSocketSession, aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport

from interview_svc.application.ports import JobProfile, UpstreamError
from interview_svc.config import Config
from interview_svc.http.app import create_app
from interview_svc.openapi import OPENAPI_PATH, render
from interview_svc.prompts import PLANNER, SCORER
from tests.conftest import LIVEKIT_SECRET, SKILL_A, SKILL_B, Harness, plan_doc, token


@pytest.fixture
async def client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(harness.container())
    harness.app = app  # type: ignore[attr-defined]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url='http://interview.test'
    ) as c:
        yield c


@asynccontextmanager
async def ws_client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    """WebSockets need httpx-ws's transport, entered and left in the test's own task."""
    app = harness.app  # type: ignore[attr-defined]
    async with httpx.AsyncClient(
        transport=ASGIWebSocketTransport(app), base_url='http://interview.test'
    ) as c:
        yield c


def connect(url: str, c: httpx.AsyncClient) -> AbstractAsyncContextManager[AsyncWebSocketSession]:
    return aconnect_ws(url, c)


def staff(tenant: str, *roles: str) -> dict[str, str]:
    return {'Authorization': f'Bearer {token(list(roles) or ["recruiter"], tenant)}'}


def service(scopes: list[str] | None = None) -> dict[str, str]:
    return {
        'Authorization': f'Bearer {token(["service"], None, scopes or ["interviews:sessions"], "svc:assessment")}'
    }


def session_body(tenant: str, **overrides: str) -> dict[str, str]:
    return {
        'tenant_id': tenant,
        'assessment_id': str(uuid.uuid4()),
        'assessment_session_id': str(uuid.uuid4()),
        'question_id': str(uuid.uuid4()),
        'candidate_id': str(uuid.uuid4()),
        **overrides,
    }


async def test_health(client: httpx.AsyncClient) -> None:
    assert (await client.get('/healthz')).json() == {'status': 'ok'}
    assert (await client.get('/readyz')).status_code == 200


async def test_not_ready_when_a_dependency_fails(harness: Harness) -> None:
    async def broken() -> None:
        raise RuntimeError('down')

    container = harness.container()
    container.readiness.append(broken)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(create_app(container)), base_url='http://t'
    ) as c:
        res = await c.get('/readyz')
    assert (res.status_code, res.json()['code']) == (503, 'NOT_READY')


async def test_interview_lifecycle(
    client: httpx.AsyncClient, harness: Harness, tenant: str
) -> None:
    h = harness
    profile_id = str(uuid.uuid4())
    h.taxonomy.profiles[profile_id] = JobProfile(
        profile_id,
        'Finance analyst',
        'Working capital and client advice.',
        [
            {'skill_id': SKILL_A, 'name': 'Cash-flow analysis', 'weight': 0.9, 'must_have': True},
            {'skill_id': SKILL_B, 'name': 'Communication', 'weight': 0.6, 'must_have': False},
        ],
    )
    assert (
        await client.post('/v1/interviews', json={'job_profile_id': profile_id, 'mode': 'voice'})
    ).status_code == 401
    created = await client.post(
        '/v1/interviews',
        json={'job_profile_id': profile_id, 'mode': 'voice', 'title': 'Analyst screen'},
        headers=staff(tenant),
    )
    assert created.status_code == 201, created.text
    view = created.json()
    assert (view['status'], view['plan']['source'], view['plan']['status']) == (
        'draft',
        'generated',
        'draft',
    )
    planner = h.llm.called(PLANNER)[0]
    assert '"weight": 0.6' in planner['skills']  # 0.9 / 1.5
    assert planner['job_title'] == 'Finance analyst'
    iid = view['interview_id']
    # Sessions need a published plan.
    early = await client.post(
        f'/v1/interviews/{iid}/sessions', json=session_body(tenant), headers=service()
    )
    assert (early.status_code, early.json()['code']) == (409, 'INTERVIEW_NOT_PUBLISHED')
    edited = plan_doc(max_minutes=15)
    put = await client.put(
        f'/v1/interviews/{iid}/plan', json={'plan': edited}, headers=staff(tenant)
    )
    assert put.json()['plan'] == {
        'version': 1,
        'status': 'draft',
        'source': 'recruiter',
        'plan': edited,
    }
    bad = await client.put(
        f'/v1/interviews/{iid}/plan',
        json={'plan': plan_doc(max_minutes=3)},
        headers=staff(tenant),
    )
    assert (bad.status_code, bad.json()['code']) == (400, 'INVALID_PLAN')
    published = await client.post(f'/v1/interviews/{iid}:publish', headers=staff(tenant))
    assert (published.json()['status'], published.json()['published_version']) == ('published', 1)
    again = await client.post(f'/v1/interviews/{iid}:publish', headers=staff(tenant))
    assert again.json()['code'] == 'NOTHING_TO_PUBLISH'
    # Published plans are frozen: an edit starts version 2; the database refuses changes to v1.
    v2 = await client.put(
        f'/v1/interviews/{iid}/plan', json={'plan': plan_doc(max_minutes=25)}, headers=staff(tenant)
    )
    assert [v['status'] for v in v2.json()['versions']] == ['draft', 'published']
    with pytest.raises(Exception, match='frozen'):
        async with h.db.tenant_tx(tenant) as tx:
            await tx.execute(
                "UPDATE interview_plans SET plan = '{}'::jsonb WHERE interview_id = %s AND version = 1",
                (iid,),
            )
    await client.post(f'/v1/interviews/{iid}:publish', headers=staff(tenant))
    got = await client.get(f'/v1/interviews/{iid}', headers=staff(tenant, 'reviewer'))
    assert [v['status'] for v in got.json()['versions']] == ['published', 'superseded']
    # Tenancy and roles.
    other = str(uuid.uuid4())
    assert (await client.get(f'/v1/interviews/{iid}', headers=staff(other))).status_code == 404
    assert (
        await client.get(f'/v1/interviews/{iid}', headers=staff(tenant, 'candidate'))
    ).status_code == 403
    assert (
        await client.post(f'/v1/interviews/{iid}:publish', headers=staff(tenant, 'reviewer'))
    ).status_code == 403
    admin = {'Authorization': f'Bearer {token(["super_admin"])}'}
    assert (await client.get(f'/v1/interviews/{iid}', headers=admin)).json()[
        'code'
    ] == 'TENANT_REQUIRED'
    assert (
        await client.get(f'/v1/interviews/{iid}?tenant_id={tenant}', headers=admin)
    ).status_code == 200
    mismatch = await client.get(f'/v1/interviews/{iid}?tenant_id={other}', headers=staff(tenant))
    assert mismatch.json()['code'] == 'TENANT_MISMATCH'
    assert (
        await client.get(f'/v1/interviews/{uuid.uuid4()}', headers=staff(tenant))
    ).status_code == 404


async def test_plan_generation_failures(
    client: httpx.AsyncClient, harness: Harness, tenant: str
) -> None:
    h = harness
    missing = await client.post(
        '/v1/interviews',
        json={'job_profile_id': str(uuid.uuid4()), 'mode': 'text'},
        headers=staff(tenant),
    )
    assert missing.json()['code'] == 'JOB_PROFILE_NOT_FOUND'
    pid = str(uuid.uuid4())
    h.taxonomy.profiles[pid] = JobProfile(pid, 'Empty', '', [])
    empty = await client.post(
        '/v1/interviews', json={'job_profile_id': pid, 'mode': 'text'}, headers=staff(tenant)
    )
    assert (empty.status_code, empty.json()['code']) == (422, 'JOB_PROFILE_WITHOUT_SKILLS')
    h.taxonomy.profiles[pid] = JobProfile(
        pid, 'X', '', [{'skill_id': SKILL_A, 'name': 'A', 'weight': 1.0}]
    )
    h.llm.scripts[PLANNER] = lambda v: plan_doc(competencies=[])
    broken = await client.post(
        '/v1/interviews', json={'job_profile_id': pid, 'mode': 'text'}, headers=staff(tenant)
    )
    assert (broken.status_code, broken.json()['code']) == (502, 'PLAN_GENERATION_FAILED')
    thresholds = await client.post(
        '/v1/interviews',
        json={
            'job_profile_id': pid,
            'mode': 'text',
            'plan': plan_doc(),
            'thresholds': {'advance': 2, 'hold': 3},
        },
        headers=staff(tenant),
    )
    assert thresholds.json()['code'] == 'INVALID_THRESHOLDS'


async def test_sessions_join_and_transcript(
    client: httpx.AsyncClient, harness: Harness, tenant: str, postgres_uri: str
) -> None:
    h = harness
    iid = await h.published(tenant, mode='voice')
    body = session_body(tenant)
    assert (
        await client.post(f'/v1/interviews/{iid}/sessions', json=body, headers=staff(tenant))
    ).status_code == 403
    wrong_tenant = {
        'Authorization': f'Bearer {token(["service"], str(uuid.uuid4()), ["interviews:sessions"])}'
    }
    assert (
        await client.post(f'/v1/interviews/{iid}/sessions', json=body, headers=wrong_tenant)
    ).status_code == 403
    first = await client.post(f'/v1/interviews/{iid}/sessions', json=body, headers=service())
    assert first.status_code == 201, first.text
    s = first.json()
    assert s['interview_token'].startswith('ivt_')
    assert s['mode'] == 'voice'
    # Idempotent per (assessment session, question): same session, new token.
    second = (
        await client.post(f'/v1/interviews/{iid}/sessions', json=body, headers=service())
    ).json()
    assert second['session_id'] == s['session_id']
    assert second['interview_token'] != s['interview_token']
    clash = await client.post(
        f'/v1/interviews/{iid}/sessions',
        json={**body, 'candidate_id': str(uuid.uuid4())},
        headers=service(),
    )
    assert clash.json()['code'] == 'SESSION_MISMATCH'
    sid = s['session_id']
    old = await client.post(
        f'/v1/interview-sessions/{sid}:join',
        headers={'Authorization': f'Interview {s["interview_token"]}'},
    )
    assert old.status_code == 401  # superseded by the new token
    joined = await client.post(
        f'/v1/interview-sessions/{sid}:join',
        headers={'Authorization': f'Interview {second["interview_token"]}'},
    )
    assert joined.status_code == 200, joined.text
    j = joined.json()
    assert j['ws_url'] == f'wss://api.atlas.test/v1/interviews/{sid}/ws'
    assert (j['resume_cursor'], j['livekit_url']) == (0, 'wss://rtc.atlas.test')
    claims = jwt.decode(j['livekit_token'], LIVEKIT_SECRET, algorithms=['HS256'])
    assert claims['video']['room'] == f'iv_{sid}'
    assert claims['video']['canPublishSources'] == ['microphone']
    assert claims['exp'] - claims['nbf'] <= 605
    assert claims['iss'] == 'lk-key'
    import psycopg

    with psycopg.connect(postgres_uri) as conn:  # the KEDA scaler's role
        conn.execute('SET ROLE atlas_metrics')
        row = conn.execute('SELECT interview_pending_sessions()').fetchone()
    assert row is not None
    assert row[0] >= 1
    async with h.db.system_tx() as tx:
        with pytest.raises(Exception, match='permission denied'):
            await tx.fetch('SELECT interview_pending_sessions()')  # not for the app role
    for header in ({}, {'Authorization': 'Interview nope'}, {'Authorization': 'Interview ivt_x'}):
        assert (
            await client.post(f'/v1/interview-sessions/{sid}:join', headers=header)
        ).status_code == 401
    # Transcript: the candidate's own (interview token) or staff of the tenant.
    mine = await client.get(
        f'/v1/interview-sessions/{sid}/transcript',
        headers={'Authorization': f'Interview {second["interview_token"]}'},
    )
    assert mine.json() == {'session_id': sid, 'status': 'created', 'turns': []}
    assert (
        await client.get(f'/v1/interview-sessions/{sid}/transcript', headers=staff(tenant))
    ).status_code == 200
    assert (
        await client.get(
            f'/v1/interview-sessions/{sid}/transcript', headers=staff(tenant, 'employee')
        )
    ).status_code == 403
    assert (
        await client.get(f'/v1/interview-sessions/{uuid.uuid4()}/transcript', headers=staff(tenant))
    ).status_code == 404
    assert (
        await client.get(f'/v1/interview-sessions/{sid}/evaluation', headers=staff(tenant))
    ).json()['code'] == 'EVALUATION_NOT_READY'
    h.tenants.fail = True
    down = await client.post(
        f'/v1/interviews/{iid}/sessions', json=session_body(tenant), headers=service()
    )
    assert (down.status_code, down.json()['code']) == (503, 'UPSTREAM_UNAVAILABLE')


async def test_text_mode_over_websocket(
    client: httpx.AsyncClient, harness: Harness, tenant: str
) -> None:
    async with ws_client(harness) as wsc:
        await _text_mode(client, wsc, harness, tenant)


async def _text_mode(
    client: httpx.AsyncClient, wsc: httpx.AsyncClient, harness: Harness, tenant: str
) -> None:
    h = harness
    iid = await h.published(tenant)
    s, tok = await h.session(tenant, iid)
    url = f'/v1/interviews/{s.session_id}/ws'
    async with connect(url, wsc) as ws:
        await ws.send_json({'type': 'auth', 'token': 'ivt_wrong'})
        assert (await ws.receive_json())['code'] == 'INVALID_INTERVIEW_TOKEN'
    async with connect(url, wsc) as ws:
        await ws.send_json({'type': 'hello'})
        assert (await ws.receive_json())['code'] == 'INVALID_INTERVIEW_TOKEN'
    received: list[dict[str, Any]] = []

    async def until(ws: Any, kind: str) -> dict[str, Any]:
        while True:
            msg: dict[str, Any] = await ws.receive_json()
            received.append(msg)
            if msg['type'] == kind:
                return msg

    async with connect(url, wsc) as ws:
        await ws.send_json({'type': 'auth', 'token': tok})
        assert (await ws.receive_json()) == {'type': 'ready', 'status': 'created'}
        consent = await until(ws, 'utterance')
        assert consent['kind'] == 'consent'
        # A second connection cannot take the session while this one holds it.
        async with connect(url, wsc) as other:
            await other.send_json({'type': 'auth', 'token': tok})
            assert (await other.receive_json())['code'] == 'INTERVIEW_IN_USE'
        await ws.send_json({'type': 'consent', 'accepted': True})
        question = await until(ws, 'utterance')
        while question['kind'] != 'question':
            question = await until(ws, 'utterance')
        await ws.send_json({'type': 'message', 'text': ''})
        assert (await until(ws, 'error'))['code'] == 'INVALID_MESSAGE'
        for text in (
            'I start with the cash conversion cycle: receivables, inventory and payables days.',
            'I build a thirteen week cash model with three scenarios and review it monthly.',
            'I told the client the covenant risk plainly and agreed a plan with them.',
        ):
            await ws.send_json({'type': 'message', 'text': text})
            await until(ws, 'utterance')
        ended = await until(ws, 'ended')
        assert ended == {'type': 'ended', 'outcome': 'completed'}  # no evaluation for the candidate
    await h.settle()
    assert 'phase' in {m['type'] for m in received}
    res = await client.get(
        f'/v1/interview-sessions/{s.session_id}/evaluation', headers=staff(tenant, 'reviewer')
    )
    assert res.json()['recommendation'] == 'advance'
    # The session's lease was released, and it has ended.
    async with connect(url, wsc) as ws:
        await ws.send_json({'type': 'auth', 'token': tok})
        assert (await ws.receive_json())['code'] == 'INTERVIEW_IN_USE'


async def test_text_mode_ends_politely_when_the_scorer_is_down(
    client: httpx.AsyncClient, harness: Harness, tenant: str
) -> None:
    h = harness

    def down(v: dict[str, str]) -> dict[str, Any]:
        raise UpstreamError('llm-gateway unavailable')

    h.llm.scripts[SCORER] = down
    s, tok = await h.session(tenant, await h.published(tenant))
    async with ws_client(h) as wsc, connect(f'/v1/interviews/{s.session_id}/ws', wsc) as ws:
        await ws.send_json({'type': 'auth', 'token': tok})
        await ws.send_json({'type': 'consent', 'accepted': True})
        for text in (
            'I start with the cash conversion cycle: receivables, inventory and payables days.',
            'I build a thirteen week cash model with three scenarios and review it monthly.',
            'I told the client the covenant risk plainly and agreed a plan with them.',
        ):
            await ws.send_json({'type': 'message', 'text': text})
        seen: list[dict[str, Any]] = []
        while not seen or seen[-1]['type'] != 'ended':
            seen.append(await ws.receive_json())
    assert {'type': 'error', 'code': 'UPSTREAM_UNAVAILABLE'} in seen
    assert seen[-1] == {'type': 'ended', 'outcome': 'completed'}
    async with h.db.tenant_tx(tenant) as tx:
        row = await h.store.session(tx, s.session_id)
    assert row is not None
    assert row.status == 'scoring'  # maintenance scores it once the gateway is back


async def test_a_dropped_websocket_pauses_the_interview(
    client: httpx.AsyncClient, harness: Harness, tenant: str
) -> None:
    async with ws_client(harness) as wsc:
        await _dropped(wsc, harness, tenant)


async def _dropped(client: httpx.AsyncClient, harness: Harness, tenant: str) -> None:
    h = harness
    s, tok = await h.session(tenant, await h.published(tenant))
    url = f'/v1/interviews/{s.session_id}/ws'
    async with connect(url, client) as ws:
        await ws.send_json({'type': 'auth', 'token': tok})
        await ws.receive_json()
        await ws.receive_json()
        await ws.send_json({'type': 'consent', 'accepted': True})
        while (await ws.receive_json()).get('kind') != 'question':
            pass
    for _ in range(50):
        async with h.db.tenant_tx(tenant) as tx:
            row = await h.store.session(tx, s.session_id)
        if row is not None and row.status == 'paused' and row.worker_id is None:
            break
        import asyncio

        await asyncio.sleep(0.05)
    assert row is not None
    assert row.status == 'paused'
    # Reconnecting resumes where the candidate left off.
    async with connect(url, client) as ws:
        await ws.send_json({'type': 'auth', 'token': tok})
        assert (await ws.receive_json())['status'] == 'paused'
        kinds = [(await ws.receive_json()).get('kind') for _ in range(3)]
        assert 'welcome_back' in kinds


async def test_evaluation_and_override(
    client: httpx.AsyncClient, harness: Harness, tenant: str
) -> None:
    h = harness
    from tests.conftest import RecordingSink
    from tests.test_runner import complete, start

    s, _ = await h.session(tenant, await h.published(tenant))
    runner = h.runner()
    sink = RecordingSink()
    s = await start(runner, s, sink)
    await complete(h, runner, s, sink)
    url = f'/v1/interview-sessions/{s.session_id}/evaluation'
    ev = (await client.get(url, headers=staff(tenant, 'hiring_manager'))).json()
    assert (ev['revision'], ev['recommendation'], ev['overrides']) == (1, 'advance', [])
    assert ev['competencies'][0]['evidence']
    bad = await client.post(f'{url}:override', json={'reason': 'x'}, headers=staff(tenant))
    assert bad.status_code == 400
    unknown = await client.post(
        f'{url}:override',
        json={'reason': 'Recalibrated', 'scores': {str(uuid.uuid4()): 3}},
        headers=staff(tenant),
    )
    assert unknown.json()['code'] == 'UNKNOWN_COMPETENCY'
    assert (
        await client.post(
            f'{url}:override', json={'reason': 'nope'}, headers=staff(tenant, 'reviewer')
        )
    ).status_code == 403
    done = await client.post(
        f'{url}:override',
        json={
            'reason': 'Panel disagreed on communication.',
            'recommendation': 'hold',
            'scores': {SKILL_B.upper(): 2},
        },
        headers=staff(tenant),
    )
    assert done.status_code == 200, done.text
    body = done.json()
    assert (body['revision'], body['recommendation'], body['approved_by']) == (2, 'hold', 'user-1')
    assert body['competencies'][1] | {'score': 2, 'status': 'overridden'} == body['competencies'][1]
    assert body['overrides'][0]['reason'] == 'Panel disagreed on communication.'
    events = await h.outbox(tenant, 'interview.session.completed.v1')
    assert (events[-1]['revision'], events[-1]['needs_review'], events[-1]['recommendation']) == (
        2,
        False,
        'hold',
    )
    async with h.db.tenant_tx(tenant) as tx:
        with pytest.raises(Exception, match='permission denied'):
            await tx.execute("UPDATE evaluation_overrides SET reason = 'edited'")


def test_openapi_is_current() -> None:
    assert OPENAPI_PATH.read_text() == render(), 'run: uv run python -m interview_svc.openapi'


BASE_ENV = {
    'ATLAS_INTERVIEW_DATABASE_URL': 'postgresql://x',
    'ATLAS_INTERVIEW_JWT_ISSUER': 'https://id',
    'ATLAS_INTERVIEW_GATEWAY_URL': 'http://gw',
    'ATLAS_INTERVIEW_TAXONOMY_URL': 'http://tx',
    'ATLAS_INTERVIEW_TENANT_URL': 'http://tn',
    'ATLAS_INTERVIEW_TOKEN_URL': 'http://id/token',
    'ATLAS_INTERVIEW_CLIENT_ID': 'interview-svc',
    'ATLAS_INTERVIEW_CLIENT_SECRET': 's',
    'ATLAS_INTERVIEW_LIVEKIT_URL': 'wss://rtc',
    'ATLAS_INTERVIEW_LIVEKIT_API_KEY': 'k',
    'ATLAS_INTERVIEW_LIVEKIT_API_SECRET': 'x' * 32,
    'ATLAS_INTERVIEW_WS_BASE_URL': 'ws://localhost',
}


def test_config() -> None:
    config = Config.from_env({**BASE_ENV, 'HOSTNAME': 'pod-1'})
    assert (config.worker_id, config.port, config.vad, config.calibration) == (
        'pod-1',
        8091,
        'silero',
        False,
    )
    with pytest.raises(ValueError, match='DATABASE_URL'):
        Config.from_env({k: v for k, v in BASE_ENV.items() if 'DATABASE' not in k})
    with pytest.raises(ValueError, match='VAD'):
        Config.from_env({**BASE_ENV, 'ATLAS_INTERVIEW_VAD': 'magic'})
    with pytest.raises(ValueError, match='LEASE'):
        Config.from_env({**BASE_ENV, 'ATLAS_INTERVIEW_LEASE_TTL_S': '5'})
    prod = {**BASE_ENV, 'ATLAS_ENV': 'production', 'ATLAS_INTERVIEW_JWKS_URL': 'https://id/jwks'}
    with pytest.raises(ValueError, match='Redis'):
        Config.from_env(prod)
    full = {
        **prod,
        'ATLAS_INTERVIEW_REDIS_URL': 'redis://r',
        'ATLAS_INTERVIEW_KAFKA_BROKERS': 'k:9092',
        'ATLAS_INTERVIEW_S3_BUCKET': 'b',
    }
    with pytest.raises(ValueError, match='wss'):
        Config.from_env(full)
    assert (
        Config.from_env({**full, 'ATLAS_INTERVIEW_WS_BASE_URL': 'wss://api'}).environment
        == 'production'
    )
    with pytest.raises(ValueError, match='JWKS'):
        Config.from_env({**full, 'ATLAS_INTERVIEW_JWT_SECRET': 's' * 32})


def test_livekit_secret_length() -> None:
    from interview_svc.infrastructure.livekit import LiveKitTokens

    with pytest.raises(ValueError, match='32'):
        LiveKitTokens('k', 'short', 'wss://x')
    agent = LiveKitTokens('k', 'x' * 32, 'wss://x').agent('iv_1', 'agent:w', 60)
    assert jwt.decode(agent, 'x' * 32, algorithms=['HS256'])['video']['agent'] is True

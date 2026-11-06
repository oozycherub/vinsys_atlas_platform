"""HTTP surface: auth, problem+json, SSE, tool sessions, embeddings, prompts, budgets, purge."""

from __future__ import annotations

import json
import math
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from atlas_platform.events import parse_outbox_record

from llm_gateway.application.ports import ProviderRequest, ProviderResponse, ToolCall
from llm_gateway.domain.redaction import TOKEN
from llm_gateway.http.app import create_app
from llm_gateway.infrastructure.consumer import handle_purged
from tests.conftest import Harness, container_for, make_template, token, user_text

PROMPT_BODY: dict[str, Any] = {
    'purpose': 'resume_extraction',
    'route': 'fast',
    'system_template': 'Summarise the résumé.',
    'user_template': '{{resume}}',
    'variables': {'resume': {'required': True, 'untrusted': True}},
    'contains_candidate_text': True,
    'reidentify_fields': [''],
    'max_tokens': 1024,
}


@pytest.fixture
async def client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(container_for(harness))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://gw') as c:
        yield c


def auth(**kwargs: Any) -> dict[str, str]:
    return {'Authorization': f'Bearer {token(**kwargs)}'}


async def register(client: httpx.AsyncClient, **overrides: Any) -> str:
    body = {**PROMPT_BODY, 'prompt_id': f'http.p-{uuid.uuid4().hex[:8]}', 'version': 1, **overrides}
    r = await client.post('/v1/prompts', json=body, headers=auth(scopes=['prompts:write']))
    assert r.status_code == 201, r.text
    return str(r.json()['prompt'])


# --- auth and errors ------------------------------------------------------------------------------


async def test_requires_a_valid_token(client: httpx.AsyncClient, harness: Harness) -> None:
    body = {'tenant_id': harness.tenant, 'purpose': 'resume_extraction', 'prompt': 'a.b-c@1'}
    r = await client.post('/v1/llm/messages', json=body)
    assert r.status_code == 401
    assert r.headers['content-type'] == 'application/problem+json'
    assert r.json()['code'] == 'UNAUTHENTICATED'
    assert r.json()['request_id'] == r.headers['x-request-id']

    expired = await client.post('/v1/llm/messages', json=body, headers=auth(exp_in=-120))
    assert expired.status_code == 401

    wrong_scope = await client.post(
        '/v1/llm/messages', json=body, headers=auth(scopes=['embeddings:create'])
    )
    assert wrong_scope.status_code == 403

    recruiter = await client.post(
        '/v1/llm/messages', json=body, headers=auth(roles=['recruiter'], scopes=['llm:invoke'])
    )
    assert recruiter.status_code == 403

    other_tenant = await client.post(
        '/v1/llm/messages', json=body, headers=auth(tid=str(uuid.uuid4()))
    )
    assert other_tenant.json()['code'] == 'TENANT_MISMATCH'


async def test_validation_and_unknown_prompt(client: httpx.AsyncClient, harness: Harness) -> None:
    bad = await client.post('/v1/llm/messages', json={'tenant_id': 'nope'}, headers=auth())
    assert bad.status_code == 400
    assert bad.json()['code'] == 'VALIDATION_FAILED'
    assert any(e['path'] == '/tenant_id' for e in bad.json()['errors'])

    body = {
        'tenant_id': harness.tenant,
        'purpose': 'resume_extraction',
        'prompt': 'missing.prompt@9',
    }
    missing = await client.post('/v1/llm/messages', json=body, headers=auth())
    assert missing.status_code == 404
    assert missing.json()['code'] == 'PROMPT_NOT_FOUND'

    ref = await register(client)
    wrong_purpose = await client.post(
        '/v1/llm/messages', json={**body, 'prompt': ref, 'purpose': 'job_matching'}, headers=auth()
    )
    assert wrong_purpose.status_code == 422
    assert wrong_purpose.json()['code'] == 'PURPOSE_MISMATCH'

    no_route = await client.get('/v1/nothing-here')
    assert no_route.status_code == 404


async def test_budget_exceeded_is_429_with_retry_after(
    client: httpx.AsyncClient, harness: Harness
) -> None:
    put = await client.put(
        f'/v1/tenants/{harness.tenant}/ai-budget',
        json={'monthly_tokens': 0, 'monthly_gpu_seconds': 0},
        headers=auth(roles=['super_admin'], scopes=[]),
    )
    assert put.status_code == 200
    ref = await register(client)
    r = await client.post(
        '/v1/llm/messages',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': ref,
            'variables': {'resume': 'x'},
        },
        headers=auth(),
    )
    assert r.status_code == 429
    assert r.json()['code'] == 'BUDGET_EXCEEDED'
    assert int(r.headers['retry-after']) > 0


async def test_message_round_trip(client: httpx.AsyncClient, harness: Harness) -> None:
    ref = await register(client)
    r = await client.post(
        '/v1/llm/messages',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': ref,
            'variables': {'resume': 'Contact me at jo.doe@example.org about the role.'},
        },
        headers=auth(tid=harness.tenant),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # The stub echoes what it received; the whole-text reply is re-identified for the caller.
    assert 'jo.doe@example.org' in body['text']
    assert 'jo.doe@example.org' not in user_text(harness.providers['stub'].requests[0])
    assert body['model'] == 'claude-haiku-5-5'


# --- streaming ----------------------------------------------------------------------------------------


def parse_sse(raw: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in raw.strip().split('\n\n'):
        lines = dict(line.split(': ', 1) for line in block.splitlines())
        events.append((lines['event'], json.loads(lines['data'])))
    return events


async def test_stream_reidentifies_without_splitting_tokens(
    client: httpx.AsyncClient, harness: Harness
) -> None:
    ref = await register(client)
    r = await client.post(
        '/v1/llm/messages:stream',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': ref,
            'variables': {'resume': 'Reach Ana Lima on +351 912 345 678 or ana.lima@example.pt.'},
            'known_pii': ['Ana Lima'],
        },
        headers=auth(),
    )
    assert r.status_code == 200
    assert r.headers['content-type'].startswith('text/event-stream')
    events = parse_sse(r.text)
    assert events[0][0] == 'meta'
    assert events[-1][0] == 'done'
    text = ''.join(e[1]['text'] for e in events if e[0] == 'delta')
    assert 'Ana Lima' in text
    assert 'ana.lima@example.pt' in text
    assert not TOKEN.search(text)
    assert all('[[PII' not in e[1]['text'] for e in events if e[0] == 'delta')
    sent = user_text(harness.providers['stub'].requests[0])
    assert 'Ana Lima' not in sent
    assert '912 345 678' not in sent


async def test_stream_rejects_structured_prompts_before_streaming(
    client: httpx.AsyncClient, harness: Harness
) -> None:
    template = await harness.register()
    r = await client.post(
        '/v1/llm/messages:stream',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': template.ref,
            'variables': {'resume': 'x'},
        },
        headers=auth(),
    )
    assert r.status_code == 400
    assert r.json()['code'] == 'STREAM_NOT_SUPPORTED'


# --- tool sessions --------------------------------------------------------------------------------


async def test_tool_loop_keeps_pseudonyms_across_turns(
    client: httpx.AsyncClient, harness: Harness
) -> None:
    stub = harness.providers['stub']

    def script(request: ProviderRequest) -> ProviderResponse:
        last = request.messages[-1]['content']
        if isinstance(last, list) and last and last[0].get('type') == 'tool_result':
            return ProviderResponse(request.model, f'Done: {last[0]["content"]}', 'end_turn', 5, 5)
        person = TOKEN.search(user_text(request))
        assert person
        call = ToolCall('toolu_1', 'lookup_candidate', {'name': person.group(0)})
        return ProviderResponse(
            request.model,
            '',
            'tool_use',
            10,
            5,
            tool_calls=[call],
            content=[
                {
                    'type': 'tool_use',
                    'id': 'toolu_1',
                    'name': 'lookup_candidate',
                    'input': call.input,
                }
            ],
        )

    stub.script = script
    ref = await register(client)
    tools = [
        {
            'name': 'lookup_candidate',
            'description': 'Find a candidate',
            'input_schema': {'type': 'object'},
        }
    ]
    first = await client.post(
        '/v1/llm/messages',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': ref,
            'variables': {'resume': 'Bruno Costa applied.'},
            'known_pii': ['Bruno Costa'],
            'tools': tools,
        },
        headers=auth(),
    )
    assert first.status_code == 200, first.text
    call = first.json()['tool_calls'][0]
    assert TOKEN.fullmatch(call['input']['name'])  # tool inputs stay pseudonymised
    session = first.json()['session_id']

    second = await client.post(
        '/v1/llm/messages',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': ref,
            'session_id': session,
            'tool_results': [{'tool_use_id': 'toolu_1', 'content': 'Bruno Costa: 3 interviews'}],
        },
        headers=auth(),
    )
    assert second.status_code == 200, second.text
    assert second.json()['text'] == 'Done: Bruno Costa: 3 interviews'
    # The tool result was redacted with the same pseudonym before it went back to the model.
    assert 'Bruno' not in user_text(stub.requests[1])
    assert call['input']['name'] in user_text(stub.requests[1])

    stolen = await client.post(
        '/v1/llm/messages',
        json={
            'tenant_id': str(uuid.uuid4()),
            'purpose': 'resume_extraction',
            'prompt': ref,
            'session_id': session,
            'tool_results': [{'tool_use_id': 'toolu_1', 'content': 'x'}],
        },
        headers=auth(),
    )
    assert stolen.status_code == 404
    assert stolen.json()['code'] == 'SESSION_NOT_FOUND'


# --- embeddings ------------------------------------------------------------------------------------


async def test_embeddings_contract(client: httpx.AsyncClient, harness: Harness) -> None:
    r = await client.post(
        '/v1/embeddings',
        json={
            'model': harness.embeddings.model,
            'input': ['python developer', 'java'],
            'purpose': 'taxonomy_normalisation',
        },
        headers=auth(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['model'] == harness.embeddings.model
    assert [d['index'] for d in body['data']] == [0, 1]
    for d in body['data']:
        assert len(d['embedding']) == 1024
        assert math.isclose(math.sqrt(sum(x * x for x in d['embedding'])), 1.0, rel_tol=1e-6)

    wrong_model = await client.post(
        '/v1/embeddings',
        json={'model': 'bge-m3', 'input': ['x'], 'purpose': 'taxonomy_normalisation'},
        headers=auth(),
    )
    assert wrong_model.json()['code'] == 'UNSUPPORTED_MODEL'

    too_many = await client.post(
        '/v1/embeddings',
        json={
            'model': harness.embeddings.model,
            'input': ['x'] * 65,
            'purpose': 'taxonomy_normalisation',
        },
        headers=auth(),
    )
    assert too_many.status_code == 400

    harness.embeddings.down = True
    down = await client.post(
        '/v1/embeddings',
        json={
            'model': harness.embeddings.model,
            'input': ['x'],
            'purpose': 'taxonomy_normalisation',
        },
        headers=auth(),
    )
    assert down.status_code == 503


async def test_embeddings_charge_gpu_seconds_to_the_tenant(
    client: httpx.AsyncClient, harness: Harness
) -> None:
    r = await client.post(
        '/v1/embeddings',
        json={
            'model': harness.embeddings.model,
            'tenant_id': harness.tenant,
            'purpose': 'resume_chunk',
            'input': ['Call Marta Silva on +34 612 345 678'],
        },
        headers=auth(),
    )
    assert r.status_code == 200
    assert (await harness.budgets.get(harness.tenant))['usage']['gpu_seconds'] == pytest.approx(
        0.01
    )


# --- prompts ---------------------------------------------------------------------------------------


async def test_prompt_versions_are_immutable(client: httpx.AsyncClient) -> None:
    prompt_id = f'http.imm-{uuid.uuid4().hex[:8]}'
    body = {**PROMPT_BODY, 'prompt_id': prompt_id, 'version': 1}
    headers = auth(scopes=['prompts:write'])
    assert (await client.post('/v1/prompts', json=body, headers=headers)).status_code == 201
    again = await client.post('/v1/prompts', json=body, headers=headers)
    assert again.status_code == 201  # identical retry is a no-op
    changed = await client.post(
        '/v1/prompts', json={**body, 'system_template': 'Different.'}, headers=headers
    )
    assert changed.status_code == 409
    assert changed.json()['code'] == 'PROMPT_VERSION_EXISTS'

    no_scope = await client.post('/v1/prompts', json={**body, 'version': 2}, headers=auth())
    assert no_scope.status_code == 403

    undeclared = await client.post(
        '/v1/prompts',
        json={**body, 'version': 3, 'user_template': '{{resume}} {{extra}}'},
        headers=headers,
    )
    assert undeclared.json()['code'] == 'UNDECLARED_VARIABLE'

    retired = await client.post(f'/v1/prompts/{prompt_id}/versions/1:retire', headers=headers)
    assert retired.status_code == 200
    assert retired.json()['status'] == 'retired'
    versions = await client.get(f'/v1/prompts/{prompt_id}/versions', headers=auth())
    assert [v['status'] for v in versions.json()['data']] == ['retired']
    one = await client.get(f'/v1/prompts/{prompt_id}@1', headers=auth())
    assert one.json()['prompt'] == f'{prompt_id}@1'


async def test_retired_prompts_cannot_be_called(
    client: httpx.AsyncClient, harness: Harness
) -> None:
    ref = await register(client)
    prompt_id = ref.split('@')[0]
    await client.post(
        f'/v1/prompts/{prompt_id}/versions/1:retire', headers=auth(scopes=['prompts:write'])
    )
    r = await client.post(
        '/v1/llm/messages',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': ref,
            'variables': {'resume': 'x'},
        },
        headers=auth(),
    )
    assert r.json()['code'] == 'PROMPT_RETIRED'


# --- budgets --------------------------------------------------------------------------------------


async def test_budget_admin_permissions(client: httpx.AsyncClient, harness: Harness) -> None:
    url = f'/v1/tenants/{harness.tenant}/ai-budget'
    admin = auth(roles=['tenant_admin'], scopes=[], tid=harness.tenant)
    got = await client.get(url, headers=admin)
    assert got.status_code == 200
    assert got.json()['source'] == 'default'
    put = await client.put(
        url, json={'monthly_tokens': 10, 'monthly_gpu_seconds': 1}, headers=admin
    )
    assert put.json()['code'] == 'PLATFORM_MANAGED_SETTING'
    other = await client.get(f'/v1/tenants/{uuid.uuid4()}/ai-budget', headers=admin)
    assert other.status_code == 403
    staff = await client.put(
        url,
        json={'monthly_tokens': 10, 'monthly_gpu_seconds': 1, 'soft_ratio': 0.5},
        headers=auth(roles=['super_admin'], scopes=[], sub='staff:ana'),
    )
    assert staff.json()['limits'] == {
        'monthly_tokens': 10,
        'monthly_gpu_seconds': 1.0,
        'soft_ratio': 0.5,
    }
    bad = await client.get(
        '/v1/tenants/not-a-uuid/ai-budget', headers=auth(roles=['super_admin'], scopes=[])
    )
    assert bad.status_code == 400


# --- health ---------------------------------------------------------------------------------------


async def test_health(client: httpx.AsyncClient) -> None:
    assert (await client.get('/healthz')).status_code == 200
    assert (await client.get('/readyz')).json() == {'status': 'ready'}


# --- purge consumer -----------------------------------------------------------------------------------


async def test_purge_removes_tenant_rows_once(harness: Harness) -> None:
    template = await harness.registry.register(make_template(contains_candidate_text=False))
    from llm_gateway.application.gateway import MessagesRequest

    await harness.gateway.messages(
        MessagesRequest(harness.tenant, 'resume_extraction', template.ref, {'resume': 'x'})
    )
    event_id = str(uuid.uuid4())
    headers = {'event_id': event_id.encode()}
    value = json.dumps(json.dumps({'tenant_id': harness.tenant, 'to_status': 'purged'})).encode()
    parsed_id, payload = parse_outbox_record(headers, value)
    assert parsed_id == event_id

    assert await handle_purged(harness.db, parsed_id, payload) is True
    assert (
        await harness.rows('SELECT 1 FROM llm_calls WHERE tenant_id = %s', (harness.tenant,)) == []
    )
    assert (
        await harness.rows(
            'SELECT 1 FROM tenant_ai_budgets WHERE tenant_id = %s', (harness.tenant,)
        )
        == []
    )
    assert await handle_purged(harness.db, parsed_id, payload) is False  # duplicate delivery

    with pytest.raises(ValueError, match='event_id'):
        parse_outbox_record({}, b'{}')
    with pytest.raises(ValueError, match='not an object'):
        parse_outbox_record(headers, b'[1]')


async def test_model_refusal_is_422(client: httpx.AsyncClient, harness: Harness) -> None:
    harness.providers['stub'].script = lambda r: ProviderResponse(
        r.model, '', 'refusal', 5, 0, refusal_category='cyber'
    )
    ref = await register(client)
    r = await client.post(
        '/v1/llm/messages',
        json={
            'tenant_id': harness.tenant,
            'purpose': 'resume_extraction',
            'prompt': ref,
            'variables': {'resume': 'x'},
        },
        headers=auth(),
    )
    assert r.status_code == 422
    assert r.json()['code'] == 'MODEL_REFUSED'
    assert r.json()['category'] == 'cyber'
    rows = await harness.rows(
        'SELECT status FROM llm_calls WHERE tenant_id = %s', (harness.tenant,)
    )
    assert [row['status'] for row in rows] == ['refused']

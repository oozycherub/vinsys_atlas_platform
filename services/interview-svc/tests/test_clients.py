"""Outbound adapters: llm-gateway, taxonomy-svc and tenant-svc clients, and Redis hot state."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from interview_svc.application.ports import Checkpoint, UpstreamError
from interview_svc.domain.state import initial_state
from interview_svc.infrastructure.clients import GatewayClient, TaxonomyClient, TenantsClient
from interview_svc.infrastructure.hot import RedisHotState
from interview_svc.prompts import PROMPTS, SCORER


class Tokens:
    async def token(self) -> str:
        return 'svc-token'


def client(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_gateway_client() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.headers['authorization'] == 'Bearer svc-token'
        if request.url.path == '/v1/prompts':
            return httpx.Response(201 if len(seen) % 2 else 200, json={})
        body = json.loads(request.content)
        if body['prompt'] == 'bad@1':
            return httpx.Response(422, json={'code': 'PROMPT_RETIRED'})
        if body['prompt'] == 'text@1':
            return httpx.Response(200, json={'output': None, 'text': 'x'})
        if body['prompt'] == 'busy@1':
            return httpx.Response(503, json={})
        return httpx.Response(
            200, json={'output': {'competencies': []}, 'model': 'claude-sonnet-5-5'}
        )

    gw = GatewayClient('http://gw/', Tokens(), 5.0, client(handler))
    await gw.register_prompts(PROMPTS)
    assert len(seen) == len(PROMPTS)
    out = await gw.complete('t1', 'interview_evaluation', SCORER, {'a': 'b'}, ['Ann Lee', 'x'])
    assert out == {'competencies': [], '_model': 'claude-sonnet-5-5'}
    assert json.loads(seen[-1].content)['known_pii'] == ['Ann Lee']
    with pytest.raises(UpstreamError, match='PROMPT_RETIRED'):
        await gw.complete('t1', 'p', 'bad@1', {})
    with pytest.raises(UpstreamError, match='no structured output'):
        await gw.complete('t1', 'p', 'text@1', {})
    with pytest.raises(UpstreamError, match='503'):
        await gw.complete('t1', 'p', 'busy@1', {})

    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={'code': 'PROMPT_VERSION_EXISTS'})

    with pytest.raises(RuntimeError, match='PROMPT_VERSION_EXISTS'):
        await GatewayClient('http://gw', Tokens(), 5.0, client(refuse)).register_prompts(
            PROMPTS[:1]
        )

    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError('refused')

    with pytest.raises(UpstreamError, match='ConnectError'):
        await GatewayClient('http://gw', Tokens(), 5.0, client(broken)).complete(
            't', 'p', 'x@1', {}
        )


async def test_taxonomy_client() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params['tenant_id'] == 't1'
        path = request.url.path
        if path == '/v1/job-profiles/missing':
            return httpx.Response(404, json={'code': 'NOT_FOUND'})
        if path == '/v1/job-profiles/broken':
            return httpx.Response(403, json={'code': 'FORBIDDEN'})
        if path == '/v1/job-profiles/p1':
            return httpx.Response(
                200,
                json={
                    'job_profile_id': 'p1',
                    'title': 'Analyst',
                    'description': None,
                    'skills': [
                        {'skill_id': 's1', 'weight': 0.7, 'must_have': True},
                        {'skill_id': 's2', 'weight': 0.3},
                    ],
                },
            )
        if path == '/v1/skills/s1':
            return httpx.Response(200, json={'name': 'Cash flow'})
        return httpx.Response(404, json={})

    tax = TaxonomyClient('http://tax', Tokens(), 5.0, client(handler))
    profile = await tax.job_profile('t1', 'p1')
    assert profile is not None
    assert (profile.title, profile.description) == ('Analyst', '')
    assert [s['name'] for s in profile.skills] == ['Cash flow', 'Unnamed skill']
    assert profile.skills[0]['must_have'] is True
    assert await tax.job_profile('t1', 'missing') is None
    with pytest.raises(UpstreamError, match='FORBIDDEN'):
        await tax.job_profile('t1', 'broken')


async def test_tenants_client() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == '/v1/tenants/t1/settings':
            return httpx.Response(
                200, json={'settings': {'compliance': {'jurisdictions': ['us-nyc', 'eu']}}}
            )
        return httpx.Response(404, json={'code': 'TENANT_NOT_FOUND'})

    tenants = TenantsClient('http://tenant', Tokens(), 5.0, client(handler))
    assert await tenants.jurisdictions('t1') == ['us-nyc', 'eu']
    with pytest.raises(UpstreamError, match='TENANT_NOT_FOUND'):
        await tenants.jurisdictions('t2')


class FakeRedis:
    def __init__(self, fail: bool = False) -> None:
        self.data: dict[str, Any] = {}
        self.ttl: dict[str, int] = {}
        self.fail = fail

    async def get(self, key: str) -> Any:
        if self.fail:
            raise ConnectionError('redis down')
        return self.data.get(key)

    async def set(self, key: str, value: str, ex: int) -> None:
        if self.fail:
            raise ConnectionError('redis down')
        self.data[key] = value.encode()
        self.ttl[key] = ex

    async def delete(self, key: str) -> None:
        if self.fail:
            raise ConnectionError('redis down')
        self.data.pop(key, None)


async def test_redis_hot_state() -> None:
    redis = FakeRedis()
    hot = RedisHotState(redis)
    cp = Checkpoint(3, 'LISTEN', initial_state('s1', 't1', 'voice'))
    await hot.put('t1', 's1', cp)
    assert redis.ttl == {'t:t1:iv:s1': 7200}
    assert await hot.get('t1', 's1') == cp
    await hot.drop('t1', 's1')
    assert await hot.get('t1', 's1') is None
    down = RedisHotState(FakeRedis(fail=True))
    await down.put('t1', 's1', cp)  # degrades silently: Postgres is the source of truth
    await down.drop('t1', 's1')
    assert await down.get('t1', 's1') is None

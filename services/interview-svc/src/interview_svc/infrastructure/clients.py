"""HTTP clients for the services interview-svc calls, with client-credentials tokens."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any, Protocol

import httpx

from interview_svc.application.ports import JobProfile, UpstreamError

log = logging.getLogger('interview_svc')


class TokenSource(Protocol):
    async def token(self) -> str: ...


class _Client:
    def __init__(
        self, base_url: str, tokens: TokenSource, timeout: float, http: httpx.AsyncClient | None
    ) -> None:
        self.base = base_url.rstrip('/')
        self.tokens = tokens
        self.http = http or httpx.AsyncClient(timeout=timeout)

    async def call(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = {'Authorization': f'Bearer {await self.tokens.token()}'}
        try:
            response = await self.http.request(method, self.base + path, headers=headers, **kwargs)
        except httpx.HTTPError as error:
            raise UpstreamError(f'{self.base}: {type(error).__name__}') from error
        if response.status_code == 429 or response.status_code >= 500:
            raise UpstreamError(f'{self.base}{path}: HTTP {response.status_code}')
        return response


def _code(response: httpx.Response) -> str:
    try:
        return str(response.json().get('code', ''))
    except ValueError:
        return ''


class GatewayClient(_Client):
    """llm-gateway: prompt registration and messages (the JSON `output` of a registered prompt)."""

    async def register_prompts(self, prompts: Sequence[dict[str, Any]]) -> None:
        for body in prompts:
            response = await self.call('POST', '/v1/prompts', json=body)
            if response.status_code not in (200, 201):
                raise RuntimeError(
                    f'prompt {body["prompt_id"]} registration failed: HTTP '
                    f'{response.status_code} {_code(response)}'
                )

    async def complete(
        self,
        tenant_id: str,
        purpose: str,
        prompt: str,
        variables: dict[str, str],
        known_pii: Sequence[str] = (),
    ) -> dict[str, Any]:
        response = await self.call(
            'POST',
            '/v1/llm/messages',
            json={
                'tenant_id': tenant_id,
                'purpose': purpose,
                'prompt': prompt,
                'variables': variables,
                'known_pii': [v for v in known_pii if 3 <= len(v) <= 500][:50],
            },
        )
        if response.status_code != 200:
            raise UpstreamError(
                f'llm-gateway {prompt}: HTTP {response.status_code} {_code(response)}'
            )
        body = response.json()
        output = body.get('output')
        if not isinstance(output, dict):
            raise UpstreamError(f'llm-gateway {prompt}: no structured output')
        return {**output, '_model': body.get('model')}


class TaxonomyClient(_Client):
    """taxonomy-svc: the job profile and its skills' display names."""

    async def job_profile(self, tenant_id: str, job_profile_id: str) -> JobProfile | None:
        params = {'tenant_id': tenant_id}
        response = await self.call('GET', f'/v1/job-profiles/{job_profile_id}', params=params)
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise UpstreamError(f'taxonomy-svc: HTTP {response.status_code} {_code(response)}')
        body = response.json()
        skills: list[dict[str, Any]] = []
        for s in body.get('skills', []):
            r = await self.call('GET', f'/v1/skills/{s["skill_id"]}', params=params)
            name = r.json().get('name') if r.status_code == 200 else None
            skills.append(
                {
                    'skill_id': s['skill_id'],
                    'name': name or 'Unnamed skill',
                    'weight': float(s['weight']),
                    'must_have': bool(s.get('must_have')),
                }
            )
        return JobProfile(
            job_profile_id=body['job_profile_id'],
            title=body.get('title', ''),
            description=body.get('description') or '',
            skills=skills,
        )


class TenantsClient(_Client):
    """tenant-svc settings: the jurisdictions that need human approval (scope
    tenant-settings:read)."""

    async def jurisdictions(self, tenant_id: str) -> list[str]:
        response = await self.call('GET', f'/v1/tenants/{tenant_id}/settings')
        if response.status_code != 200:
            raise UpstreamError(f'tenant-svc: HTTP {response.status_code} {_code(response)}')
        compliance = response.json().get('settings', response.json()).get('compliance', {})
        return [str(j) for j in compliance.get('jurisdictions', [])]

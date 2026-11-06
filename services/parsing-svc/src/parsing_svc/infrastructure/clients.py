"""HTTP clients for the services parsing-svc calls, with client-credentials tokens."""

from __future__ import annotations

import logging
from typing import Any, Protocol

import httpx

from parsing_svc.application.ports import (
    DocumentInfo,
    DuplicateDocumentError,
    EmailTakenError,
    LlmExtraction,
    NormalizedTerm,
    UpdateError,
    UploadTarget,
    UpstreamError,
)
from parsing_svc.domain.errors import PipelineError
from parsing_svc.domain.redact import Contact
from parsing_svc.domain.schema import LLM_OUTPUT_SCHEMA, SYSTEM_PROMPT, USER_TEMPLATE

log = logging.getLogger('parsing_svc')

PROMPT_ID = 'resume.extract'
PROMPT_VERSION = 1
PURPOSE = 'resume_extraction'
EMBED_BATCH = 64


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
        headers = {
            'Authorization': f'Bearer {await self.tokens.token()}',
            **kwargs.pop('headers', {}),
        }
        try:
            response = await self.http.request(method, self.base + path, headers=headers, **kwargs)
        except httpx.HTTPError as error:
            raise UpstreamError(f'{self.base}: {type(error).__name__}') from error
        if response.status_code in (429, 502, 503, 504) or response.status_code >= 500:
            raise UpstreamError(f'{self.base}{path}: HTTP {response.status_code}')
        return response


def _code(response: httpx.Response) -> str:
    try:
        return str(response.json().get('code', ''))
    except ValueError:
        return ''


class GatewayClient(_Client):
    """llm-gateway: the extraction prompt and chunk embeddings."""

    def __init__(
        self,
        base_url: str,
        tokens: TokenSource,
        *,
        locale: str = 'English',
        timeout: float = 60.0,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(base_url, tokens, timeout, http)
        self.locale = locale

    async def register_prompt(self) -> None:
        """Registers resume.extract@1 (idempotent: identical content is a no-op)."""
        body = {
            'prompt_id': PROMPT_ID,
            'version': PROMPT_VERSION,
            'purpose': PURPOSE,
            'route': 'primary',
            'system_template': SYSTEM_PROMPT.replace('{locale}', '{{locale}}'),
            'user_template': USER_TEMPLATE,
            'variables': {
                'resume': {'required': True, 'untrusted': True},
                'locale': {'required': True},
            },
            'output_schema': LLM_OUTPUT_SCHEMA,
            'contains_candidate_text': True,
            'reidentify_fields': [],
            'effort': 'medium',
            'max_tokens': 16000,
            'deterministic': True,
        }
        response = await self.call('POST', '/v1/prompts', json=body)
        if response.status_code not in (200, 201):
            raise RuntimeError(
                f'prompt registration failed: HTTP {response.status_code} {_code(response)}'
            )

    async def extract(self, tenant_id: str, text: str, known_pii: list[str]) -> LlmExtraction:
        response = await self.call(
            'POST',
            '/v1/llm/messages',
            json={
                'tenant_id': tenant_id,
                'purpose': PURPOSE,
                'prompt': f'{PROMPT_ID}@{PROMPT_VERSION}',
                'variables': {'resume': text, 'locale': self.locale},
                'known_pii': [v for v in known_pii if 3 <= len(v) <= 500][:50],
            },
        )
        if response.status_code == 422:
            raise PipelineError(
                'LLM_UNAVAILABLE', f'The model declined the document ({_code(response)}).'
            )
        if response.status_code != 200:
            raise PipelineError(
                'LLM_UNAVAILABLE', f'llm-gateway rejected the call ({_code(response)}).'
            )
        body = response.json()
        return LlmExtraction(
            data=body.get('output') or {},
            model=str(body.get('model', '')),
            injection_score=float((body.get('injection_scores') or {}).get('resume', 0.0)),
        )

    async def embed(self, tenant_id: str, texts: list[str], model: str) -> list[list[float]]:
        out: list[list[float]] = []
        for start in range(0, len(texts), EMBED_BATCH):
            batch = texts[start : start + EMBED_BATCH]
            response = await self.call(
                'POST',
                '/v1/embeddings',
                json={
                    'model': model,
                    'input': batch,
                    'purpose': 'resume_chunk',
                    'tenant_id': tenant_id,
                },
            )
            if response.status_code != 200:
                raise UpstreamError(f'embeddings: HTTP {response.status_code} {_code(response)}')
            body = response.json()
            if body.get('model') != model:
                # Vectors from another model would silently corrupt the index (taxonomy rule).
                raise UpstreamError(f'embeddings came from {body.get("model")}, not {model}')
            vectors = [d['embedding'] for d in sorted(body['data'], key=lambda d: d['index'])]
            if len(vectors) != len(batch):
                raise UpstreamError('embedding count mismatch')
            out += vectors
        return out


class TaxonomyClient(_Client):
    def __init__(
        self,
        base_url: str,
        tokens: TokenSource,
        *,
        timeout: float = 10.0,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(base_url, tokens, timeout, http)

    async def normalize(self, tenant_id: str, terms: list[str]) -> list[NormalizedTerm]:
        if not terms:
            return []
        response = await self.call(
            'POST',
            '/v1/skills:normalize',
            json={'tenant_id': tenant_id, 'terms': [t[:200] for t in terms]},
        )
        if response.status_code != 200:
            raise UpstreamError(
                f'taxonomy normalize: HTTP {response.status_code} {_code(response)}'
            )
        return [
            NormalizedTerm(
                term, r.get('skill_id'), float(r.get('confidence', 0)), str(r.get('method', 'none'))
            )
            for term, r in zip(terms, response.json()['results'], strict=True)
        ]


class ProfileClient(_Client):
    def __init__(
        self,
        base_url: str,
        tokens: TokenSource,
        *,
        timeout: float = 10.0,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(base_url, tokens, timeout, http)

    async def get_document(self, tenant_id: str, document_id: str) -> DocumentInfo | None:
        response = await self.call(
            'GET', f'/v1/documents/{document_id}', params={'tenant_id': tenant_id}
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise UpdateError(f'profile document: HTTP {response.status_code} {_code(response)}')
        d = response.json()
        return DocumentInfo(
            d['document_id'],
            d['candidate_id'],
            d['mime_type'],
            int(d['byte_size']),
            d['parse_status'],
        )

    async def create_candidate(
        self, tenant_id: str, placeholder_name: str, external_ref: str, idempotency_key: str
    ) -> str:
        response = await self.call(
            'POST',
            '/v1/candidates',
            headers={'Idempotency-Key': idempotency_key},
            json={
                'tenant_id': tenant_id,
                'source': 'sourced',
                'external_ref': external_ref,
                'pii': {'full_name': placeholder_name},
            },
        )
        if response.status_code != 201:
            raise UpdateError(f'create candidate: HTTP {response.status_code} {_code(response)}')
        return str(response.json()['candidate_id'])

    async def initiate_upload(
        self, tenant_id: str, candidate_id: str, mime_type: str, byte_size: int, sha256: str
    ) -> UploadTarget:
        response = await self.call(
            'POST',
            '/v1/documents:initiateUpload',
            json={
                'tenant_id': tenant_id,
                'candidate_id': candidate_id,
                'mime_type': mime_type,
                'byte_size': byte_size,
                'sha256': sha256,
            },
        )
        if response.status_code == 409 and _code(response) == 'DOCUMENT_DUPLICATE':
            raise DuplicateDocumentError(response.json().get('document_id'))
        if response.status_code != 201:
            raise UpdateError(f'initiate upload: HTTP {response.status_code} {_code(response)}')
        body = response.json()
        return UploadTarget(
            body['document_id'], body['upload_url'], dict(body.get('upload_headers') or {})
        )

    async def upload(self, target: UploadTarget, data: bytes) -> None:
        try:
            response = await self.http.put(target.url, content=data, headers=target.headers)
        except httpx.HTTPError as error:
            raise UpstreamError(f'upload: {type(error).__name__}') from error
        if response.status_code >= 300:
            raise UpstreamError(f'upload: HTTP {response.status_code}')

    async def get_contact(self, tenant_id: str, candidate_id: str) -> Contact | None:
        response = await self.call(
            'GET', f'/v1/candidates/{candidate_id}', params={'tenant_id': tenant_id}
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise UpdateError(f'get candidate: HTTP {response.status_code} {_code(response)}')
        pii = response.json().get('pii') or {}
        return Contact(pii.get('full_name'), pii.get('email'), pii.get('phone'))

    async def update_contact(self, tenant_id: str, candidate_id: str, contact: Contact) -> None:
        current = await self.call(
            'GET', f'/v1/candidates/{candidate_id}', params={'tenant_id': tenant_id}
        )
        if current.status_code == 404:
            return  # erased meanwhile
        etag = current.headers.get('etag', '')
        pii = {'full_name': contact.full_name, 'email': contact.email, 'phone': contact.phone}
        response = await self.call(
            'PATCH',
            f'/v1/candidates/{candidate_id}',
            params={'tenant_id': tenant_id},
            headers={'If-Match': etag},
            json={'pii': {k: v for k, v in pii.items() if v}},
        )
        if response.status_code == 409 and _code(response) == 'CANDIDATE_EMAIL_TAKEN':
            raise EmailTakenError()
        if response.status_code == 412:
            raise UpstreamError('candidate changed concurrently; retry')
        if response.status_code != 200:
            raise UpdateError(f'update contact: HTTP {response.status_code} {_code(response)}')

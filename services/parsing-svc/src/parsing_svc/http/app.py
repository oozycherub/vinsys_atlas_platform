"""FastAPI app: parse requests, job status and progress (SSE), bulk import, vector search for
other services, and the embedding-model upgrade controls."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from atlas_platform.auth import JwtVerifier, Principal
from atlas_platform.errors import AppError
from atlas_platform.web import UUID_PATTERN, authenticate, install, problem
from fastapi import Depends, FastAPI, Header, Path, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from parsing_svc.application.admin import EmbeddingIndex
from parsing_svc.application.bulk import BulkImporter
from parsing_svc.application.jobs import JobService
from parsing_svc.application.store import FINAL_STATUSES, Job

log = logging.getLogger('parsing_svc')

#: Who may start parses and read their status (tenant users act on their own tenant).
PARSERS = frozenset({'tenant_admin', 'recruiter', 'hiring_manager', 'super_admin'})
READERS = PARSERS | {'reviewer'}
MAX_IMPORT_BYTES = 200 * 1024 * 1024


@dataclass
class Container:
    jobs: JobService
    bulk: BulkImporter
    index: EmbeddingIndex
    verifier: JwtVerifier | None
    #: Starts a bulk import in the background (an asyncio task, or a Temporal workflow).
    start_bulk: Callable[[str, str], Awaitable[None]]
    readiness: list[Callable[[], Awaitable[None]]] = field(default_factory=list)
    sse_interval: float = 0.5
    sse_timeout: float = 600.0


Caller = Annotated[Principal, Depends(authenticate)]
TenantParam = Annotated[
    str | None, Query(pattern=UUID_PATTERN, description='Platform principals only.')
]


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class SearchBody(Strict):
    tenant_id: str = Field(pattern=UUID_PATTERN)
    model_id: str = Field(max_length=100)
    vector: list[float] = Field(min_length=1024, max_length=1024)
    k: int = Field(default=100, ge=1, le=3000)
    #: Restrict to these candidates (re-ranking a known pool).
    candidate_ids: list[Annotated[str, Field(pattern=UUID_PATTERN)]] | None = Field(
        default=None, max_length=1000
    )
    #: Each candidate's N closest chunks (exact search over candidate_ids).
    per_candidate: int | None = Field(default=None, ge=1, le=10)
    include_vectors: bool = False
    chunk_types: (
        list[
            Literal[
                'profile_summary', 'experience', 'projects', 'skills', 'education', 'certifications'
            ]
        ]
        | None
    ) = None


class ShadowBody(Strict):
    model_id: str | None = Field(max_length=100)


class BackfillBody(Strict):
    tenant_id: str = Field(pattern=UUID_PATTERN)
    limit: int = Field(default=200, ge=1, le=1000)


def job_view(job: Job) -> dict[str, Any]:
    return {
        'job_id': job.job_id,
        'document_id': job.document_id,
        'candidate_id': job.candidate_id,
        'status': job.status,
        'stage': job.stage,
        'progress': job.progress,
        'attempts': job.attempts,
        'origin': job.origin,
        'parser_version': job.parser_version,
        'error': {'code': job.error_code} if job.error_code else None,
        'flags': job.flags,
        'created_at': job.created_at.isoformat() if job.created_at else None,
        'finished_at': job.finished_at.isoformat() if job.finished_at else None,
    }


def resolve_tenant(p: Principal, requested: str | None, allowed: frozenset[str], scope: str) -> str:
    """Tenant users act on their own tenant; platform staff and services name it."""
    if p.tenant_id is not None:
        if not (p.roles & allowed or p.is_service(scope)):
            raise AppError('forbidden', 'FORBIDDEN', 'Your role cannot do this.')
        if requested and requested.lower() != p.tenant_id.lower():
            raise AppError(
                'forbidden', 'TENANT_MISMATCH', 'The token is bound to a different tenant.'
            )
        return p.tenant_id.lower()
    if not ('super_admin' in p.roles or p.is_service(scope)):
        raise AppError('forbidden', 'FORBIDDEN', 'Your role cannot do this.')
    if not requested:
        raise AppError('validation', 'TENANT_REQUIRED', 'Platform principals must pass tenant_id.')
    return requested.lower()


def require_staff(p: Principal) -> None:
    if 'super_admin' not in p.roles:
        raise AppError('forbidden', 'FORBIDDEN', 'Only platform staff can change embedding models.')


def create_app(container: Container | None) -> FastAPI:
    app = FastAPI(
        title='Atlas parsing-svc',
        version='1.0.0',
        description='Résumé parsing and embedding pipeline (brick 6).',
        docs_url=None,
        redoc_url=None,
    )
    install(app, container.verifier if container else None)
    c: Any = container

    @app.get('/healthz', include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {'status': 'ok'}

    @app.get('/readyz', include_in_schema=False)
    async def readyz(request: Request) -> Response:
        try:
            for check in c.readiness:
                await check()
        except Exception:  # noqa: BLE001 - any dependency failure means not ready
            return problem(
                request, 503, 'NOT_READY', 'Service unavailable', 'A dependency is unavailable.'
            )
        return JSONResponse({'status': 'ready'})

    @app.post('/v1/resumes/{document_id}:parse', status_code=202, tags=['parsing'])
    async def parse(
        p: Caller,
        document_id: Annotated[str, Path(pattern=UUID_PATTERN)],
        idempotency_key: Annotated[str, Header(min_length=8, max_length=128)],
        tenant_id: TenantParam = None,
    ) -> dict[str, Any]:
        tenant = resolve_tenant(p, tenant_id, PARSERS, 'resumes:parse')
        job = await c.jobs.request(tenant, document_id.lower(), idempotency_key)
        return {'job_id': job.job_id, 'status': job.status, 'document_id': job.document_id}

    @app.get('/v1/parse-jobs/{job_id}', tags=['parsing'])
    async def get_job(p: Caller, job_id: str, tenant_id: TenantParam = None) -> dict[str, Any]:
        tenant = resolve_tenant(p, tenant_id, READERS, 'resumes:read')
        _uuid(job_id)
        return job_view(await c.jobs.get(tenant, job_id.lower()))

    @app.get('/v1/parse-jobs/{job_id}/events', tags=['parsing'], response_class=StreamingResponse)
    async def job_events(
        p: Caller, job_id: str, tenant_id: TenantParam = None
    ) -> StreamingResponse:
        tenant = resolve_tenant(p, tenant_id, READERS, 'resumes:read')
        _uuid(job_id)
        first = await c.jobs.get(tenant, job_id.lower())  # 404 before the stream starts

        async def stream() -> AsyncIterator[bytes]:
            job, last = first, None
            waited = 0.0
            while True:
                view = job_view(job)
                key = (view['status'], view['stage'], view['progress'])
                if key != last:
                    yield f'event: progress\ndata: {json.dumps(view)}\n\n'.encode()
                    last = key
                if job.status in FINAL_STATUSES or waited >= c.sse_timeout:
                    yield f'event: done\ndata: {json.dumps({"status": job.status})}\n\n'.encode()
                    return
                await asyncio.sleep(c.sse_interval)
                waited += c.sse_interval
                job = await c.jobs.get(tenant, job_id.lower())

        return StreamingResponse(
            stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-store'}
        )

    @app.post('/v1/resumes:bulkImport', status_code=202, tags=['parsing'])
    async def bulk_import(
        request: Request, p: Caller, tenant_id: TenantParam = None
    ) -> dict[str, Any]:
        tenant = resolve_tenant(
            p, tenant_id, frozenset({'tenant_admin', 'recruiter', 'super_admin'}), 'resumes:parse'
        )
        if request.headers.get('content-type', '').split(';')[0].strip() != 'application/zip':
            raise AppError(
                'validation', 'UNSUPPORTED_MEDIA_TYPE', 'Send the archive as application/zip.'
            )
        declared = int(request.headers.get('content-length') or 0)
        if declared > MAX_IMPORT_BYTES:
            raise AppError('validation', 'ARCHIVE_TOO_LARGE', 'The archive is larger than 200 MB.')
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_IMPORT_BYTES:
                raise AppError(
                    'validation', 'ARCHIVE_TOO_LARGE', 'The archive is larger than 200 MB.'
                )
        accepted: dict[str, Any] = await c.bulk.accept(tenant, bytes(body), p.subject)
        await c.start_bulk(tenant, accepted['batch_id'])
        return accepted

    @app.get('/v1/parse-batches/{batch_id}', tags=['parsing'])
    async def get_batch(p: Caller, batch_id: str, tenant_id: TenantParam = None) -> dict[str, Any]:
        tenant = resolve_tenant(p, tenant_id, READERS, 'resumes:read')
        _uuid(batch_id)
        result: dict[str, Any] = await c.bulk.status(tenant, batch_id.lower())
        return result

    @app.post('/v1/resume-embeddings:search', tags=['embeddings'])
    async def search(p: Caller, body: SearchBody) -> dict[str, Any]:
        if not p.is_service('embeddings:search'):
            raise AppError(
                'forbidden',
                'FORBIDDEN',
                'Requires the service role with scope "embeddings:search".',
            )
        if p.tenant_id is not None and p.tenant_id.lower() != body.tenant_id.lower():
            raise AppError(
                'forbidden', 'TENANT_MISMATCH', 'The token is bound to a different tenant.'
            )
        if body.per_candidate is None and body.k > 500:
            raise AppError('validation', 'K_TOO_LARGE', 'ANN queries return at most 500 chunks.')
        hits = await c.index.search(
            body.tenant_id.lower(),
            body.vector,
            body.model_id,
            body.k,
            body.chunk_types,
            [x.lower() for x in body.candidate_ids] if body.candidate_ids else None,
            body.per_candidate,
            body.include_vectors,
        )
        results = [
            {k: v for k, v in h.__dict__.items() if k != 'embedding' or body.include_vectors}
            for h in hits
        ]
        return {'model_id': body.model_id, 'results': results}

    @app.get('/v1/embedding-models', tags=['embeddings'])
    async def models(p: Caller) -> dict[str, Any]:
        if not ('super_admin' in p.roles or 'service' in p.roles):
            raise AppError('forbidden', 'FORBIDDEN', 'Requires platform staff or a service.')
        result: dict[str, Any] = await c.index.models()
        return result

    @app.put('/v1/embedding-models/shadow', tags=['embeddings'])
    async def set_shadow(p: Caller, body: ShadowBody) -> dict[str, Any]:
        require_staff(p)
        result: dict[str, Any] = await c.index.set_shadow(body.model_id, p.subject)
        return result

    @app.post('/v1/embedding-models:backfill', tags=['embeddings'])
    async def backfill(p: Caller, body: BackfillBody) -> dict[str, Any]:
        require_staff(p)
        result: dict[str, Any] = await c.index.backfill(body.tenant_id.lower(), body.limit)
        return result

    @app.post('/v1/embedding-models:promote', tags=['embeddings'])
    async def promote(p: Caller) -> dict[str, Any]:
        require_staff(p)
        result: dict[str, Any] = await c.index.promote(p.subject)
        return result

    return app


def _uuid(value: str) -> None:
    import re

    if not re.match(UUID_PATTERN, value):
        raise AppError('validation', 'INVALID_ID', 'Ids are UUIDs.')

"""FastAPI plumbing shared by every Python service: request ids, access log (path only),
RFC 9457 problem+json for every failure, bearer authentication."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from atlas_platform.auth import Principal
from atlas_platform.errors import TITLES, AppError

ERROR_TYPE_BASE = 'https://errors.atlas.dev/'
UUID_PATTERN = r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

log = logging.getLogger('atlas_platform.web')


class Verifier(Protocol):
    async def verify(self, token: str) -> Principal: ...


def problem(
    request: Request, status: int, code: str, title: str, detail: str, **ext: Any
) -> JSONResponse:
    body = {
        'type': ERROR_TYPE_BASE + code.lower().replace('_', '-'),
        'title': title,
        'status': status,
        'detail': detail,
        'instance': request.url.path,
        'code': code,
        'request_id': getattr(request.state, 'request_id', None),
        **ext,
    }
    headers = {}
    if isinstance(ext.get('retry_after'), int):
        headers['Retry-After'] = str(ext['retry_after'])
    return JSONResponse(
        body, status_code=status, media_type='application/problem+json', headers=headers
    )


def install(app: FastAPI, verifier: Verifier | None) -> None:
    """Middleware, problem handlers and the verifier the `authenticate` dependency uses."""
    app.state.verifier = verifier

    @app.middleware('http')
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get('x-request-id', '')
        request.state.request_id = (
            incoming if 8 <= len(incoming) <= 128 and incoming.isprintable() else str(uuid.uuid4())
        )
        started = time.perf_counter()
        response = await call_next(request)
        response.headers['X-Request-Id'] = request.state.request_id
        # Path only: query strings and bodies may carry PII.
        log.info(
            'request',
            extra={
                'method': request.method,
                'path': request.url.path,
                'status': response.status_code,
                'ms': int((time.perf_counter() - started) * 1000),
                'request_id': request.state.request_id,
            },
        )
        return response

    @app.exception_handler(AppError)
    async def app_error(request: Request, error: AppError) -> JSONResponse:
        status = error.status
        (log.error if status >= 500 else log.info)(
            'request failed', extra={'code': error.code, 'status': status}
        )
        return problem(
            request, status, error.code, TITLES[error.kind], error.message, **error.extensions
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
        errors = [
            {'path': '/' + '/'.join(str(p) for p in e['loc'][1:]), 'message': e['msg']}
            for e in error.errors()
        ]
        return problem(
            request,
            400,
            'VALIDATION_FAILED',
            'Request validation failed',
            'The request is invalid.',
            errors=errors,
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        code = 'ROUTE_NOT_FOUND' if error.status_code == 404 else f'HTTP_{error.status_code}'
        return problem(request, error.status_code, code, str(error.detail), str(error.detail))

    @app.exception_handler(Exception)
    async def unexpected(request: Request, error: Exception) -> JSONResponse:
        log.exception('unhandled error')
        return problem(
            request, 500, 'INTERNAL', 'Internal server error', 'An unexpected error occurred.'
        )


async def authenticate(request: Request) -> Principal:
    """FastAPI dependency: the verified caller (401 problem otherwise)."""
    header = request.headers.get('authorization', '')
    scheme, _, token = header.partition(' ')
    if scheme.lower() != 'bearer' or not token:
        raise AppError('unauthorized', 'UNAUTHENTICATED', 'A bearer token is required.')
    verifier: Verifier = request.app.state.verifier
    return await verifier.verify(token.strip())


def require_service(p: Principal, scope: str) -> None:
    if not p.is_service(scope):
        raise AppError('forbidden', 'FORBIDDEN', f'Requires the service role with scope "{scope}".')

"""Writes the checked-in openapi.yaml from the FastAPI app (`python -m parsing_svc.openapi`)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

from parsing_svc.http.app import create_app

OPENAPI_PATH = Path(__file__).resolve().parents[2] / 'openapi.yaml'

PROBLEM_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'description': 'RFC 9457 problem document; `code` is the stable machine-readable error.',
    'required': ['type', 'title', 'status', 'code'],
    'properties': {
        'type': {'type': 'string', 'format': 'uri'},
        'title': {'type': 'string'},
        'status': {'type': 'integer'},
        'detail': {'type': 'string'},
        'instance': {'type': 'string'},
        'code': {'type': 'string'},
        'request_id': {'type': 'string'},
    },
    'additionalProperties': True,
}
DESCRIPTIONS = {
    '400': 'Invalid request (VALIDATION_FAILED, TENANT_REQUIRED, INVALID_ARCHIVE, …).',
    '401': 'Missing or invalid bearer token.',
    '403': 'The caller lacks the role, scope or tenant.',
    '404': 'Document, job or import not found in this tenant.',
    '409': 'IDEMPOTENCY_KEY_REUSED, or EMBEDDING_MODEL_MISMATCH (with active_model).',
    '422': 'Domain rule (DOCUMENT_NOT_PARSEABLE, TOO_MANY_FILES, NO_SHADOW_MODEL, …).',
    '503': 'A dependency (profile-svc, storage) is unavailable.',
}
EXTRA: dict[str, tuple[str, ...]] = {
    'parse_v1_resumes__document_id__parse_post': ('404', '409', '422', '503'),
    'get_job_v1_parse_jobs__job_id__get': ('404',),
    'job_events_v1_parse_jobs__job_id__events_get': ('404',),
    'bulk_import_v1_resumes_bulkImport_post': ('422', '503'),
    'get_batch_v1_parse_batches__batch_id__get': ('404',),
    'search_v1_resume_embeddings_search_post': ('409',),
    'set_shadow_v1_embedding_models_shadow_put': ('422',),
    'backfill_v1_embedding_models_backfill_post': ('422', '503'),
    'promote_v1_embedding_models_promote_post': ('422',),
}


def document() -> dict[str, Any]:
    spec = create_app(None).openapi()
    spec['info']['license'] = {'name': 'Proprietary', 'identifier': 'LicenseRef-Proprietary'}
    spec['servers'] = [{'url': 'https://parsing.internal.atlas.dev'}]
    spec['components'].setdefault('securitySchemes', {})['bearer'] = {
        'type': 'http',
        'scheme': 'bearer',
        'bearerFormat': 'JWT',
        'description': 'Tenant users act on their own tenant; platform staff and services '
        '(scopes resumes:parse, resumes:read, embeddings:search) pass tenant_id.',
    }
    spec['security'] = [{'bearer': []}]
    schemas = spec['components']['schemas']
    for name in ('HTTPValidationError', 'ValidationError'):
        schemas.pop(name, None)
    schemas['Problem'] = PROBLEM_SCHEMA
    spec['components']['responses'] = {
        code: {
            'description': text,
            'content': {
                'application/problem+json': {'schema': {'$ref': '#/components/schemas/Problem'}}
            },
        }
        for code, text in DESCRIPTIONS.items()
    }
    for item in spec['paths'].values():
        for op in item.values():
            responses = op['responses']
            responses.pop('422', None)  # FastAPI's default; this service answers 400 problem+json
            for code in ('400', '401', '403', *EXTRA.get(op['operationId'], ())):
                responses[code] = {'$ref': f'#/components/responses/{code}'}
            if op['operationId'] == 'job_events_v1_parse_jobs__job_id__events_get':
                responses['200'] = {
                    'description': 'Server-sent events: progress (on every change), then done.',
                    'content': {'text/event-stream': {'schema': {'type': 'string'}}},
                }
            if op['operationId'] == 'bulk_import_v1_resumes_bulkImport_post':
                op['requestBody'] = {
                    'required': True,
                    'content': {
                        'application/zip': {'schema': {'type': 'string', 'format': 'binary'}}
                    },
                    'description': 'A zip of at most 500 résumés (PDF, DOCX, DOC, PNG, JPEG, TXT), ≤ 200 MB.',
                }
    return spec


def render() -> str:
    return yaml.safe_dump(document(), sort_keys=False, allow_unicode=True, width=100)


def main() -> None:
    OPENAPI_PATH.write_text(render())
    sys.stdout.write(f'wrote {OPENAPI_PATH}\n')


if __name__ == '__main__':
    main()

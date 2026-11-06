"""Writes the checked-in openapi.yaml from the FastAPI app (`python -m interview_svc.openapi`)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast

import yaml

from interview_svc.http.app import Container, create_app

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

EXTRA: dict[str, tuple[str, ...]] = {
    'create_interview_v1_interviews_post': ('404', '422', '502', '503'),
    'publish_interview_v1_interviews__interview_id__publish_post': ('404', '409'),
    'get_interview_v1_interviews__interview_id__get': ('404',),
    'update_plan_v1_interviews__interview_id__plan_put': ('404', '409'),
    'create_session_v1_interviews__interview_id__sessions_post': ('404', '409', '503'),
    'join_v1_interview_sessions__session_id__join_post': ('409',),
    'transcript_v1_interview_sessions__session_id__transcript_get': ('404',),
    'evaluation_v1_interview_sessions__session_id__evaluation_get': ('404',),
    'override_v1_interview_sessions__session_id__evaluation_override_post': ('404', '409'),
}
DESCRIPTIONS = {
    '400': 'Invalid request (VALIDATION_FAILED, INVALID_PLAN, TENANT_REQUIRED and others).',
    '401': 'Missing or invalid bearer or interview token.',
    '403': 'The caller lacks the role, scope or tenant.',
    '404': 'Interview, session, job profile or evaluation not found (EVALUATION_NOT_READY).',
    '409': 'INTERVIEW_NOT_PUBLISHED, NOTHING_TO_PUBLISH, INTERVIEW_ENDED, CONCURRENT_UPDATE.',
    '422': 'JOB_PROFILE_WITHOUT_SKILLS.',
    '502': 'PLAN_GENERATION_FAILED: the generated plan did not pass validation.',
    '503': 'A dependency (llm-gateway, taxonomy-svc, tenant-svc) is unavailable.',
}


def document() -> dict[str, Any]:
    spec = create_app(cast(Container, None)).openapi()
    spec['info']['license'] = {'name': 'Proprietary', 'identifier': 'LicenseRef-Proprietary'}
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
            responses.pop('422', None)
            for code in ('400', '401', '403', *EXTRA.get(op['operationId'], ())):
                responses[code] = {'$ref': f'#/components/responses/{code}'}
    spec['servers'] = [{'url': 'https://interview-svc.internal.atlas.dev'}]
    spec['components'].setdefault('securitySchemes', {}).update(
        {
            'bearer': {
                'type': 'http',
                'scheme': 'bearer',
                'bearerFormat': 'JWT',
                'description': 'Staff tokens (recruiter, hiring_manager, tenant_admin, reviewer, '
                'super_admin) or the assessment-svc service token (scope `interviews:sessions`).',
            },
            'interview': {
                'type': 'apiKey',
                'in': 'header',
                'name': 'Authorization',
                'description': '`Interview ivt_...`: the candidate token issued with the session.',
            },
        }
    )
    spec['security'] = [{'bearer': []}]
    for path in ('/v1/interview-sessions/{session_id}:join',):
        spec['paths'][path]['post']['security'] = [{'interview': []}]
    spec['paths']['/v1/interview-sessions/{session_id}/transcript']['get']['security'] = [
        {'bearer': []},
        {'interview': []},
    ]
    spec['info']['description'] += (
        ' Text mode is a WebSocket at /v1/interviews/{session_id}/ws: send '
        '{"type":"auth","token":"ivt_..."} first, then consent and message frames.'
    )
    return spec


def render() -> str:
    return yaml.safe_dump(document(), sort_keys=False, allow_unicode=True, width=100)


def main() -> None:
    OPENAPI_PATH.write_text(render())
    sys.stdout.write(f'wrote {OPENAPI_PATH}\n')


if __name__ == '__main__':
    main()

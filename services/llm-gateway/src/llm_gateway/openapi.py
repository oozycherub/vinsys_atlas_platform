"""Writes the checked-in openapi.yaml from the FastAPI app (`python -m llm_gateway.openapi`)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast

import yaml

from llm_gateway.http.app import Container, create_app

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

#: Statuses each operation can return, beyond 200/201 and the common 400/401/403.
EXTRA: dict[str, tuple[str, ...]] = {
    'messages_v1_llm_messages_post': ('404', '422', '429', '502', '503'),
    'messages_stream_v1_llm_messages_stream_post': ('404', '422', '429', '502', '503'),
    'embeddings_v1_embeddings_post': ('429', '502', '503'),
    'register_prompt_v1_prompts_post': ('409',),
    'retire_prompt_v1_prompts__prompt_id__versions__version__retire_post': ('404',),
    'get_prompt_v1_prompts__ref__get': ('404',),
}
DESCRIPTIONS = {
    '400': 'Invalid request (VALIDATION_FAILED and others).',
    '401': 'Missing or invalid bearer token.',
    '403': 'The caller lacks the role, scope or tenant.',
    '404': 'Prompt or session not found.',
    '409': 'PROMPT_VERSION_EXISTS: versions are immutable.',
    '422': 'Domain rule (PURPOSE_MISMATCH, PROMPT_RETIRED, MODEL_REFUSED).',
    '429': 'BUDGET_EXCEEDED; Retry-After gives seconds until the budget resets.',
    '502': 'OUTPUT_SCHEMA_VIOLATION after a repair attempt, or PROVIDER_REJECTED.',
    '503': 'PROVIDER_UNAVAILABLE after failover, or REDACTION_FAILED (fail closed).',
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
            responses.pop('422', None)  # FastAPI's default; this service answers 400 problem+json
            for code in ('400', '401', '403', *EXTRA.get(op['operationId'], ())):
                responses[code] = {'$ref': f'#/components/responses/{code}'}
            if op['operationId'].startswith('messages_stream'):
                responses['200'] = {
                    'description': 'Server-sent events: meta, delta*, then done or error.',
                    'content': {'text/event-stream': {'schema': {'type': 'string'}}},
                }
    spec['servers'] = [{'url': 'https://llm-gateway.internal.atlas.dev'}]
    spec['components'].setdefault('securitySchemes', {})['bearer'] = {
        'type': 'http',
        'scheme': 'bearer',
        'bearerFormat': 'JWT',
        'description': 'Service tokens (role `service`; scopes `llm:invoke`, `embeddings:create`, '
        '`prompts:write`) or staff tokens for prompt and budget administration.',
    }
    spec['security'] = [{'bearer': []}]
    return spec


def render() -> str:
    return yaml.safe_dump(document(), sort_keys=False, allow_unicode=True, width=100)


def main() -> None:
    OPENAPI_PATH.write_text(render())
    sys.stdout.write(f'wrote {OPENAPI_PATH}\n')


if __name__ == '__main__':
    main()

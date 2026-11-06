"""FastAPI app: service-to-service API, RFC 9457 problem+json, request ids, health probes."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from atlas_platform.auth import JwtVerifier, Principal
from atlas_platform.web import UUID_PATTERN, authenticate, install, problem, require_service
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from llm_gateway.application.admin import BudgetAdmin, PromptRegistry
from llm_gateway.application.gateway import Gateway, MessagesRequest
from llm_gateway.domain.errors import GatewayError
from llm_gateway.domain.policy import BudgetLimits
from llm_gateway.domain.templates import PromptTemplate, VariableSpec, parse_ref

log = logging.getLogger('llm_gateway')


@dataclass
class Container:
    gateway: Gateway
    prompts: PromptRegistry
    budgets: BudgetAdmin
    verifier: JwtVerifier
    readiness: list[Callable[[], Awaitable[None]]] = field(default_factory=list)


# --- Schemas -------------------------------------------------------------------------------------


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ToolResult(Strict):
    tool_use_id: str = Field(min_length=1, max_length=200)
    content: str | list[dict[str, Any]] | dict[str, Any] = ''
    is_error: bool = False


class MessagesBody(Strict):
    tenant_id: str = Field(pattern=UUID_PATTERN)
    purpose: str = Field(pattern=r'^[a-z][a-z0-9_]{2,60}$')
    prompt: str = Field(description='prompt_id@version, e.g. "resume.extract@3"', max_length=100)
    variables: dict[str, Annotated[str, Field(max_length=400_000)]] = Field(default_factory=dict)
    known_pii: list[Annotated[str, Field(max_length=500)]] = Field(
        default_factory=list,
        max_length=50,
        description='PII the caller already knows (name, email, phone): always redacted, even if NER misses it.',
    )
    tools: list[dict[str, Any]] | None = Field(default=None, max_length=32)
    session_id: str | None = Field(default=None, pattern=UUID_PATTERN)
    tool_results: list[ToolResult] | None = Field(default=None, max_length=32)

    def to_request(self) -> MessagesRequest:
        return MessagesRequest(
            tenant_id=self.tenant_id.lower(),
            purpose=self.purpose,
            prompt=self.prompt,
            variables=self.variables,
            known_pii=self.known_pii,
            tools=self.tools,
            session_id=self.session_id,
            tool_results=[r.model_dump() for r in self.tool_results] if self.tool_results else None,
        )


class EmbeddingsBody(Strict):
    model: str = Field(max_length=100)
    input: list[Annotated[str, Field(max_length=32_000)]] = Field(min_length=1, max_length=64)
    purpose: str = Field(pattern=r'^[a-z][a-z0-9_]{2,60}$')
    tenant_id: str | None = Field(default=None, pattern=UUID_PATTERN)


class VariableBody(Strict):
    required: bool = True
    untrusted: bool = False


class PromptBody(Strict):
    prompt_id: str = Field(pattern=r'^[a-z][a-z0-9_.-]{2,80}$')
    version: int = Field(ge=1, le=999_999)
    purpose: str = Field(pattern=r'^[a-z][a-z0-9_]{2,60}$')
    route: Literal['primary', 'fast', 'eval']
    system_template: str = Field(max_length=50_000)
    user_template: str = Field(max_length=50_000)
    variables: dict[str, VariableBody] = Field(default_factory=dict)
    output_schema: dict[str, Any] | None = None
    contains_candidate_text: bool
    reidentify_fields: list[str] = Field(default_factory=list, max_length=50)
    effort: Literal['low', 'medium', 'high', 'xhigh', 'max'] = 'medium'
    max_tokens: int = Field(default=4096, ge=1, le=64_000)
    deterministic: bool = False

    def to_template(self, by: str) -> PromptTemplate:
        return PromptTemplate(
            prompt_id=self.prompt_id,
            version=self.version,
            purpose=self.purpose,
            route=self.route,
            system_template=self.system_template,
            user_template=self.user_template,
            variables={n: VariableSpec(v.required, v.untrusted) for n, v in self.variables.items()},
            output_schema=self.output_schema,
            contains_candidate_text=self.contains_candidate_text,
            reidentify_fields=tuple(self.reidentify_fields),
            effort=self.effort,
            max_tokens=self.max_tokens,
            deterministic=self.deterministic,
            registered_by=by,
        )


class BudgetBody(Strict):
    monthly_tokens: int = Field(ge=0, le=10**12)
    monthly_gpu_seconds: float = Field(ge=0, le=10**9)
    soft_ratio: float = Field(default=0.8, gt=0, lt=1)


def template_json(t: PromptTemplate) -> dict[str, Any]:
    return {
        'prompt': t.ref,
        'prompt_id': t.prompt_id,
        'version': t.version,
        'purpose': t.purpose,
        'route': t.route,
        'system_template': t.system_template,
        'user_template': t.user_template,
        'variables': {
            n: {'required': s.required, 'untrusted': s.untrusted} for n, s in t.variables.items()
        },
        'output_schema': t.output_schema,
        'contains_candidate_text': t.contains_candidate_text,
        'reidentify_fields': list(t.reidentify_fields),
        'effort': t.effort,
        'max_tokens': t.max_tokens,
        'deterministic': t.deterministic,
        'status': t.status,
        'registered_by': t.registered_by,
    }


Caller = Annotated[Principal, Depends(authenticate)]


def create_app(container: Container) -> FastAPI:
    app = FastAPI(
        title='Atlas llm-gateway',
        version='1.0.0',
        description='Model routing, PII redaction, budgets, prompt registry and embeddings (brick 5).',
        docs_url=None,
        redoc_url=None,
    )
    c = container
    install(app, container.verifier if container else None)

    def require_tenant_match(p: Principal, tenant_id: str | None) -> None:
        # A tenant-bound service token may only act for its own tenant; platform services
        # (no tid) act for the tenant named in the request, as resolved from their verified context.
        if (
            p.tenant_id is not None
            and tenant_id is not None
            and p.tenant_id.lower() != tenant_id.lower()
        ):
            raise GatewayError(
                'forbidden', 'TENANT_MISMATCH', 'The token is bound to a different tenant.'
            )

    def can_admin_prompts(p: Principal) -> bool:
        return 'super_admin' in p.roles or ('service' in p.roles and 'prompts:write' in p.scopes)

    # -- health

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

    # -- messages

    @app.post('/v1/llm/messages', tags=['llm'])
    async def messages(body: MessagesBody, p: Caller) -> dict[str, Any]:
        require_service(p, 'llm:invoke')
        require_tenant_match(p, body.tenant_id)
        return await c.gateway.messages(body.to_request())

    @app.post('/v1/llm/messages:stream', tags=['llm'], response_class=StreamingResponse)
    async def messages_stream(body: MessagesBody, p: Caller) -> StreamingResponse:
        require_service(p, 'llm:invoke')
        require_tenant_match(p, body.tenant_id)
        events = c.gateway.stream(body.to_request())
        # Pull the first event before answering, so validation, budget and "all providers down"
        # failures become a problem+json status instead of a broken 200 stream.
        first = await anext(events)

        async def sse() -> AsyncIterator[bytes]:
            event: dict[str, Any] | None = first
            while event is not None:
                yield f'event: {event["event"]}\ndata: {json.dumps(event["data"])}\n\n'.encode()
                try:
                    event = await anext(events)
                except StopAsyncIteration:
                    event = None
                except GatewayError as error:
                    payload = {'code': error.code, 'detail': error.message}
                    yield f'event: error\ndata: {json.dumps(payload)}\n\n'.encode()
                    event = None

        return StreamingResponse(
            sse(), media_type='text/event-stream', headers={'Cache-Control': 'no-store'}
        )

    # -- embeddings

    @app.post('/v1/embeddings', tags=['embeddings'])
    async def embeddings(body: EmbeddingsBody, p: Caller) -> dict[str, Any]:
        require_service(p, 'embeddings:create')
        tenant = body.tenant_id or p.tenant_id
        require_tenant_match(p, tenant)
        return await c.gateway.embed(
            tenant.lower() if tenant else None, body.model, body.input, body.purpose
        )

    # -- prompts

    @app.post('/v1/prompts', tags=['prompts'], status_code=201)
    async def register_prompt(body: PromptBody, p: Caller) -> dict[str, Any]:
        if not can_admin_prompts(p):
            raise GatewayError(
                'forbidden',
                'FORBIDDEN',
                'Requires super_admin, or the service role with prompts:write.',
            )
        return template_json(await c.prompts.register(body.to_template(p.subject)))

    @app.get('/v1/prompts/{prompt_id}/versions', tags=['prompts'])
    async def prompt_versions(prompt_id: str, p: Caller) -> dict[str, Any]:
        if not can_admin_prompts(p) and 'service' not in p.roles:
            raise GatewayError(
                'forbidden', 'FORBIDDEN', 'Requires super_admin or the service role.'
            )
        return {'data': [template_json(t) for t in await c.prompts.versions(prompt_id)]}

    @app.get('/v1/prompts/{ref}', tags=['prompts'])
    async def get_prompt(ref: str, p: Caller) -> dict[str, Any]:
        if not can_admin_prompts(p) and 'service' not in p.roles:
            raise GatewayError(
                'forbidden', 'FORBIDDEN', 'Requires super_admin or the service role.'
            )
        prompt_id, version = parse_ref(ref)
        return template_json(await c.prompts.get(prompt_id, version))

    @app.post('/v1/prompts/{prompt_id}/versions/{version:int}:retire', tags=['prompts'])
    async def retire_prompt(prompt_id: str, version: int, p: Caller) -> dict[str, Any]:
        if not can_admin_prompts(p):
            raise GatewayError(
                'forbidden',
                'FORBIDDEN',
                'Requires super_admin, or the service role with prompts:write.',
            )
        return template_json(await c.prompts.retire(prompt_id, version))

    # -- budgets

    @app.get('/v1/tenants/{tenant_id}/ai-budget', tags=['budgets'])
    async def get_budget(tenant_id: str, p: Caller) -> dict[str, Any]:
        _uuid(tenant_id)
        allowed = 'super_admin' in p.roles or (
            'tenant_admin' in p.roles
            and p.tenant_id is not None
            and p.tenant_id.lower() == tenant_id.lower()
        )
        if not allowed:
            raise GatewayError(
                'forbidden', 'FORBIDDEN', 'Requires super_admin, or tenant_admin of this tenant.'
            )
        return await c.budgets.get(tenant_id.lower())

    @app.put('/v1/tenants/{tenant_id}/ai-budget', tags=['budgets'])
    async def put_budget(tenant_id: str, body: BudgetBody, p: Caller) -> dict[str, Any]:
        _uuid(tenant_id)
        if 'super_admin' not in p.roles:
            # Budgets are a cost control: platform-managed, like tenant `limits`.
            raise GatewayError(
                'forbidden',
                'PLATFORM_MANAGED_SETTING',
                'Only platform staff can change AI budgets.',
            )
        limits = BudgetLimits(body.monthly_tokens, body.monthly_gpu_seconds, body.soft_ratio)
        return await c.budgets.set(tenant_id.lower(), limits, p.subject)

    return app


def _uuid(value: str) -> None:
    try:
        uuid.UUID(value)
    except ValueError as error:
        raise GatewayError('validation', 'INVALID_TENANT', 'tenant_id must be a UUID.') from error

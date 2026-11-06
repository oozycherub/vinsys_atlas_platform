"""The llm-gateway use cases: messages (structured or text, tool use), streaming, embeddings."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from atlas_platform.db import Database, Tx
from atlas_platform.ids import uuid7

from llm_gateway.application.ports import (
    BudgetRepository,
    CallLog,
    CallRecord,
    Clock,
    EmbeddingProvider,
    KeyValueStore,
    LlmProvider,
    Outbox,
    PiiDetector,
    PromptRepository,
    ProviderRejectedError,
    ProviderRequest,
    ProviderResponse,
    ProviderUnavailableError,
    RouteTarget,
    StreamDone,
    TextDelta,
)
from llm_gateway.domain.errors import GatewayError
from llm_gateway.domain.policy import (
    Attempt,
    BudgetLimits,
    cache_key,
    crossed,
    exhausted,
    injection_score,
    l2_normalise,
    period_of,
    repair_instruction,
    schema_errors,
    should_fail_over,
)
from llm_gateway.domain.redaction import (
    TokenMap,
    anonymise,
    known_value_detections,
    pattern_detections,
    redact,
    reidentify_fields,
    reidentify_text,
)
from llm_gateway.domain.templates import PromptTemplate, parse_ref, render

log = logging.getLogger('llm_gateway')

PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000'
SESSION_TTL_SECONDS = 3600
CACHE_TTL_SECONDS = 24 * 3600
MAX_EMBEDDING_INPUTS = 64


@dataclass(frozen=True)
class GatewaySettings:
    routes: Mapping[str, list[RouteTarget]]
    default_limits: BudgetLimits
    #: Keys the per-tenant pseudonym HMAC (stable tokens within a tenant and month).
    pseudonym_secret: bytes
    embedding_model: str
    #: Embedding purposes whose inputs are anonymised first (e.g. résumé chunks).
    embedding_redact_purposes: frozenset[str] = frozenset()


@dataclass
class MessagesRequest:
    tenant_id: str
    purpose: str
    prompt: str
    variables: dict[str, str]
    known_pii: list[str] = field(default_factory=list)
    tools: list[dict[str, Any]] | None = None
    session_id: str | None = None
    tool_results: list[dict[str, Any]] | None = None


@dataclass
class _Prepared:
    template: PromptTemplate
    tokens: TokenMap
    system: str
    messages: list[dict[str, Any]]
    redacted_input: dict[str, Any]
    injection: dict[str, float]
    entities: dict[str, int]
    session_id: str


class Gateway:
    def __init__(
        self,
        *,
        db: Database,
        prompts: PromptRepository,
        budgets: BudgetRepository,
        calls: CallLog,
        outbox: Outbox,
        providers: Mapping[str, LlmProvider],
        embeddings: EmbeddingProvider,
        detector: PiiDetector,
        sessions: KeyValueStore,
        cache: KeyValueStore,
        clock: Clock,
        settings: GatewaySettings,
    ) -> None:
        self.db = db
        self.prompts = prompts
        self.budgets = budgets
        self.calls = calls
        self.outbox = outbox
        self.providers = providers
        self.embeddings = embeddings
        self.detector = detector
        self.sessions = sessions
        self.cache = cache
        self.clock = clock
        self.settings = settings

    # ------------------------------------------------------------------------------------ messages

    async def messages(self, req: MessagesRequest) -> dict[str, Any]:
        started = time.perf_counter()
        call_id = uuid7()
        template = await self._template(req.prompt, req.purpose)
        await self._assert_budget(req.tenant_id)
        try:
            prepared = await self._prepare(template, req)
        except GatewayError as error:
            if error.code == 'REDACTION_FAILED':
                await self._log_failure(
                    req, template, call_id, 'redaction_failed', error.code, started
                )
            raise

        cacheable = template.deterministic and not req.tools and req.session_id is None
        key = (
            cache_key(
                req.tenant_id,
                template.ref,
                template.route,
                prepared.redacted_input,
                template.output_schema,
            )
            if cacheable
            else None
        )
        if key and (hit := await self.cache.get(key)):
            cached = json.loads(hit)
            return await self._finish_cached(req, template, prepared, call_id, cached, started)

        provider_started = time.perf_counter()
        response, attempts, target = await self._call_with_failover(
            template,
            ProviderRequest(
                model='',
                system=prepared.system,
                messages=prepared.messages,
                max_tokens=template.max_tokens,
                effort=template.effort,
                output_schema=template.output_schema,
                tools=req.tools,
            ),
            req,
            call_id,
            started,
        )
        input_tokens, output_tokens = response.input_tokens, response.output_tokens

        if response.stop_reason == 'refusal':
            await self._record(
                req,
                template,
                call_id,
                'refused',
                'MODEL_REFUSED',
                attempts,
                target,
                prepared,
                None,
                input_tokens,
                output_tokens,
                started,
                provider_started,
            )
            raise GatewayError(
                'rule',
                'MODEL_REFUSED',
                'The model declined this request.',
                category=response.refusal_category,
            )

        output: Any = None
        if template.output_schema is not None and not response.tool_calls:
            output, response, more_in, more_out = await self._validated_output(
                template,
                prepared,
                response,
                target,
                req,
                call_id,
                attempts,
                started,
                provider_started,
            )
            input_tokens += more_in
            output_tokens += more_out

        result = self._result(template, prepared, response, output, call_id, target, attempts)
        if response.tool_calls:
            await self._save_session(req.tenant_id, prepared, template, response)
        await self._record(
            req,
            template,
            call_id,
            'ok',
            None,
            attempts,
            target,
            prepared,
            output if output is not None else response.text,
            input_tokens,
            output_tokens,
            started,
            provider_started,
        )
        if key and response.stop_reason == 'end_turn':
            await self.cache.set(
                key,
                json.dumps(
                    {
                        'text': response.text,
                        'output': output,
                        'model': response.model,
                        'stop_reason': response.stop_reason,
                    }
                ),
                CACHE_TTL_SECONDS,
            )
        result['usage'] = {'input_tokens': input_tokens, 'output_tokens': output_tokens}
        return result

    async def stream(self, req: MessagesRequest) -> AsyncIterator[dict[str, Any]]:
        """Server-sent events for text prompts: meta, delta*, done (or error)."""
        from llm_gateway.domain.redaction import StreamReidentifier

        started = time.perf_counter()
        call_id = uuid7()
        template = await self._template(req.prompt, req.purpose)
        if template.output_schema is not None or req.tools:
            raise GatewayError(
                'validation',
                'STREAM_NOT_SUPPORTED',
                'Streaming is for text prompts without tools or output schemas.',
            )
        await self._assert_budget(req.tenant_id)
        prepared = await self._prepare(template, req)
        reid = StreamReidentifier(prepared.tokens, enabled='' in template.reidentify_fields)
        attempts: list[Attempt] = []
        for target in self._targets(template):
            provider = self.providers[target.provider]
            t0 = time.perf_counter()
            emitted = False
            try:
                async for event in provider.stream(
                    ProviderRequest(
                        model=target.model,
                        system=prepared.system,
                        messages=prepared.messages,
                        max_tokens=template.max_tokens,
                        effort=template.effort,
                    )
                ):
                    if not emitted:
                        emitted = True
                        yield {
                            'event': 'meta',
                            'data': {
                                'call_id': call_id,
                                'model': target.model,
                                'provider': target.provider,
                            },
                        }
                    if isinstance(event, TextDelta):
                        if text := reid.feed(event.text):
                            yield {'event': 'delta', 'data': {'text': text}}
                    elif isinstance(event, StreamDone):
                        if tail := reid.flush():
                            yield {'event': 'delta', 'data': {'text': tail}}
                        attempts.append(Attempt(target.provider, target.model, 'ok', _ms(t0)))
                        r = event.response
                        status = 'refused' if r.stop_reason == 'refusal' else 'ok'
                        await self._record(
                            req,
                            template,
                            call_id,
                            status,
                            'MODEL_REFUSED' if status == 'refused' else None,
                            attempts,
                            target,
                            prepared,
                            r.text,
                            r.input_tokens,
                            r.output_tokens,
                            started,
                            t0,
                            kind='stream',
                        )
                        yield {
                            'event': 'done',
                            'data': {
                                'stop_reason': r.stop_reason,
                                'usage': {
                                    'input_tokens': r.input_tokens,
                                    'output_tokens': r.output_tokens,
                                },
                                'failover': len(attempts) > 1,
                            },
                        }
                        return
            except ProviderUnavailableError as error:
                attempts.append(
                    Attempt(target.provider, target.model, 'unavailable', _ms(t0), str(error)[:200])
                )
                if emitted:  # tokens already went out: a second model cannot continue them
                    await self._log_failure(
                        req,
                        template,
                        call_id,
                        'provider_unavailable',
                        'STREAM_INTERRUPTED',
                        started,
                        attempts,
                        kind='stream',
                    )
                    yield {
                        'event': 'error',
                        'data': {
                            'code': 'PROVIDER_UNAVAILABLE',
                            'detail': 'The stream was interrupted.',
                        },
                    }
                    return
                if not should_fail_over('unavailable'):
                    break
            except ProviderRejectedError as error:
                raise GatewayError(
                    'upstream_invalid', 'PROVIDER_REJECTED', str(error)[:300]
                ) from error
        await self._log_failure(
            req,
            template,
            call_id,
            'provider_unavailable',
            'PROVIDER_UNAVAILABLE',
            started,
            attempts,
            kind='stream',
        )
        raise GatewayError(
            'unavailable', 'PROVIDER_UNAVAILABLE', 'Every model for this route is unavailable.'
        )

    # ----------------------------------------------------------------------------------- embeddings

    async def embed(
        self, tenant_id: str | None, model: str, inputs: list[str], purpose: str
    ) -> dict[str, Any]:
        started = time.perf_counter()
        tenant = tenant_id or PLATFORM_TENANT
        if model != self.settings.embedding_model:
            raise GatewayError(
                'validation',
                'UNSUPPORTED_MODEL',
                f'This gateway serves {self.settings.embedding_model}.',
            )
        if not 1 <= len(inputs) <= MAX_EMBEDDING_INPUTS:
            raise GatewayError(
                'validation', 'BATCH_TOO_LARGE', f'Send 1-{MAX_EMBEDDING_INPUTS} inputs per call.'
            )
        if tenant_id:
            await self._assert_budget(tenant_id, resource='gpu_seconds')
        texts = inputs
        if purpose in self.settings.embedding_redact_purposes:
            try:
                texts = [
                    anonymise(t, pattern_detections(t) + await self.detector.detect(t))
                    for t in inputs
                ]
            except Exception as error:
                raise GatewayError(
                    'unavailable', 'REDACTION_FAILED', 'PII detection failed; nothing was embedded.'
                ) from error
        try:
            vectors, gpu_seconds = await self.embeddings.embed(texts)
        except ProviderUnavailableError as error:
            raise GatewayError(
                'unavailable', 'PROVIDER_UNAVAILABLE', 'The embedding model is unavailable.'
            ) from error
        if len(vectors) != len(texts):
            raise GatewayError(
                'upstream_invalid',
                'EMBEDDING_COUNT_MISMATCH',
                'The embedding model returned the wrong count.',
            )
        vectors = [l2_normalise(v) for v in vectors]
        async with self.db.tenant_tx(tenant) as tx:
            if tenant_id:
                await self._add_usage(tx, tenant_id, 0, gpu_seconds)
            record = CallRecord(
                tenant_id=tenant,
                call_id=uuid7(),
                created_at=self.clock.now(),
                kind='embeddings',
                purpose=purpose,
                status='ok',
                model=self.embeddings.model,
                provider='embeddings',
                input_redacted={'inputs': len(inputs)},
                latency_ms=_ms(started),
            )
            await self.calls.insert(tx, record)
            await self._completed_event(tx, record, failover=False, cache_hit=False)
        return {
            'model': self.embeddings.model,
            'data': [{'index': i, 'embedding': v} for i, v in enumerate(vectors)],
            'usage': {'inputs': len(inputs), 'gpu_seconds': round(gpu_seconds, 3)},
        }

    # ------------------------------------------------------------------------------------- helpers

    async def _template(self, ref: str, purpose: str) -> PromptTemplate:
        prompt_id, version = parse_ref(ref)
        async with self.db.system_tx() as tx:
            template = await self.prompts.get(tx, prompt_id, version)
        if template is None:
            raise GatewayError('not_found', 'PROMPT_NOT_FOUND', f'No prompt {ref} is registered.')
        if template.status != 'active':
            raise GatewayError('rule', 'PROMPT_RETIRED', f'{ref} is retired; use a newer version.')
        if template.purpose != purpose:
            raise GatewayError(
                'rule', 'PURPOSE_MISMATCH', f'{ref} is registered for purpose "{template.purpose}".'
            )
        return template

    def _namer(self, tenant_id: str) -> Any:
        key = hmac.new(
            self.settings.pseudonym_secret,
            f'{tenant_id}|{period_of(self.clock.now())}'.encode(),
            hashlib.sha256,
        ).digest()
        return lambda value: hmac.new(key, value.encode(), hashlib.sha256).hexdigest()[:8].upper()

    async def _prepare(self, template: PromptTemplate, req: MessagesRequest) -> _Prepared:
        session: dict[str, Any] | None = None
        if req.session_id:
            raw = await self.sessions.get(f'llm:session:{req.session_id}')
            session = json.loads(raw) if raw else None
            if (
                not session
                or session['tenant_id'] != req.tenant_id
                or session['prompt'] != template.ref
            ):
                raise GatewayError(
                    'not_found',
                    'SESSION_NOT_FOUND',
                    'The session expired or does not belong to this call.',
                )
        tokens = TokenMap(session['tokens'] if session else None, namer=self._namer(req.tenant_id))
        must_redact = template.contains_candidate_text or bool(req.known_pii)
        entities: dict[str, int] = {}

        async def clean(text: str) -> str:
            if not must_redact:
                return text
            try:
                detections = (
                    known_value_detections(text, req.known_pii)
                    + pattern_detections(text)
                    + await self.detector.detect(text)
                )
            except Exception as error:  # fail closed: nothing leaves without redaction
                log.error(
                    'pii detection failed',
                    extra={'tenant_id': req.tenant_id, 'error': type(error).__name__},
                )
                raise GatewayError(
                    'unavailable', 'REDACTION_FAILED', 'PII detection failed; nothing was sent.'
                ) from error
            redacted, counts = redact(text, detections, tokens)
            for k, v in counts.items():
                entities[k] = entities.get(k, 0) + v
            return redacted

        if session:
            messages: list[dict[str, Any]] = list(session['messages'])
            results = []
            for r in req.tool_results or []:
                content = r.get('content', '')
                results.append(
                    {
                        'type': 'tool_result',
                        'tool_use_id': r['tool_use_id'],
                        'content': await clean(
                            content if isinstance(content, str) else json.dumps(content)
                        ),
                        **({'is_error': True} if r.get('is_error') else {}),
                    }
                )
            if not results:
                raise GatewayError(
                    'validation',
                    'TOOL_RESULTS_REQUIRED',
                    'Continuing a session needs tool_results.',
                )
            messages.append({'role': 'user', 'content': results})
            return _Prepared(
                template,
                tokens,
                session['system'],
                messages,
                {'tool_results': len(results)},
                {},
                entities,
                req.session_id or uuid7(),
            )

        redacted_vars = {name: await clean(value) for name, value in req.variables.items()}
        rendered = render(template, redacted_vars)
        injection = {
            name: injection_score(value) for name, value in rendered.untrusted_values.items()
        }
        return _Prepared(
            template,
            tokens,
            rendered.system,
            [{'role': 'user', 'content': rendered.user}],
            redacted_vars,
            injection,
            entities,
            uuid7(),
        )

    def _targets(self, template: PromptTemplate) -> list[RouteTarget]:
        targets = self.settings.routes.get(template.route, [])
        if not targets:
            raise GatewayError(
                'unavailable', 'NO_ROUTE', f'No models are configured for route "{template.route}".'
            )
        return targets

    async def _call_with_failover(
        self,
        template: PromptTemplate,
        base: ProviderRequest,
        req: MessagesRequest,
        call_id: str,
        started: float,
    ) -> tuple[ProviderResponse, list[Attempt], RouteTarget]:
        attempts: list[Attempt] = []
        for target in self._targets(template):
            t0 = time.perf_counter()
            try:
                response = await self.providers[target.provider].create(
                    ProviderRequest(**{**base.__dict__, 'model': target.model})
                )
            except ProviderUnavailableError as error:
                attempts.append(
                    Attempt(target.provider, target.model, 'unavailable', _ms(t0), str(error)[:200])
                )
                log.warning(
                    'provider unavailable; failing over',
                    extra={'provider': target.provider, 'model': target.model},
                )
                if not should_fail_over('unavailable'):
                    break
            except ProviderRejectedError as error:
                attempts.append(
                    Attempt(target.provider, target.model, 'rejected', _ms(t0), str(error)[:200])
                )
                raise GatewayError(
                    'upstream_invalid', 'PROVIDER_REJECTED', str(error)[:300]
                ) from error
            else:
                attempts.append(
                    Attempt(
                        target.provider,
                        target.model,
                        'refused' if response.stop_reason == 'refusal' else 'ok',
                        _ms(t0),
                    )
                )
                return response, attempts, target
        await self._log_failure(
            req,
            template,
            call_id,
            'provider_unavailable',
            'PROVIDER_UNAVAILABLE',
            started,
            attempts,
        )
        raise GatewayError(
            'unavailable',
            'PROVIDER_UNAVAILABLE',
            'Every model for this route is unavailable.',
            attempts=[a.__dict__ for a in attempts],
        )

    async def _validated_output(
        self,
        template: PromptTemplate,
        prepared: _Prepared,
        response: ProviderResponse,
        target: RouteTarget,
        req: MessagesRequest,
        call_id: str,
        attempts: list[Attempt],
        started: float,
        provider_started: float,
    ) -> tuple[Any, ProviderResponse, int, int]:
        """One repair retry with the validator's errors, then 502 (docs/prompts/05 §6)."""
        assert template.output_schema is not None
        more_in = more_out = 0
        current = response
        for attempt in range(2):
            errors = _json_errors(template.output_schema, current.text)
            if not errors:
                return json.loads(current.text), current, more_in, more_out
            if attempt == 1:
                break
            repair = ProviderRequest(
                model=target.model,
                system=prepared.system,
                messages=[
                    *prepared.messages,
                    {'role': 'assistant', 'content': current.text or '(empty)'},
                    {'role': 'user', 'content': repair_instruction(errors)},
                ],
                max_tokens=template.max_tokens,
                effort=template.effort,
                output_schema=template.output_schema,
            )
            t0 = time.perf_counter()
            try:
                current = await self.providers[target.provider].create(repair)
            except (ProviderUnavailableError, ProviderRejectedError) as error:
                attempts.append(
                    Attempt(
                        target.provider,
                        target.model,
                        'unavailable',
                        _ms(t0),
                        f'repair: {error}'[:200],
                    )
                )
                break
            attempts.append(Attempt(target.provider, target.model, 'ok', _ms(t0), 'repair'))
            more_in += current.input_tokens
            more_out += current.output_tokens
        await self._record(
            req,
            template,
            call_id,
            'schema_violation',
            'OUTPUT_SCHEMA_VIOLATION',
            attempts,
            target,
            prepared,
            current.text,
            response.input_tokens + more_in,
            response.output_tokens + more_out,
            started,
            provider_started,
        )
        raise GatewayError(
            'upstream_invalid',
            'OUTPUT_SCHEMA_VIOLATION',
            'The model output did not match the schema after a repair attempt.',
            errors=_json_errors(template.output_schema, current.text),
        )

    def _result(
        self,
        template: PromptTemplate,
        prepared: _Prepared,
        response: ProviderResponse,
        output: Any,
        call_id: str,
        target: RouteTarget,
        attempts: list[Attempt],
    ) -> dict[str, Any]:
        text: str | None = response.text if template.output_schema is None else None
        if text is not None and '' in template.reidentify_fields:
            text = reidentify_text(text, prepared.tokens)
        return {
            'call_id': call_id,
            'model': response.model,
            'provider': target.provider,
            'stop_reason': response.stop_reason,
            'output': reidentify_fields(output, prepared.tokens, template.reidentify_fields)
            if output is not None
            else None,
            'text': text,
            # Tool inputs stay pseudonymised: the caller returns results against the same session.
            'tool_calls': [
                {'id': c.id, 'name': c.name, 'input': c.input} for c in response.tool_calls
            ],
            'session_id': prepared.session_id if response.tool_calls else None,
            'cache_hit': False,
            'failover': len([a for a in attempts if a.detail != 'repair']) > 1,
            'attempts': [a.__dict__ for a in attempts],
            'injection_scores': prepared.injection,
            'redaction': {'entities': prepared.entities},
        }

    async def _finish_cached(
        self,
        req: MessagesRequest,
        template: PromptTemplate,
        prepared: _Prepared,
        call_id: str,
        cached: dict[str, Any],
        started: float,
    ) -> dict[str, Any]:
        async with self.db.tenant_tx(req.tenant_id) as tx:
            record = CallRecord(
                tenant_id=req.tenant_id,
                call_id=call_id,
                created_at=self.clock.now(),
                kind='messages',
                purpose=req.purpose,
                status='cache_hit',
                prompt_id=template.prompt_id,
                prompt_version=template.version,
                route=template.route,
                model=cached['model'],
                provider='cache',
                input_redacted=prepared.redacted_input,
                output_redacted=cached['output']
                if cached['output'] is not None
                else cached['text'],
                latency_ms=_ms(started),
                overhead_ms=_ms(started),
                injection_scores=prepared.injection,
            )
            await self.calls.insert(tx, record)
            await self._completed_event(tx, record, failover=False, cache_hit=True)
        text = cached['text'] if template.output_schema is None else None
        if text is not None and '' in template.reidentify_fields:
            text = reidentify_text(text, prepared.tokens)
        output = cached['output']
        return {
            'call_id': call_id,
            'model': cached['model'],
            'provider': 'cache',
            'stop_reason': cached['stop_reason'],
            'output': reidentify_fields(output, prepared.tokens, template.reidentify_fields)
            if output is not None
            else None,
            'text': text,
            'tool_calls': [],
            'session_id': None,
            'cache_hit': True,
            'failover': False,
            'attempts': [],
            'injection_scores': prepared.injection,
            'redaction': {'entities': prepared.entities},
            'usage': {'input_tokens': 0, 'output_tokens': 0},
        }

    async def _save_session(
        self,
        tenant_id: str,
        prepared: _Prepared,
        template: PromptTemplate,
        response: ProviderResponse,
    ) -> None:
        state = {
            'tenant_id': tenant_id,
            'prompt': template.ref,
            'system': prepared.system,
            'messages': [*prepared.messages, {'role': 'assistant', 'content': response.content}],
            'tokens': prepared.tokens.forward,
        }
        await self.sessions.set(
            f'llm:session:{prepared.session_id}', json.dumps(state), SESSION_TTL_SECONDS
        )

    async def _assert_budget(self, tenant_id: str, resource: str = 'tokens') -> None:
        async with self.db.tenant_tx(tenant_id) as tx:
            limits = await self.budgets.limits(tx, tenant_id) or self.settings.default_limits
            usage = await self.budgets.usage(tx, tenant_id, period_of(self.clock.now()))
        if exhausted(limits, usage, 'tokens' if resource == 'tokens' else 'gpu_seconds'):
            now = self.clock.now()
            next_month = datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=UTC)
            raise GatewayError(
                'too_many',
                'BUDGET_EXCEEDED',
                "This tenant's monthly AI budget is used up.",
                resource=resource,
                period=period_of(now),
                retry_after=max(1, int((next_month - now).total_seconds())),
            )

    async def _add_usage(self, tx: Tx, tenant_id: str, tokens: int, gpu_seconds: float) -> None:
        period = period_of(self.clock.now())
        limits = await self.budgets.limits(tx, tenant_id) or self.settings.default_limits
        before, after = await self.budgets.add(tx, tenant_id, period, tokens, gpu_seconds)
        for level, resource, used, limit in crossed(limits, before, after):
            await self.budgets.mark_alerted(tx, tenant_id, period, level)
            await self.outbox.append(
                tx,
                topic='ai.budget.threshold_crossed.v1',
                tenant_id=tenant_id,
                aggregate_type='ai_budget',
                aggregate_id=tenant_id,
                payload={
                    'tenant_id': tenant_id,
                    'period': period,
                    'level': level,
                    'resource': resource,
                    'used': used,
                    'limit': limit,
                    'occurred_at': self.clock.now().isoformat(),
                },
            )
            log.warning(
                'ai budget threshold crossed',
                extra={'tenant_id': tenant_id, 'level': level, 'resource': resource},
            )

    async def _record(
        self,
        req: MessagesRequest,
        template: PromptTemplate,
        call_id: str,
        status: str,
        error_code: str | None,
        attempts: list[Attempt],
        target: RouteTarget,
        prepared: _Prepared,
        output: Any,
        input_tokens: int,
        output_tokens: int,
        started: float,
        provider_started: float,
        kind: str = 'messages',
    ) -> None:
        total = _ms(started)
        async with self.db.tenant_tx(req.tenant_id) as tx:
            await self._add_usage(tx, req.tenant_id, input_tokens + output_tokens, 0.0)
            record = CallRecord(
                tenant_id=req.tenant_id,
                call_id=call_id,
                created_at=self.clock.now(),
                kind='stream' if kind == 'stream' else 'messages',
                purpose=req.purpose,
                status=status,
                prompt_id=template.prompt_id,
                prompt_version=template.version,
                route=template.route,
                model=target.model,
                provider=target.provider,
                error_code=error_code,
                attempts=[a.__dict__ for a in attempts],
                input_redacted=prepared.redacted_input,
                output_redacted=output,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                latency_ms=total,
                overhead_ms=max(0, total - sum(a.latency_ms for a in attempts)),
                injection_scores=prepared.injection,
            )
            await self.calls.insert(tx, record)
            await self._completed_event(
                tx,
                record,
                failover=len([a for a in attempts if a.detail != 'repair']) > 1,
                cache_hit=False,
            )

    async def _log_failure(
        self,
        req: MessagesRequest,
        template: PromptTemplate,
        call_id: str,
        status: str,
        code: str,
        started: float,
        attempts: list[Attempt] | None = None,
        kind: Literal['messages', 'stream'] = 'messages',
    ) -> None:
        async with self.db.tenant_tx(req.tenant_id) as tx:
            record = CallRecord(
                tenant_id=req.tenant_id,
                call_id=call_id,
                created_at=self.clock.now(),
                kind=kind,
                purpose=req.purpose,
                status=status,
                prompt_id=template.prompt_id,
                prompt_version=template.version,
                route=template.route,
                error_code=code,
                attempts=[a.__dict__ for a in attempts or []],
                latency_ms=_ms(started),
            )
            await self.calls.insert(tx, record)
            await self._completed_event(
                tx, record, failover=len(attempts or []) > 1, cache_hit=False
            )

    async def _completed_event(
        self, tx: Tx, r: CallRecord, *, failover: bool, cache_hit: bool
    ) -> None:
        await self.outbox.append(
            tx,
            topic='ai.call.completed.v1',
            tenant_id=r.tenant_id,
            aggregate_type='ai_call',
            aggregate_id=r.call_id,
            payload={
                'tenant_id': r.tenant_id,
                'call_id': r.call_id,
                'kind': r.kind,
                'purpose': r.purpose,
                'prompt_id': r.prompt_id,
                'prompt_version': r.prompt_version,
                'model': r.model,
                'status': r.status,
                'input_tokens': r.input_tokens,
                'output_tokens': r.output_tokens,
                'latency_ms': r.latency_ms,
                'failover': failover,
                'cache_hit': cache_hit,
                'occurred_at': r.created_at.isoformat(),
            },
        )


def _ms(since: float) -> int:
    return int((time.perf_counter() - since) * 1000)


def _json_errors(schema: dict[str, Any], text: str) -> list[str]:
    try:
        value = json.loads(text)
    except (json.JSONDecodeError, TypeError) as error:
        return [
            f'(root): not valid JSON ({error.msg if isinstance(error, json.JSONDecodeError) else error})'
        ]
    return schema_errors(schema, value)

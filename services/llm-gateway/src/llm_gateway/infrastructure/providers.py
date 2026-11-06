"""LLM provider adapters: Anthropic (production) and a scriptable stub (dev and tests)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx2

from llm_gateway.application.ports import (
    ProviderRejectedError,
    ProviderRequest,
    ProviderResponse,
    ProviderUnavailableError,
    StreamDone,
    StreamEvent,
    TextDelta,
    ToolCall,
)

#: Server-side refusal fallback (a refused turn is retried on a fallback model by the API itself).
FALLBACK_BETA = 'server-side-fallback-2026-07-01'
#: Models that support `fallbacks="default"` (Haiku 5.5 does not).
FALLBACK_MODELS = frozenset({'claude-sonnet-5-5', 'claude-opus-5-5'})

_UNAVAILABLE = (
    anthropic.APIConnectionError,  # includes APITimeoutError
    anthropic.RateLimitError,
    anthropic.InternalServerError,
    anthropic.OverloadedError,
    anthropic.ServiceUnavailableError,
    anthropic.DeadlineExceededError,
)


class AnthropicProvider:
    """Claude through the Messages API (beta surface, for refusal fallbacks).

    Thinking is adaptive (it cannot be disabled on the 5.5 models); sampling parameters are not
    sent because these models reject them. Structured output uses `output_config.format`.
    """

    name = 'anthropic'

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 1,
        http_client: httpx2.AsyncClient | None = None,
    ) -> None:
        self.client = anthropic.AsyncAnthropic(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            http_client=http_client,
        )

    def _params(self, r: ProviderRequest) -> dict[str, Any]:
        output_config: dict[str, Any] = {'effort': r.effort}
        if r.output_schema is not None and not r.tools:
            output_config['format'] = {'type': 'json_schema', 'schema': r.output_schema}
        params: dict[str, Any] = {
            'model': r.model,
            'max_tokens': r.max_tokens,
            'system': r.system,
            'messages': r.messages,
            'thinking': {'type': 'adaptive'},
            'output_config': output_config,
        }
        if r.tools:
            params['tools'] = r.tools
        if r.model in FALLBACK_MODELS:
            params['betas'] = [FALLBACK_BETA]
            params['fallbacks'] = 'default'
        return params

    @staticmethod
    def _response(message: Any) -> ProviderResponse:
        text = ''.join(b.text for b in message.content if b.type == 'text')
        tool_calls = [
            ToolCall(b.id, b.name, dict(b.input)) for b in message.content if b.type == 'tool_use'
        ]
        details = getattr(message, 'stop_details', None)
        return ProviderResponse(
            model=message.model,
            text=text,
            stop_reason=message.stop_reason or 'end_turn',
            input_tokens=message.usage.input_tokens,
            output_tokens=message.usage.output_tokens,
            tool_calls=tool_calls,
            # Thinking blocks are kept so a tool loop can be continued faithfully.
            content=[b.model_dump(mode='json', exclude_none=True) for b in message.content],
            refusal_category=getattr(details, 'category', None)
            if message.stop_reason == 'refusal'
            else None,
        )

    async def create(self, request: ProviderRequest) -> ProviderResponse:
        try:
            message = await self.client.beta.messages.create(**self._params(request))
        except _UNAVAILABLE as error:
            raise ProviderUnavailableError(f'{type(error).__name__}: {error}') from error
        except anthropic.APIStatusError as error:
            raise ProviderRejectedError(f'{error.status_code}: {error.message}') from error
        return self._response(message)

    async def stream(self, request: ProviderRequest) -> AsyncIterator[StreamEvent]:
        try:
            async with self.client.beta.messages.stream(**self._params(request)) as stream:
                async for event in stream:
                    if event.type == 'content_block_delta' and event.delta.type == 'text_delta':
                        yield TextDelta(event.delta.text)
                final = await stream.get_final_message()
        except _UNAVAILABLE as error:
            raise ProviderUnavailableError(f'{type(error).__name__}: {error}') from error
        except anthropic.APIStatusError as error:
            raise ProviderRejectedError(f'{error.status_code}: {error.message}') from error
        yield StreamDone(self._response(final))


Script = Callable[[ProviderRequest], ProviderResponse | Exception]


@dataclass
class StubProvider:
    """Deterministic provider for development and tests. Records every request it receives, so
    tests can assert exactly what would have left the platform."""

    name: str = 'stub'
    script: Script | None = None
    requests: list[ProviderRequest] = field(default_factory=list)
    down: bool = False

    def _respond(self, request: ProviderRequest) -> ProviderResponse:
        self.requests.append(request)
        if self.down:
            raise ProviderUnavailableError(f'{self.name} is down')
        if self.script is not None:
            out = self.script(request)
            if isinstance(out, Exception):
                raise out
            return out
        return default_stub_response(request)

    async def create(self, request: ProviderRequest) -> ProviderResponse:
        return self._respond(request)

    async def stream(self, request: ProviderRequest) -> AsyncIterator[StreamEvent]:
        response = self._respond(request)
        text = response.text
        for i in range(0, len(text), 7):
            yield TextDelta(text[i : i + 7])
        yield StreamDone(response)


def default_stub_response(request: ProviderRequest) -> ProviderResponse:
    """Echoes the last user message (text) or the smallest object a schema allows (JSON)."""
    last = request.messages[-1]['content']
    echo = last if isinstance(last, str) else json.dumps(last)
    if request.output_schema is not None:
        text = json.dumps(_minimal(request.output_schema))
    else:
        text = f'stub reply: {echo[:2000]}'
    return ProviderResponse(
        model=request.model,
        text=text,
        stop_reason='end_turn',
        input_tokens=max(1, len(echo) // 4),
        output_tokens=max(1, len(text) // 4),
        content=[{'type': 'text', 'text': text}],
    )


def _minimal(schema: dict[str, Any]) -> Any:
    kind = schema.get('type')
    if 'enum' in schema:
        return schema['enum'][0]
    if kind == 'object':
        props = schema.get('properties', {})
        return {k: _minimal(props[k]) for k in schema.get('required', []) if k in props}
    if kind == 'array':
        return []
    if kind in ('number', 'integer'):
        return schema.get('minimum', 0)
    if kind == 'boolean':
        return False
    return ''

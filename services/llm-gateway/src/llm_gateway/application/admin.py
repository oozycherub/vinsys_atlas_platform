"""Prompt registry, budget administration and tenant purge."""

from __future__ import annotations

import logging
from typing import Any

from atlas_platform.db import Database

from llm_gateway.application.ports import (
    BudgetRepository,
    Clock,
    PromptRepository,
)
from llm_gateway.domain.errors import GatewayError
from llm_gateway.domain.policy import BudgetLimits, period_of
from llm_gateway.domain.templates import PromptTemplate, assert_template

log = logging.getLogger('llm_gateway')


class PromptRegistry:
    def __init__(self, db: Database, prompts: PromptRepository) -> None:
        self.db = db
        self.prompts = prompts

    async def register(self, template: PromptTemplate) -> PromptTemplate:
        """Versions are immutable: re-registering identical content is a no-op (safe retries);
        different content under an existing version is a conflict."""
        assert_template(template)
        async with self.db.system_tx() as tx:
            if await self.prompts.insert(tx, template):
                return template
            existing = await self.prompts.get(tx, template.prompt_id, template.version)
        if existing is not None and _same_content(existing, template):
            return existing
        raise GatewayError(
            'conflict',
            'PROMPT_VERSION_EXISTS',
            f'{template.ref} is already registered with different content; register a new version.',
        )

    async def get(self, prompt_id: str, version: int) -> PromptTemplate:
        async with self.db.system_tx() as tx:
            template = await self.prompts.get(tx, prompt_id, version)
        if template is None:
            raise GatewayError(
                'not_found', 'PROMPT_NOT_FOUND', f'No prompt {prompt_id}@{version} is registered.'
            )
        return template

    async def versions(self, prompt_id: str) -> list[PromptTemplate]:
        async with self.db.system_tx() as tx:
            return await self.prompts.versions(tx, prompt_id)

    async def retire(self, prompt_id: str, version: int) -> PromptTemplate:
        async with self.db.system_tx() as tx:
            if not await self.prompts.retire(tx, prompt_id, version):
                raise GatewayError(
                    'not_found',
                    'PROMPT_NOT_FOUND',
                    f'No prompt {prompt_id}@{version} is registered.',
                )
            template = await self.prompts.get(tx, prompt_id, version)
        assert template is not None
        return template


def _same_content(a: PromptTemplate, b: PromptTemplate) -> bool:
    ignore = {'status', 'registered_by', 'metadata'}
    return {k: v for k, v in a.__dict__.items() if k not in ignore} == {
        k: v for k, v in b.__dict__.items() if k not in ignore
    }


class BudgetAdmin:
    def __init__(
        self, db: Database, budgets: BudgetRepository, clock: Clock, defaults: BudgetLimits
    ) -> None:
        self.db = db
        self.budgets = budgets
        self.clock = clock
        self.defaults = defaults

    async def get(self, tenant_id: str) -> dict[str, Any]:
        period = period_of(self.clock.now())
        async with self.db.tenant_tx(tenant_id) as tx:
            custom = await self.budgets.limits(tx, tenant_id)
            usage = await self.budgets.usage(tx, tenant_id, period)
        limits = custom or self.defaults
        return {
            'tenant_id': tenant_id,
            'period': period,
            'source': 'tenant' if custom else 'default',
            'limits': {
                'monthly_tokens': limits.monthly_tokens,
                'monthly_gpu_seconds': limits.monthly_gpu_seconds,
                'soft_ratio': limits.soft_ratio,
            },
            'usage': {'tokens': usage.tokens_used, 'gpu_seconds': round(usage.gpu_seconds_used, 3)},
        }

    async def set(self, tenant_id: str, limits: BudgetLimits, by: str) -> dict[str, Any]:
        async with self.db.tenant_tx(tenant_id) as tx:
            await self.budgets.set_limits(tx, tenant_id, limits, by)
        log.info('ai budget updated', extra={'tenant_id': tenant_id, 'by': by})
        return await self.get(tenant_id)

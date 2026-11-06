"""Postgres repositories for prompts, budgets, the call log, the outbox and tenant purge."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, cast

from atlas_platform.db import Tx
from psycopg.types.json import Jsonb

from llm_gateway.application.ports import CallRecord
from llm_gateway.domain.policy import BudgetLimits, BudgetUsage, Level
from llm_gateway.domain.templates import Effort, PromptTemplate, Route, VariableSpec


def _template(row: dict[str, Any]) -> PromptTemplate:
    return PromptTemplate(
        prompt_id=row['prompt_id'],
        version=row['version'],
        purpose=row['purpose'],
        route=cast(Route, row['route']),
        system_template=row['system_template'],
        user_template=row['user_template'],
        variables={
            name: VariableSpec(
                required=bool(spec.get('required', True)),
                untrusted=bool(spec.get('untrusted', False)),
            )
            for name, spec in row['variables'].items()
        },
        output_schema=row['output_schema'],
        contains_candidate_text=row['contains_candidate_text'],
        reidentify_fields=tuple(row['reidentify_fields'] or ()),
        effort=cast(Effort, row['effort']),
        max_tokens=row['max_tokens'],
        deterministic=row['deterministic'],
        status=row['status'],
        registered_by=row['registered_by'],
        metadata={'created_at': row['created_at'].isoformat()} if row.get('created_at') else {},
    )


class PgPromptRepository:
    async def get(self, tx: Tx, prompt_id: str, version: int) -> PromptTemplate | None:
        rows = await tx.fetch(
            'SELECT * FROM prompt_templates WHERE prompt_id = %s AND version = %s',
            (prompt_id, version),
        )
        return _template(rows[0]) if rows else None

    async def insert(self, tx: Tx, t: PromptTemplate) -> bool:
        count = await tx.execute(
            """INSERT INTO prompt_templates (prompt_id, version, purpose, route, system_template, user_template,
                 variables, output_schema, contains_candidate_text, reidentify_fields, effort, max_tokens,
                 deterministic, registered_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (prompt_id, version) DO NOTHING""",
            (
                t.prompt_id,
                t.version,
                t.purpose,
                t.route,
                t.system_template,
                t.user_template,
                Jsonb(
                    {
                        n: {'required': s.required, 'untrusted': s.untrusted}
                        for n, s in t.variables.items()
                    }
                ),
                Jsonb(t.output_schema) if t.output_schema is not None else None,
                t.contains_candidate_text,
                list(t.reidentify_fields),
                t.effort,
                t.max_tokens,
                t.deterministic,
                t.registered_by,
            ),
        )
        return count == 1

    async def retire(self, tx: Tx, prompt_id: str, version: int) -> bool:
        count = await tx.execute(
            "UPDATE prompt_templates SET status = 'retired' WHERE prompt_id = %s AND version = %s",
            (prompt_id, version),
        )
        return count == 1

    async def versions(self, tx: Tx, prompt_id: str) -> list[PromptTemplate]:
        rows = await tx.fetch(
            'SELECT * FROM prompt_templates WHERE prompt_id = %s ORDER BY version', (prompt_id,)
        )
        return [_template(r) for r in rows]


def _usage(rows: list[dict[str, Any]]) -> BudgetUsage:
    if not rows:
        return BudgetUsage(0, 0.0, soft_alerted=False, hard_alerted=False)
    r = rows[0]
    return BudgetUsage(
        tokens_used=int(r['tokens_used']),
        gpu_seconds_used=float(r['gpu_seconds_used']),
        soft_alerted=r['soft_alerted_at'] is not None,
        hard_alerted=r['hard_alerted_at'] is not None,
    )


class PgBudgetRepository:
    async def limits(self, tx: Tx, tenant_id: str) -> BudgetLimits | None:
        rows = await tx.fetch(
            'SELECT * FROM tenant_ai_budget_settings WHERE tenant_id = %s', (tenant_id,)
        )
        if not rows:
            return None
        r = rows[0]
        return BudgetLimits(
            int(r['monthly_tokens']), float(r['monthly_gpu_seconds']), float(r['soft_ratio'])
        )

    async def set_limits(self, tx: Tx, tenant_id: str, limits: BudgetLimits, by: str) -> None:
        await tx.execute(
            """INSERT INTO tenant_ai_budget_settings (tenant_id, monthly_tokens, monthly_gpu_seconds, soft_ratio, updated_by)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id) DO UPDATE SET monthly_tokens = EXCLUDED.monthly_tokens,
                 monthly_gpu_seconds = EXCLUDED.monthly_gpu_seconds, soft_ratio = EXCLUDED.soft_ratio,
                 updated_by = EXCLUDED.updated_by, updated_at = now()""",
            (tenant_id, limits.monthly_tokens, limits.monthly_gpu_seconds, limits.soft_ratio, by),
        )

    async def usage(self, tx: Tx, tenant_id: str, period: str) -> BudgetUsage:
        return _usage(
            await tx.fetch(
                'SELECT * FROM tenant_ai_budgets WHERE tenant_id = %s AND period = %s',
                (tenant_id, period),
            )
        )

    async def add(
        self, tx: Tx, tenant_id: str, period: str, tokens: int, gpu_seconds: float
    ) -> tuple[BudgetUsage, BudgetUsage]:
        # One atomic upsert; the row lock it takes serialises concurrent increments, so
        # (after - delta) is exactly this call's "before".
        rows = await tx.fetch(
            """INSERT INTO tenant_ai_budgets (tenant_id, period, tokens_used, gpu_seconds_used)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (tenant_id, period) DO UPDATE SET
                 tokens_used = tenant_ai_budgets.tokens_used + EXCLUDED.tokens_used,
                 gpu_seconds_used = tenant_ai_budgets.gpu_seconds_used + EXCLUDED.gpu_seconds_used,
                 updated_at = now()
               RETURNING *""",
            (tenant_id, period, tokens, round(gpu_seconds, 3)),
        )
        after = _usage(rows)
        before = BudgetUsage(
            after.tokens_used - tokens,
            round(after.gpu_seconds_used - round(gpu_seconds, 3), 3),
            after.soft_alerted,
            after.hard_alerted,
        )
        return before, after

    async def mark_alerted(self, tx: Tx, tenant_id: str, period: str, level: Level) -> None:
        column = 'hard_alerted_at' if level == 'hard' else 'soft_alerted_at'
        await tx.execute(
            f'UPDATE tenant_ai_budgets SET {column} = now() WHERE tenant_id = %s AND period = %s',  # noqa: S608
            (tenant_id, period),
        )


def _jsonb(value: Any) -> Jsonb | None:
    return None if value is None else Jsonb(value)


class PgCallLog:
    async def insert(self, tx: Tx, r: CallRecord) -> None:
        await tx.execute(
            """INSERT INTO llm_calls (tenant_id, call_id, created_at, kind, purpose, prompt_id, prompt_version, route,
                 model, provider, status, error_code, attempts, input_redacted, output_redacted, input_tokens,
                 output_tokens, latency_ms, overhead_ms, injection_scores)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                r.tenant_id,
                r.call_id,
                r.created_at,
                r.kind,
                r.purpose,
                r.prompt_id,
                r.prompt_version,
                r.route,
                r.model,
                r.provider,
                r.status,
                r.error_code,
                Jsonb(r.attempts),
                _jsonb(r.input_redacted),
                _jsonb(r.output_redacted),
                r.input_tokens,
                r.output_tokens,
                r.latency_ms,
                r.overhead_ms,
                Jsonb(r.injection_scores),
            ),
        )

    async def list(self, tx: Tx, tenant_id: str, limit: int = 50) -> list[dict[str, Any]]:
        return await tx.fetch(
            'SELECT * FROM llm_calls WHERE tenant_id = %s ORDER BY created_at DESC LIMIT %s',
            (tenant_id, limit),
        )


class PgPurgeRepository:
    async def purge_tenant(self, tx: Tx) -> dict[str, int]:
        # The transaction is bound to the tenant, so RLS limits every DELETE to its rows.
        return {
            'llm_calls': await tx.execute(
                'DELETE FROM llm_calls WHERE tenant_id = current_tenant_id()'
            ),
            'budgets': await tx.execute(
                'DELETE FROM tenant_ai_budgets WHERE tenant_id = current_tenant_id()'
            ),
            'budget_settings': await tx.execute(
                'DELETE FROM tenant_ai_budget_settings WHERE tenant_id = current_tenant_id()'
            ),
        }


def as_json(value: Any) -> str:
    return json.dumps(value, default=lambda o: o.isoformat() if isinstance(o, datetime) else str(o))

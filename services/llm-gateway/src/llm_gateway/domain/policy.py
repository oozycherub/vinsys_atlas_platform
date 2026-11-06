"""Small pure policies: injection scoring, budgets, cache keys, failover, output validation."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from jsonschema import Draft202012Validator

# --- Prompt-injection heuristics (PRD §2.1 risk table). Scores are attached, never acted on
# here: the delimiters and output schemas are the defence; scores feed review queues.
_INJECTION_PATTERNS: tuple[tuple[re.Pattern[str], float], ...] = tuple(
    (re.compile(p, re.IGNORECASE), w)
    for p, w in (
        (
            r'\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|earlier)\b.{0,20}\b(instructions?|prompts?|rules?)',
            0.8,
        ),
        (r'\byou are now\b|\bact as\b|\bnew (instructions|persona)\b', 0.4),
        (r'\b(system|developer) (prompt|message|instructions?)\b', 0.4),
        (r'</?\s*(system|assistant|instructions?|document)\s*>', 0.6),
        (r'^\s*(assistant|system)\s*:', 0.5),
        (
            r'\b(rate|score|rank)\b.{0,30}\b(this|the) (candidate|applicant|resume|cv)\b.{0,30}\b(5|five|10|ten|highest|top|perfect)\b',
            0.7,
        ),
        (r'\b(reveal|print|output|repeat)\b.{0,30}\b(prompt|instructions|system)\b', 0.5),
        (r'[A-Za-z0-9+/]{120,}={0,2}', 0.2),  # long base64-like blobs
    )
)


def injection_score(text: str) -> float:
    """0..1, combining independent signals: 1 - Π(1 - w)."""
    remaining = 1.0
    for pattern, weight in _INJECTION_PATTERNS:
        if pattern.search(text):
            remaining *= 1 - weight
    return round(1 - remaining, 3)


# --- Budgets ---------------------------------------------------------------------------------

Resource = Literal['tokens', 'gpu_seconds']
Level = Literal['soft', 'hard']


@dataclass(frozen=True)
class BudgetLimits:
    monthly_tokens: int
    monthly_gpu_seconds: float
    soft_ratio: float = 0.8


@dataclass(frozen=True)
class BudgetUsage:
    tokens_used: int
    gpu_seconds_used: float
    soft_alerted: bool
    hard_alerted: bool


def period_of(now: datetime) -> str:
    return now.strftime('%Y-%m')


def exhausted(limits: BudgetLimits, usage: BudgetUsage, resource: Resource) -> bool:
    if resource == 'tokens':
        return usage.tokens_used >= limits.monthly_tokens
    return usage.gpu_seconds_used >= limits.monthly_gpu_seconds


def crossed(
    limits: BudgetLimits, before: BudgetUsage, after: BudgetUsage
) -> list[tuple[Level, Resource, float, float]]:
    """Thresholds crossed by this increment that have not been alerted yet this month."""
    events: list[tuple[Level, Resource, float, float]] = []
    pairs: tuple[tuple[Resource, float, float, float], ...] = (
        ('tokens', before.tokens_used, after.tokens_used, limits.monthly_tokens),
        (
            'gpu_seconds',
            before.gpu_seconds_used,
            after.gpu_seconds_used,
            limits.monthly_gpu_seconds,
        ),
    )
    for resource, old, new, limit in pairs:
        if limit <= 0:
            continue
        if not before.hard_alerted and old < limit <= new:
            events.append(('hard', resource, new, limit))
        elif not before.soft_alerted and old < limit * limits.soft_ratio <= new:
            events.append(('soft', resource, new, limit))
    return events


# --- Response cache ----------------------------------------------------------------------------


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def cache_key(
    tenant_id: str,
    prompt_ref: str,
    model_route: str,
    redacted_input: dict[str, Any],
    output_schema: Any,
) -> str:
    """The tenant is part of the key: one tenant can never be served another tenant's output."""
    material = canonical_json(
        {'t': tenant_id, 'p': prompt_ref, 'r': model_route, 'i': redacted_input, 's': output_schema}
    )
    return 'llm:cache:' + hashlib.sha256(material.encode('utf-8')).hexdigest()


# --- Failover ---------------------------------------------------------------------------------

Outcome = Literal['ok', 'unavailable', 'rejected', 'refused']


@dataclass(frozen=True)
class Attempt:
    provider: str
    model: str
    outcome: Outcome
    latency_ms: int
    detail: str = ''


def should_fail_over(outcome: Outcome) -> bool:
    """Only infrastructure failures move to the next target. A rejected request (400) would fail
    the same way anywhere; a refusal is handled by the provider's own fallback."""
    return outcome == 'unavailable'


# --- Structured outputs -------------------------------------------------------------------------


def schema_errors(schema: dict[str, Any], value: Any) -> list[str]:
    validator = Draft202012Validator(schema)
    return [
        f'{"/" + "/".join(str(p) for p in e.absolute_path) if e.absolute_path else "(root)"}: {e.message}'
        for e in sorted(validator.iter_errors(value), key=lambda e: list(e.absolute_path))
    ][:10]


def repair_instruction(errors: list[str]) -> str:
    return (
        'Your previous reply did not match the required JSON Schema. Problems:\n- '
        + '\n- '.join(errors)
        + '\nReply again with only a JSON value that matches the schema exactly.'
    )


def l2_normalise(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]

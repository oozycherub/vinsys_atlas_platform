"""Résumé-inferred proficiency (PRD §2.1(b) stage 9) and keyword-stuffing detection (§2.1(d)).

p_resume(s) = min(3.5, 1.0 + 1.2·tanh(years/4) + 0.6·recency + 0.4·[≥2 roles] + 0.3·[cert])
confidence  = min(0.6, 0.35 + 0.1·n_evidence_spans);  stuffing caps confidence at 0.2
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

RESUME_CAP = 3.5
STUFFED_CONFIDENCE = 0.2
#: p99 proxies (no population statistics yet): skill mentions per 100 words, and the share of
#: skills that no role or project supports when a résumé lists many.
STUFFING_DENSITY = 15.0
STUFFING_UNSUPPORTED_SHARE = 0.6
STUFFING_MIN_SKILLS = 25


@dataclass(frozen=True)
class SkillFacts:
    years_used: float | None
    last_used: str | None  # YYYY-MM
    roles: int  # distinct roles or projects that mention it
    certified: bool
    evidence_spans: int


def months_between(earlier: str, later: date) -> int:
    year, mon = (int(x) for x in earlier.split('-'))
    return (later.year - year) * 12 + (later.month - mon)


def recency(last_used: str | None, today: date) -> float:
    """1.0 if used in the last 12 months, falling linearly to 0 at 60 months."""
    if not last_used:
        return 0.0
    age = months_between(last_used, today)
    if age <= 12:
        return 1.0
    return max(0.0, 1.0 - (age - 12) / 48)


def proficiency(facts: SkillFacts, today: date) -> float:
    years = facts.years_used or 0.0
    value = (
        1.0
        + 1.2 * math.tanh(years / 4)
        + 0.6 * recency(facts.last_used, today)
        + 0.4 * (1 if facts.roles >= 2 else 0)
        + 0.3 * (1 if facts.certified else 0)
    )
    return round(min(RESUME_CAP, value), 2)


def confidence(facts: SkillFacts, stuffed: bool) -> float:
    value = min(0.6, 0.35 + 0.1 * facts.evidence_spans)
    return round(min(value, STUFFED_CONFIDENCE) if stuffed else value, 2)


def is_stuffed(word_count: int, skill_mentions: int, skills: int, unsupported: int) -> bool:
    density = 100 * skill_mentions / max(1, word_count)
    if density > STUFFING_DENSITY:
        return True
    return skills >= STUFFING_MIN_SKILLS and unsupported / skills > STUFFING_UNSUPPORTED_SHARE

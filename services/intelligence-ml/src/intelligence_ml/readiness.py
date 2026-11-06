"""Gap and readiness (PRD §2.5(iii)), the same formula as intelligence-svc's domain/readiness.ts;
both pass packages/contracts/fixtures/readiness-golden.json (ADR-0009 §4).

    gap_s          = max(0, p_req(s) - p(s))
    role_gap%(e,j) = Σ_s w_s·gap_s / Σ_s w_s·p_req(s)   → High > 50%, Medium 20-50%, Low < 20%
    readiness(e,j) = 1 - role_gap%(e,j)
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

Band = Literal['high', 'medium', 'low']


@dataclass(frozen=True)
class Gap:
    skill_id: str
    weight: float
    required: float
    proficiency: float
    gap: float


@dataclass(frozen=True)
class Readiness:
    role_gap_pct: float
    readiness: float
    band: Band
    gaps: tuple[Gap, ...]


def gap_band(role_gap_pct: float) -> Band:
    if role_gap_pct > 0.5:
        return 'high'
    if role_gap_pct >= 0.2:
        return 'medium'
    return 'low'


def readiness(requirements: Sequence[Mapping[str, Any]], skills: Mapping[str, float]) -> Readiness:
    gap_sum = req_sum = 0.0
    gaps: list[Gap] = []
    for r in requirements:
        sid = str(r['skill_id'])
        w = float(r['weight'])
        target = float(r['target_proficiency'])
        p = float(skills.get(sid, 0.0))
        g = max(0.0, target - p)
        gap_sum += w * g
        req_sum += w * target
        gaps.append(Gap(sid, w, target, p, g))
    pct = min(1.0, gap_sum / req_sum) if req_sum > 0 else 0.0
    return Readiness(pct, 1 - pct, gap_band(pct), tuple(gaps))


@dataclass(frozen=True)
class LearningItem:
    item_id: str
    title: str
    skill_ids: tuple[str, ...]
    duration_hours: float


@dataclass(frozen=True)
class LearningPlan:
    items: tuple[LearningItem, ...]
    hours: float
    uncovered: tuple[str, ...]


def learning_plan(gaps: Sequence[Gap], catalogue: Sequence[LearningItem]) -> LearningPlan:
    """Greedy weighted set cover, as intelligence-svc's career paths do: repeatedly the item with
    the most uncovered w·gap per hour. Skills no item teaches stay uncovered."""
    open_ = {g.skill_id: g.weight * g.gap for g in gaps if g.gap > 0}
    pool = list(catalogue)
    chosen: list[LearningItem] = []
    while open_:
        best: tuple[float, LearningItem] | None = None
        for item in pool:
            covered = sum(open_.get(s, 0.0) for s in item.skill_ids)
            value = covered / item.duration_hours
            if covered > 0 and (best is None or value > best[0]):
                best = (value, item)
        if best is None:
            break
        chosen.append(best[1])
        pool.remove(best[1])
        for s in best[1].skill_ids:
            open_.pop(s, None)
    return LearningPlan(tuple(chosen), sum(i.duration_hours for i in chosen), tuple(open_))

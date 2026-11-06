"""Attrition features (PRD §2.5(vi)), computed as of a date from the HR roster and marketplace
activity. Protected attributes are never features; candidate features that act as proxies for
one (mutual information > 0.1 bit against any audit attribute) are dropped (§4.1, ADR-0009 §6).

The same features are declared for Feast in feature_repo/ (optional extra); here they are
computed in SQL and Python so the pipeline needs no feature server.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import numpy as np
from sklearn.metrics import mutual_info_score

# Never a feature, under any name (the feature-list check refuses them).
PROTECTED = frozenset(
    {
        'age',
        'gender',
        'sex',
        'ethnicity',
        'race',
        'marital_status',
        'disability',
        'nationality',
        'religion',
    }
)
MI_PROXY_LIMIT = 0.1  # bits
MI_BINS = 5


@dataclass(frozen=True)
class Feature:
    name: str
    phrase: str  # how a driver reads to an HRBP; {v} is the value


FEATURES: tuple[Feature, ...] = (
    Feature('tenure_months', 'Tenure of {v:.0f} months'),
    Feature('months_since_promotion', 'No promotion in {v:.0f} months'),
    Feature('months_in_role', '{v:.0f} months in the same role'),
    Feature('compa_ratio', 'Pay at {v:.0%} of the band midpoint'),
    Feature('manager_changed_6m', 'Manager changed in the last 6 months'),
    Feature('team_attrition_6m', '{v:.0%} of their team left in 6 months'),
    Feature('peer_exits_6m', '{v:.0f} peers in the department left in 6 months'),
    Feature('skill_gap', 'Role skill gap of {v:.0%}'),
    Feature('skill_gap_trend', 'Skill gap changed by {v:+.0%} in 6 months'),
    Feature('internal_applications_6m', '{v:.0f} internal applications in 6 months'),
    Feature('marketplace_rejections_6m', '{v:.0f} marketplace rejections in 6 months'),
    Feature('engagement_delta', 'Engagement score changed by {v:+.1f}'),
    Feature('overtime_hours_4w', '{v:.0f} overtime hours in 4 weeks'),
)
FEATURE_NAMES = tuple(f.name for f in FEATURES)
PHRASES = {f.name: f.phrase for f in FEATURES}


class ProtectedFeatureError(ValueError):
    """A protected attribute was offered as a model feature."""


def assert_no_protected(names: Sequence[str]) -> None:
    # Whole words: "age_band" and "gender" are refused, "manager_changed_6m" is not.
    bad = sorted(
        n
        for n in names
        if n.lower() in PROTECTED or PROTECTED & set(n.lower().replace('-', '_').split('_'))
    )
    if bad:
        raise ProtectedFeatureError(f'protected attributes cannot be features: {", ".join(bad)}')


def phrase(name: str, value: float) -> str:
    template = PHRASES.get(name, name)
    try:
        return template.format(v=value)
    except (ValueError, TypeError):
        return template


def _months(a: date | None, b: date) -> float | None:
    if a is None:
        return None
    return max(0.0, (b - a).days / 30.4375)


def compute(
    as_of: date,
    employee: Mapping[str, Any],
    *,
    team: Sequence[Mapping[str, Any]],
    department: Sequence[Mapping[str, Any]],
    skill_gap: float | None,
    skill_gap_6m_ago: float | None,
    applications_6m: int,
    rejections_6m: int,
) -> dict[str, float | None]:
    """One employee's features as of a date. `team` (same manager) and `department` are the
    other employees' roster rows, including leavers."""
    six = as_of - timedelta(days=182)

    def left_voluntarily(r: Mapping[str, Any]) -> bool:
        t = r.get('terminated_at')
        return bool(r.get('termination_voluntary')) and t is not None and six < t <= as_of

    hired = employee.get('hired_at')
    team_exits = sum(1 for r in team if left_voluntarily(r))
    team_size = len(team)
    changed = employee.get('manager_changed_at')
    return {
        'tenure_months': _months(hired, as_of),
        'months_since_promotion': _months(employee.get('last_promotion_at') or hired, as_of),
        'months_in_role': _months(employee.get('role_started_at') or hired, as_of),
        'compa_ratio': None
        if employee.get('compa_ratio') is None
        else float(employee['compa_ratio']),
        'manager_changed_6m': 1.0 if changed is not None and six < changed <= as_of else 0.0,
        'team_attrition_6m': team_exits / team_size if team_size else 0.0,
        'peer_exits_6m': float(sum(1 for r in department if left_voluntarily(r))),
        'skill_gap': skill_gap,
        'skill_gap_trend': None
        if skill_gap is None or skill_gap_6m_ago is None
        else skill_gap - skill_gap_6m_ago,
        'internal_applications_6m': float(applications_6m),
        'marketplace_rejections_6m': float(rejections_6m),
        'engagement_delta': None
        if employee.get('engagement_delta') is None
        else float(employee['engagement_delta']),
        'overtime_hours_4w': None
        if employee.get('overtime_hours_4w') is None
        else float(employee['overtime_hours_4w']),
    }


def _bins(values: np.ndarray, bins: int = MI_BINS) -> np.ndarray:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return np.zeros(values.shape, dtype=int)
    edges = np.unique(np.quantile(finite, np.linspace(0, 1, bins + 1)[1:-1]))
    out: np.ndarray = np.digitize(np.nan_to_num(values, nan=-np.inf), edges)
    out[~np.isfinite(values)] = -1  # missing is its own bin
    return out


def proxy_report(
    X: np.ndarray, names: Sequence[str], protected: Mapping[str, Sequence[str | None]]
) -> dict[str, dict[str, float]]:
    """Mutual information (bits) of every feature with every supplied protected attribute."""
    report: dict[str, dict[str, float]] = {}
    for j, name in enumerate(names):
        binned = _bins(X[:, j].astype(float))
        for attr, values in protected.items():
            mask = np.array([v is not None for v in values])
            if mask.sum() < 20:
                continue
            mi = mutual_info_score(
                np.asarray(values, dtype=object)[mask].astype(str), binned[mask]
            ) / np.log(2)
            report.setdefault(name, {})[attr] = round(float(mi), 4)
    return report


def select(
    names: Sequence[str], report: Mapping[str, Mapping[str, float]], limit: float = MI_PROXY_LIMIT
) -> tuple[list[str], dict[str, dict[str, float]]]:
    """Features kept, and those dropped as proxies (with the offending MI values)."""
    assert_no_protected(names)
    dropped = {
        n: {a: v for a, v in report.get(n, {}).items() if v > limit}
        for n in names
        if any(v > limit for v in report.get(n, {}).values())
    }
    return [n for n in names if n not in dropped], dropped

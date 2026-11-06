"""Synthetic workforces for tests and the evaluation report. Nothing here is real HR data.

Exit risk rises with time since promotion, team attrition, a recent manager change and pay
below the band; a protected attribute ("gender") is drawn independently of all of it, so a fair
model should flag both groups at similar rates.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import numpy as np


@dataclass(frozen=True)
class FeatureSet:
    rows: list[dict[str, float | None]]
    y: np.ndarray
    order: np.ndarray
    audit: dict[str, list[str | None]]


def _risk(
    months_since_promotion: float, team_attrition: float, manager_changed: float, compa: float
) -> float:
    z = (
        -4.6
        + 0.08 * months_since_promotion
        + 4.0 * team_attrition
        + 1.6 * manager_changed
        - 4.0 * (compa - 1.0)
    )
    return 1 / (1 + math.exp(-z))


def features(n: int, snapshots: int = 6, seed: int = 7, proxy: bool = False) -> FeatureSet:
    """Feature rows directly (no database): `n` employees by `snapshots` monthly snapshots."""
    rng = np.random.default_rng(seed)
    rows: list[dict[str, float | None]] = []
    ys: list[int] = []
    order: list[int] = []
    gender: list[str | None] = []
    base = date(2024, 1, 1).toordinal()
    for i in range(n):
        g = 'f' if rng.random() < 0.5 else 'm'
        tenure0 = float(rng.uniform(3, 120))
        promo0 = float(rng.uniform(0, min(tenure0, 60)))
        compa = float(rng.normal(1.0, 0.12))
        for s in range(snapshots):
            team = float(rng.beta(1.2, 8))
            changed = 1.0 if rng.random() < 0.15 else 0.0
            msp = promo0 + s
            p = _risk(msp, team, changed, compa)
            rows.append(
                {
                    'tenure_months': tenure0 + s,
                    'months_since_promotion': msp,
                    'months_in_role': msp,
                    'compa_ratio': compa,
                    'manager_changed_6m': changed,
                    'team_attrition_6m': team,
                    'peer_exits_6m': float(rng.poisson(1 + 4 * team)),
                    'skill_gap': float(rng.uniform(0, 0.6)),
                    'skill_gap_trend': float(rng.normal(0, 0.05)),
                    'internal_applications_6m': float(rng.poisson(0.5)),
                    'marketplace_rejections_6m': float(rng.poisson(0.2)),
                    # A proxy for the protected attribute when asked (the MI check must drop it).
                    'engagement_delta': (1.5 if g == 'f' else -1.5) + float(rng.normal(0, 0.2))
                    if proxy
                    else float(rng.normal(0, 1)),
                    'overtime_hours_4w': float(rng.gamma(2, 4)),
                }
            )
            ys.append(1 if rng.random() < p else 0)
            order.append(base + 30 * s + i % 30)
            gender.append(g)
    return FeatureSet(rows, np.array(ys), np.array(order), {'gender': gender})


def roster(n: int, as_of: date, seed: int = 11) -> list[dict[str, Any]]:
    """HR roster rows with history (hires, promotions, manager changes, exits) for the pipeline:
    voluntary exits are drawn monthly from the same risk shape."""
    rng = np.random.default_rng(seed)
    out: list[dict[str, Any]] = []
    managers = [f'mgr-{k}' for k in range(max(1, n // 12))]
    start = as_of - timedelta(days=24 * 30)
    for i in range(n):
        hired = start - timedelta(days=int(rng.uniform(0, 1500)))
        promoted = hired + timedelta(days=int(rng.uniform(0, max(1, (start - hired).days))))
        compa = round(float(rng.normal(1.0, 0.12)), 3)
        changed = start + timedelta(days=int(rng.uniform(0, 700))) if rng.random() < 0.3 else None
        terminated: date | None = None
        voluntary: bool | None = None
        day = start
        while day < as_of:
            msp = (day - promoted).days / 30.4
            chg = 1.0 if changed is not None and 0 <= (day - changed).days < 182 else 0.0
            if rng.random() < _risk(msp, 0.1, chg, compa) / 9:  # monthly hazard
                terminated, voluntary = day, bool(rng.random() < 0.85)
                break
            day += timedelta(days=30)
        out.append(
            {
                'employee_id': f'0192f0c1-0000-7000-8000-{i:012x}',
                'manager_user_id': managers[i % len(managers)],
                'department': ['finance', 'risk', 'ops', 'tech'][i % 4],
                'hired_at': hired,
                'role_started_at': promoted,
                'last_promotion_at': promoted,
                'manager_changed_at': changed,
                'compa_ratio': compa,
                'status': 'terminated' if terminated else 'active',
                'terminated_at': terminated,
                'termination_voluntary': voluntary,
                'gender': 'f' if rng.random() < 0.5 else 'm',
            }
        )
    return out

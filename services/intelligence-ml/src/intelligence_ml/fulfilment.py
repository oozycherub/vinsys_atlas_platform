"""Fulfilment plans (PRD §2.5(iv), ADR-0009 §5): assign employees to demand slots with OR-Tools
CP-SAT, then classify every slot.

    maximise   Σ 1000·readiness(e,d)·tenure(e)·x[e,d]
    subject to Σ_e x[e,d] ≤ headcount(d)                          (each slot one employee)
               load_e(t) + Σ_d alloc(d)·x[e,d]·[t ∈ d] ≤ 100       (every start date t)
               x[e,d] = 0 unless the pair is redeployable or upskillable

    redeploy  readiness ≥ 0.75 (availability is guaranteed by the capacity constraint)
    upskill   readiness ∈ [0.5, 0.75) and the learning for the gap fits before the start date
    recruit   every slot left unassigned

The solver is time-limited and keeps the best solution found (FEASIBLE when the limit hits).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from ortools.sat.python import cp_model

from intelligence_ml.readiness import LearningItem, learning_plan, readiness

REDEPLOY_AT = 0.75
UPSKILL_AT = 0.5
TENURE_PENALTY = 0.3
SCALE = 1000

Classification = Literal['redeploy', 'upskill', 'recruit']


@dataclass(frozen=True)
class Demand:
    demand_id: str
    title: str
    skills: tuple[Mapping[str, Any], ...]
    headcount: int
    allocation_pct: int
    start: date
    end: date | None  # inclusive
    account_id: str | None = None
    job_profile_id: str | None = None
    location: str | None = None

    def covers(self, day: date) -> bool:
        return self.start <= day and (self.end is None or day <= self.end)


@dataclass(frozen=True)
class Booking:
    percent: int
    start: date
    end: date | None  # exclusive


@dataclass(frozen=True)
class Candidate:
    employee_id: str
    skills: Mapping[str, float]
    bookings: tuple[Booking, ...] = ()
    tenure_in_role_months: int | None = None
    min_tenure_months: int = 12


@dataclass(frozen=True)
class Line:
    demand_id: str
    slot: int
    classification: Classification
    employee_id: str | None
    readiness: float | None
    learning_hours: float | None
    days_until_start: int
    explanation: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Plan:
    lines: tuple[Line, ...]
    status: str
    objective: float
    summary: dict[str, Any]


def load_at(bookings: Sequence[Booking], day: date) -> int:
    return sum(b.percent for b in bookings if b.start <= day and (b.end is None or day < b.end))


@dataclass(frozen=True)
class _Pair:
    readiness: float
    weight: int
    kind: Literal['redeploy', 'upskill']
    hours: float
    items: tuple[str, ...]


def _pair(
    e: Candidate,
    d: Demand,
    catalogue: Sequence[LearningItem],
    hours_per_day: float,
    today: date,
) -> _Pair | None:
    fit = readiness(d.skills, e.skills)
    tenure = (
        1 - TENURE_PENALTY
        if e.tenure_in_role_months is not None and e.tenure_in_role_months < e.min_tenure_months
        else 1.0
    )
    weight = max(1, round(SCALE * fit.readiness * tenure))
    if fit.readiness >= REDEPLOY_AT:
        return _Pair(fit.readiness, weight, 'redeploy', 0.0, ())
    if fit.readiness < UPSKILL_AT:
        return None
    plan = learning_plan(fit.gaps, catalogue)
    days = (d.start - today).days
    if plan.uncovered or days <= 0 or plan.hours / hours_per_day > days:
        return None
    return _Pair(fit.readiness, weight, 'upskill', plan.hours, tuple(i.item_id for i in plan.items))


def solve(
    demands: Sequence[Demand],
    candidates: Sequence[Candidate],
    catalogue: Sequence[LearningItem],
    *,
    today: date,
    hours_per_day: float = 1.0,
    time_limit_s: float = 600.0,
    workers: int = 8,
) -> Plan:
    model = cp_model.CpModel()
    pairs: dict[tuple[int, int], _Pair] = {}
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    for di, d in enumerate(demands):
        for ei, e in enumerate(candidates):
            p = _pair(e, d, catalogue, hours_per_day, today)
            if p is None:
                continue
            # The employee must have room for this demand on every day it runs, before others.
            points = {d.start} | {b.start for b in e.bookings if d.covers(b.start)}
            if any(load_at(e.bookings, t) + d.allocation_pct > 100 for t in points):
                continue
            pairs[(ei, di)] = p
            x[(ei, di)] = model.new_bool_var(f'x_{ei}_{di}')
    for di, d in enumerate(demands):
        assigned = [v for (ei, dj), v in x.items() if dj == di]
        if assigned:
            model.add(sum(assigned) <= d.headcount)
    for ei, e in enumerate(candidates):
        mine = [(di, v) for (ej, di), v in x.items() if ej == ei]
        if len(mine) < 2:
            continue
        points = {demands[di].start for di, _ in mine} | {b.start for b in e.bookings}
        for t in sorted(points):
            covering = [(demands[di].allocation_pct, v) for di, v in mine if demands[di].covers(t)]
            if len(covering) < 2:
                continue  # one demand alone was checked when the pair was admitted
            model.add(sum(pct * v for pct, v in covering) <= 100 - load_at(e.bookings, t))
    model.maximize(sum(pairs[k].weight * v for k, v in x.items()))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_s
    solver.parameters.num_search_workers = workers
    solver.parameters.random_seed = 7
    code = solver.solve(model)
    status = solver.status_name(code)
    solved = code in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    lines: list[Line] = []
    for di, d in enumerate(demands):
        days = (d.start - today).days
        chosen = sorted(
            (
                (pairs[(ei, dj)], candidates[ei].employee_id)
                for (ei, dj), v in x.items()
                if dj == di and solved and solver.value(v) == 1
            ),
            key=lambda pe: (-pe[0].readiness, pe[1]),
        )
        for slot in range(1, d.headcount + 1):
            if slot <= len(chosen):
                p, employee_id = chosen[slot - 1]
                lines.append(
                    Line(
                        d.demand_id,
                        slot,
                        p.kind,
                        employee_id,
                        round(p.readiness, 4),
                        p.hours if p.kind == 'upskill' else None,
                        days,
                        {'learning_items': list(p.items)} if p.items else {},
                    )
                )
            else:
                lines.append(
                    Line(
                        d.demand_id,
                        slot,
                        'recruit',
                        None,
                        None,
                        None,
                        days,
                        {'reason': 'no internal fit'},
                    )
                )
    counts = {
        c: sum(1 for li in lines if li.classification == c)
        for c in ('redeploy', 'upskill', 'recruit')
    }
    objective = solver.objective_value if solved and x else 0.0
    return Plan(
        tuple(lines),
        status if x else 'NO_CANDIDATES',
        float(objective) / SCALE if not math.isnan(objective) else 0.0,
        {
            **counts,
            'demands': len(demands),
            'candidates': len(candidates),
            'pairs': len(x),
            'wall_time_s': round(solver.wall_time, 3),
        },
    )


def horizon_end(today: date, horizon_days: int) -> date:
    return today + timedelta(days=horizon_days)

"""Readiness parity with TypeScript, and the fulfilment classification on golden scenarios."""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

import pytest

from intelligence_ml.fulfilment import Booking, Candidate, Demand, load_at, solve
from intelligence_ml.readiness import Gap, LearningItem, gap_band, learning_plan, readiness
from tests.conftest import FIXTURES, req

TODAY = date(2026, 11, 6)
A, B, C = 'a', 'b', 'c'


@pytest.mark.parametrize(
    'case',
    json.loads((FIXTURES / 'readiness-golden.json').read_text())['cases'],
    ids=lambda c: c['name'],
)
def test_readiness_matches_the_shared_golden_file(case: dict) -> None:  # type: ignore[type-arg]
    r = readiness(case['requirements'], case['skills'])
    assert r.role_gap_pct == pytest.approx(case['role_gap_pct'], abs=1e-6)
    assert r.readiness == pytest.approx(case['readiness'], abs=1e-6)
    assert r.band == case['band']
    assert {g.skill_id: g.gap for g in r.gaps} == pytest.approx(case['gaps'])


def test_bands_and_learning_cover() -> None:
    assert (gap_band(0.51), gap_band(0.5), gap_band(0.2), gap_band(0.19)) == (
        'high',
        'medium',
        'medium',
        'low',
    )
    gaps = [Gap(A, 1, 4, 2, 2), Gap(B, 0.5, 3, 1, 2), Gap(C, 1, 2, 2, 0)]
    catalogue = [
        LearningItem('big', 'Both', (A, B), 20),
        LearningItem('a', 'A only', (A,), 4),
        LearningItem('b', 'B only', (B,), 30),
        LearningItem('x', 'Unrelated', ('z',), 1),
    ]
    plan = learning_plan(gaps, catalogue)
    # 'a' covers 2 per 4 h (0.5/h) beats 'big' 3 per 20 h; then 'big' (B left: 1 per 20 h) beats 'b'.
    assert [i.item_id for i in plan.items] == ['a', 'big']
    assert plan.hours == 24
    assert plan.uncovered == ()
    assert learning_plan(gaps, [LearningItem('a', 'A', (A,), 4)]).uncovered == (B,)


def d(
    demand_id: str,
    *reqs: dict[str, Any],
    headcount: int = 1,
    start_in: int = 30,
    alloc: int = 100,
    days: int | None = None,
) -> Demand:
    start = TODAY + timedelta(days=start_in)
    return Demand(
        demand_id,
        demand_id,
        tuple(reqs),
        headcount,
        alloc,
        start,
        start + timedelta(days=days) if days else None,
    )


def e(
    employee_id: str, levels: dict[str, float], *bookings: Booking, tenure: int | None = None
) -> Candidate:
    return Candidate(employee_id, levels, tuple(bookings), tenure)


CATALOGUE = [LearningItem('course-a', 'A course', (A,), 10)]


def classes(plan, demand_id: str) -> list[tuple[str, str | None]]:  # type: ignore[no-untyped-def]
    return [(li.classification, li.employee_id) for li in plan.lines if li.demand_id == demand_id]


def test_golden_redeploy_upskill_recruit() -> None:
    plan = solve(
        [d('ready', req(A, 4)), d('stretch', req(A, 4), req(B, 4)), d('far', req(C, 5))],
        [e('e1', {A: 4}), e('e2', {A: 2, B: 4}), e('e3', {C: 1})],
        CATALOGUE,
        today=TODAY,
    )
    assert classes(plan, 'ready') == [('redeploy', 'e1')]
    # e2 is 0.75 ready for 'stretch' (gap 2 of 8): exactly the redeploy threshold.
    assert classes(plan, 'stretch') == [('redeploy', 'e2')]
    assert classes(plan, 'far') == [('recruit', None)]  # 0.2 ready: below upskill
    assert plan.summary['redeploy'] == 2
    assert plan.status in ('OPTIMAL', 'FEASIBLE')


def test_upskill_needs_learning_that_fits_before_the_start() -> None:
    demands = [d('soon', req(A, 4), start_in=5), d('later', req(A, 4), start_in=30)]
    people = [e('learner', {A: 2.4})]  # readiness 0.6
    plan = solve(demands, people, CATALOGUE, today=TODAY, hours_per_day=1)
    # 10 h of learning at 1 h/day: 5 days is too short, 30 days is enough.
    assert classes(plan, 'soon') == [('recruit', None)]
    assert classes(plan, 'later') == [('upskill', 'learner')]
    line = next(li for li in plan.lines if li.demand_id == 'later')
    assert (line.learning_hours, line.explanation) == (10, {'learning_items': ['course-a']})
    # A gap no catalogue item teaches cannot be upskilled.
    blocked = solve([d('later', req(B, 4))], [e('learner', {B: 2.4})], CATALOGUE, today=TODAY)
    assert classes(blocked, 'later') == [('recruit', None)]
    started = solve([d('now', req(A, 4), start_in=0)], people, CATALOGUE, today=TODAY)
    assert classes(started, 'now') == [('recruit', None)]


def test_existing_bookings_limit_availability() -> None:
    busy = Booking(60, TODAY, TODAY + timedelta(days=90))
    plan = solve(
        [d('half', req(A, 4), alloc=50)],
        [e('busy', {A: 5}, busy), e('free', {A: 3.5})],
        CATALOGUE,
        today=TODAY,
    )
    assert classes(plan, 'half') == [('redeploy', 'free')]  # the better fit is 60% booked
    assert load_at([busy], TODAY + timedelta(days=89)) == 60
    assert load_at([busy], TODAY + timedelta(days=90)) == 0  # end is exclusive


def test_capacity_across_overlapping_demands() -> None:
    one = e('star', {A: 5})
    overlapping = solve(
        [d('x', req(A, 4), alloc=60, days=60), d('y', req(A, 4), alloc=60, start_in=40, days=60)],
        [one, e('ok', {A: 3})],
        CATALOGUE,
        today=TODAY,
    )
    assigned = [li.employee_id for li in overlapping.lines if li.employee_id]
    assert sorted(assigned) == ['ok', 'star']  # the star cannot take both (120% from day 40)
    disjoint = solve(
        [d('x', req(A, 4), alloc=60, days=30), d('y', req(A, 4), alloc=60, start_in=80, days=30)],
        [one],
        CATALOGUE,
        today=TODAY,
    )
    assert [li.employee_id for li in disjoint.lines] == ['star', 'star']
    small = solve(
        [d('x', req(A, 4), alloc=40, days=60), d('y', req(A, 4), alloc=40, start_in=40, days=60)],
        [one],
        CATALOGUE,
        today=TODAY,
    )
    assert [li.employee_id for li in small.lines] == ['star', 'star']  # 80% fits


def test_headcount_slots_and_tenure() -> None:
    plan = solve(
        [d('team', req(A, 4), headcount=3)],
        [e('p', {A: 4}), e('q', {A: 3.6}), e('far', {A: 0.5})],
        CATALOGUE,
        today=TODAY,
    )
    assert [(li.slot, li.classification, li.employee_id) for li in plan.lines] == [
        (1, 'redeploy', 'p'),
        (2, 'redeploy', 'q'),
        (3, 'recruit', None),
    ]
    # Equal fit: the employee past the minimum tenure wins (the soft policy factor).
    tenure = solve(
        [d('one', req(A, 4))],
        [e('new', {A: 4}, tenure=3), e('settled', {A: 4}, tenure=24)],
        CATALOGUE,
        today=TODAY,
    )
    assert classes(tenure, 'one') == [('redeploy', 'settled')]


def test_no_candidates_and_time_limits() -> None:
    empty = solve([d('x', req(A, 4), headcount=2)], [], CATALOGUE, today=TODAY)
    assert empty.status == 'NO_CANDIDATES'
    assert [li.classification for li in empty.lines] == ['recruit', 'recruit']
    big = solve(
        [
            d(f'd{i}', req(A, 3 + (i % 3)), headcount=2, alloc=50, start_in=10 + i, days=40)
            for i in range(25)
        ],
        [e(f'e{i}', {A: 2.5 + (i % 5) * 0.6}) for i in range(40)],
        CATALOGUE,
        today=TODAY,
        time_limit_s=0.5,
    )
    assert big.status in ('OPTIMAL', 'FEASIBLE')
    assert len(big.lines) == 50
    demands = {
        f'd{i}': d(f'd{i}', req(A, 3 + (i % 3)), headcount=2, alloc=50, start_in=10 + i, days=40)
        for i in range(25)
    }
    assert any(li.employee_id for li in big.lines)
    for emp in {li.employee_id for li in big.lines if li.employee_id}:
        mine = [demands[li.demand_id] for li in big.lines if li.employee_id == emp]
        for day in (x.start for x in mine):  # the load peaks at a start date
            assert sum(x.allocation_pct for x in mine if x.covers(day)) <= 100, emp
    # An employee fills at most one slot of a demand.
    pairs = [(li.demand_id, li.employee_id) for li in big.lines if li.employee_id]
    assert len(pairs) == len(set(pairs))


def test_thresholds_learning_time_and_tenure_are_exact() -> None:
    lots = [LearningItem('course-a', 'A course', (A,), 1)]
    # Just under redeploy (0.725): upskill, never redeploy.
    near = solve([d('x', req(A, 4))], [e('near', {A: 2.9})], lots, today=TODAY)
    assert classes(near, 'x') == [('upskill', 'near')]
    # Just under upskill (0.45): recruit.
    low = solve([d('x', req(A, 4))], [e('low', {A: 1.8})], lots, today=TODAY)
    assert classes(low, 'x') == [('recruit', None)]
    # Learning that cannot fit before the start is not an upskill, whatever else is open.
    short = solve(
        [d('soon', req(A, 4), start_in=5)], [e('learner', {A: 2.4})], CATALOGUE, today=TODAY
    )
    assert classes(short, 'soon') == [('recruit', None)]
    # The tenure penalty outweighs a small readiness edge.
    tenure = solve(
        [d('one', req(A, 4))],
        [e('new', {A: 4}, tenure=3), e('settled', {A: 3.8}, tenure=24)],
        CATALOGUE,
        today=TODAY,
    )
    assert classes(tenure, 'one') == [('redeploy', 'settled')]

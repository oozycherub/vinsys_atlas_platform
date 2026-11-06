"""The fulfilment-plan worker against Postgres: claim, lease, lines, and the recruit event."""

from __future__ import annotations

import json
import os
from datetime import date, timedelta

import pytest
from atlas_platform.db import PgDatabase

from intelligence_ml.plans import MAX_ATTEMPTS, PlanWorker
from tests.conftest import FIXTURES, demand, employee, req, skills, uid

TODAY = date(2026, 11, 6)


async def queue(
    db: PgDatabase, tenant_id: str, account: str | None = None, horizon: int = 90
) -> str:
    plan_id = uid()
    async with db.tenant_tx(tenant_id) as tx:
        await tx.execute(
            """INSERT INTO fulfilment_plans (tenant_id, plan_id, account_id, horizon_days, requested_by)
               VALUES (%s, %s, %s, %s, 'mgr')""",
            (tenant_id, plan_id, account, horizon),
        )
    return plan_id


async def plan_row(db: PgDatabase, tenant_id: str, plan_id: str) -> dict:  # type: ignore[type-arg]
    async with db.tenant_tx(tenant_id) as tx:
        rows = await tx.fetch(
            'SELECT status, solver_status, summary, error, attempts FROM fulfilment_plans WHERE plan_id = %s',
            (plan_id,),
        )
    return rows[0]


async def drain(db: PgDatabase) -> None:
    """Earlier tests may have left plans queued in other tenants: finish them first."""
    w = PlanWorker(db, 'drain', today=TODAY, time_limit_s=1)
    while await w.run_once() is not None:
        pass


async def test_a_queued_plan_is_solved_and_recruit_demand_is_announced(
    db: PgDatabase, tenant: str
) -> None:
    await drain(db)
    skill_a, skill_b = uid(), uid()
    e1, e2 = uid(), uid()
    await employee(db, tenant, e1, role_started_at=TODAY - timedelta(days=400))
    await employee(db, tenant, e2, role_started_at=TODAY - timedelta(days=400))
    await skills(db, tenant, e1, {skill_a: 4.0})
    await skills(db, tenant, e2, {skill_a: 2.5, skill_b: 1.0})
    async with db.tenant_tx(tenant) as tx:
        await tx.execute(
            """INSERT INTO projects (tenant_id, project_id, name, start_date, created_by) VALUES (%s, %s, 'P', %s, 'x')""",
            (tenant, (project := uid()), TODAY),
        )
        await tx.execute(
            """INSERT INTO project_allocations (tenant_id, allocation_id, project_id, employee_id, percent, during,
                 source, created_by) VALUES (%s, %s, %s, %s, 30, daterange(%s, NULL), 'manual', 'x')""",
            (tenant, uid(), project, e2, TODAY),
        )
    ready = await demand(
        db,
        tenant,
        title='Analyst',
        skills_=[req(skill_a, 4)],
        start=TODAY + timedelta(days=20),
        account='acme',
    )
    hard = await demand(
        db,
        tenant,
        title='Quant',
        skills_=[req(skill_b, 5)],
        start=TODAY + timedelta(days=20),
        headcount=2,
        account='acme',
    )
    other = await demand(
        db,
        tenant,
        title='Elsewhere',
        skills_=[req(skill_a, 4)],
        start=TODAY + timedelta(days=20),
        account='globex',
    )
    late = await demand(
        db,
        tenant,
        title='Next year',
        skills_=[req(skill_a, 4)],
        start=TODAY + timedelta(days=200),
        account='acme',
    )
    plan_id = await queue(db, tenant, account='acme')
    worker = PlanWorker(db, 'w1', today=TODAY, time_limit_s=5)
    assert await worker.run_once() == plan_id
    row = await plan_row(db, tenant, plan_id)
    assert (row['status'], row['solver_status']) == ('done', 'OPTIMAL')
    assert row['summary']['redeploy'] == 1
    assert row['summary']['recruit'] == 2
    async with db.tenant_tx(tenant) as tx:
        lines = await tx.fetch(
            'SELECT demand_id::text, slot, classification, employee_id::text FROM fulfilment_plan_lines WHERE plan_id = %s ORDER BY demand_id, slot',
            (plan_id,),
        )
        events = await tx.fetch(
            "SELECT payload FROM outbox_events WHERE topic = 'intel.demand.recruit_required.v1' ORDER BY created_at"
        )
    by_demand = {
        (r['demand_id'], r['slot']): (r['classification'], r['employee_id']) for r in lines
    }
    assert by_demand[(ready, 1)] == ('redeploy', e1)
    assert by_demand[(hard, 1)] == by_demand[(hard, 2)] == ('recruit', None)
    assert {r['demand_id'] for r in lines} == {ready, hard}  # account and horizon filters
    assert other not in {r['demand_id'] for r in lines}
    assert late not in {r['demand_id'] for r in lines}
    assert len(events) == 1
    payload = events[0]['payload']
    assert (payload['demand_id'], payload['headcount'], payload['account_id']) == (hard, 2, 'acme')
    # The recorded contract (packages/contracts/fixtures), which matching-svc replays.
    values = {'tenant_id': tenant, 'demand_id': hard, 'plan_id': plan_id, 'skill_id': skill_b}
    recorded = {**payload, 'occurred_at': '{{occurred_at}}', 'start_date': '{{start_date}}'}
    for k in ('tenant_id', 'demand_id', 'plan_id'):
        recorded[k] = '{{' + k + '}}'
    recorded['skills'] = [{**s, 'skill_id': '{{skill_id}}'} for s in payload['skills']]
    assert values['skill_id'] == payload['skills'][0]['skill_id']
    doc = {'payload': dict(sorted(recorded.items())), 'topic': 'intel.demand.recruit_required.v1'}
    path = FIXTURES / 'intel.demand.recruit_required.v1.json'
    if os.environ.get('ATLAS_UPDATE_FIXTURES') == '1':
        path.write_text(json.dumps(doc, indent=2) + '\n')
    assert json.loads(path.read_text()) == doc, f'{path.name} is stale'
    assert await worker.run_once() is None  # the queue is empty


async def test_leases_and_retries(db: PgDatabase, tenant: str) -> None:
    await drain(db)
    plan_id = await queue(db, tenant)
    a, b = PlanWorker(db, 'a', today=TODAY), PlanWorker(db, 'b', today=TODAY)
    claimed = await a.claim()
    assert claimed is not None
    assert claimed.plan_id == plan_id
    assert await b.claim() is None  # leased
    async with db.system_tx() as tx:
        await tx.execute(
            "UPDATE fulfilment_plans SET lease_until = now() - interval '1 second' WHERE plan_id = %s",
            (plan_id,),
        )
    assert await b.run_once() == plan_id  # the lapsed lease is taken over
    # The first worker's late result is ignored: the plan is already done by b.
    await a._finish(claimed, None, 'failed', 'late')
    assert (await plan_row(db, tenant, plan_id))['status'] == 'done'
    # A plan that keeps failing is given up after MAX_ATTEMPTS.
    doomed = await queue(db, tenant)
    async with db.system_tx() as tx:
        await tx.execute(
            'UPDATE fulfilment_plans SET attempts = %s WHERE plan_id = %s', (MAX_ATTEMPTS, doomed)
        )
    assert await a.run_once() == doomed
    row = await plan_row(db, tenant, doomed)
    assert (row['status'], row['error']) == ('failed', 'gave up after repeated failures')


async def test_a_solver_failure_is_retried_then_failed(
    db: PgDatabase, tenant: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    await drain(db)
    import intelligence_ml.plans as plans

    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError('solver crashed')

    monkeypatch.setattr(plans, 'solve', boom)
    plan_id = await queue(db, tenant)
    w = PlanWorker(db, 'w', today=TODAY)
    assert await w.run_once() == plan_id
    assert (await plan_row(db, tenant, plan_id))['status'] == 'running'  # lease lapses; retried
    async with db.system_tx() as tx:
        await tx.execute(
            "UPDATE fulfilment_plans SET attempts = %s, lease_until = now() - interval '1 second' WHERE plan_id = %s",
            (MAX_ATTEMPTS - 1, plan_id),
        )
    assert await w.run_once() == plan_id
    row = await plan_row(db, tenant, plan_id)
    assert (row['status'], row['error']) == ('failed', 'RuntimeError')
    assert w.today() == TODAY
    assert PlanWorker(db, 'x').today() == date.today()

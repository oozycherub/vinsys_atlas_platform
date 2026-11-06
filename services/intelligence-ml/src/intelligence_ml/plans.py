"""The fulfilment-plan worker: intelligence-svc queues plans (`POST /v1/fulfilment-plans:compute`),
this claims them with a lease (`FOR UPDATE SKIP LOCKED`), solves them outside any transaction,
writes the lines, and emits `intel.demand.recruit_required.v1` for demands it cannot staff."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from atlas_platform.db import Database, Tx
from atlas_platform.events import PgOutbox

from intelligence_ml.fulfilment import Booking, Candidate, Demand, Plan, horizon_end, solve
from intelligence_ml.readiness import LearningItem

log = logging.getLogger('intelligence_ml')

LEASE_S = 15 * 60
MAX_ATTEMPTS = 3
RECRUIT_TOPIC = 'intel.demand.recruit_required.v1'


@dataclass(frozen=True)
class Claimed:
    tenant_id: str
    plan_id: str
    account_id: str | None
    horizon_days: int
    attempts: int


def _months(a: date, b: date) -> int:
    return max(0, (b.year - a.year) * 12 + (b.month - a.month) - (1 if b.day < a.day else 0))


def _json(v: Any) -> Any:
    return json.loads(v) if isinstance(v, str) else v


class PlanWorker:
    def __init__(
        self,
        db: Database,
        worker_id: str,
        *,
        time_limit_s: float = 600.0,
        today: date | None = None,
    ) -> None:
        self.db = db
        self.worker_id = worker_id
        self.time_limit_s = time_limit_s
        self._today = today
        self.outbox = PgOutbox()

    def today(self) -> date:
        return self._today or date.today()

    async def claim(self) -> Claimed | None:
        async with self.db.system_tx() as tx:
            rows = await tx.fetch(
                """UPDATE fulfilment_plans p
                   SET status = 'running', worker_id = %s, attempts = attempts + 1,
                       lease_until = now() + make_interval(secs => %s)
                   FROM (SELECT tenant_id, plan_id FROM fulfilment_plans
                         WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
                         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) c
                   WHERE p.tenant_id = c.tenant_id AND p.plan_id = c.plan_id
                   RETURNING p.tenant_id::text, p.plan_id::text, p.account_id, p.horizon_days, p.attempts""",
                (self.worker_id, LEASE_S),
            )
        if not rows:
            return None
        r = rows[0]
        return Claimed(
            r['tenant_id'], r['plan_id'], r['account_id'], r['horizon_days'], r['attempts']
        )

    async def load(
        self, tx: Tx, c: Claimed
    ) -> tuple[list[Demand], list[Candidate], list[LearningItem], float]:
        today = self.today()
        rows = await tx.fetch(
            """SELECT demand_id::text, title, skills, headcount, allocation_pct, start_date, end_date,
                      account_id, job_profile_id::text, location
               FROM demands
               WHERE status = 'open' AND start_date <= %s AND (end_date IS NULL OR end_date >= %s)
                 AND (%s::text IS NULL OR account_id = %s)
               ORDER BY start_date, demand_id""",
            (horizon_end(today, c.horizon_days), today, c.account_id, c.account_id),
        )
        demands = [
            Demand(
                r['demand_id'],
                r['title'],
                tuple(_json(r['skills'])),
                r['headcount'],
                r['allocation_pct'],
                r['start_date'],
                r['end_date'],
                r['account_id'],
                r['job_profile_id'],
                r['location'],
            )
            for r in rows
        ]
        employees = await tx.fetch(
            """SELECT employee_id::text, role_started_at FROM intel_employees
               WHERE status = 'active' ORDER BY employee_id"""
        )
        skills: dict[str, dict[str, float]] = {}
        for r in await tx.fetch(
            'SELECT employee_id::text, skill_id::text, proficiency::float8 AS p FROM intel_employee_skills'
        ):
            skills.setdefault(r['employee_id'], {})[r['skill_id']] = float(r['p'])
        bookings: dict[str, list[Booking]] = {}
        for r in await tx.fetch(
            """SELECT employee_id::text, percent, lower(during) AS s, upper(during) AS e
               FROM project_allocations"""
        ):
            bookings.setdefault(r['employee_id'], []).append(Booking(r['percent'], r['s'], r['e']))
        candidates = [
            Candidate(
                e['employee_id'],
                skills.get(e['employee_id'], {}),
                tuple(bookings.get(e['employee_id'], [])),
                _months(e['role_started_at'], today) if e['role_started_at'] else None,
            )
            for e in employees
        ]
        items = [
            LearningItem(r['item_id'], r['title'], tuple(r['skill_ids']), float(r['h']))
            for r in await tx.fetch(
                """SELECT item_id::text, title, skill_ids::text[] AS skill_ids, duration_hours::float8 AS h
                   FROM learning_items WHERE active"""
            )
        ]
        policy = await tx.fetch(
            'SELECT learning_hours_per_day::float8 AS h FROM intel_tenant_policies'
        )
        return demands, candidates, items, float(policy[0]['h']) if policy else 1.0

    async def run_once(self) -> str | None:
        """Claims and solves one plan; returns its id (None when the queue is empty)."""
        c = await self.claim()
        if c is None:
            return None
        if c.attempts > MAX_ATTEMPTS:
            await self._finish(c, None, 'failed', 'gave up after repeated failures')
            return c.plan_id
        try:
            async with self.db.tenant_tx(c.tenant_id) as tx:
                demands, candidates, items, hours = await self.load(tx, c)
            plan = solve(
                demands,
                candidates,
                items,
                today=self.today(),
                hours_per_day=hours,
                time_limit_s=self.time_limit_s,
            )
            await self._finish(c, (plan, demands), 'done', None)
        except Exception as error:  # the lease lapses; another worker retries
            log.exception('fulfilment plan failed')
            if c.attempts >= MAX_ATTEMPTS:
                await self._finish(c, None, 'failed', type(error).__name__)
        return c.plan_id

    async def _finish(
        self,
        c: Claimed,
        result: tuple[Plan, list[Demand]] | None,
        status: str,
        error: str | None,
    ) -> None:
        now = datetime.now().astimezone()
        async with self.db.tenant_tx(c.tenant_id) as tx:
            owned = await tx.execute(
                """UPDATE fulfilment_plans SET status = %s, solver_status = %s, objective = %s,
                     summary = %s, error = %s, finished_at = now(), lease_until = NULL
                   WHERE plan_id = %s AND worker_id = %s AND status = 'running'""",
                (
                    status,
                    result[0].status if result else None,
                    result[0].objective if result else None,
                    json.dumps(result[0].summary) if result else None,
                    error,
                    c.plan_id,
                    self.worker_id,
                ),
            )
            if owned != 1 or result is None:
                return  # lost the lease: the other worker's result stands
            plan, demands = result
            by_id = {d.demand_id: d for d in demands}
            await tx.execute('DELETE FROM fulfilment_plan_lines WHERE plan_id = %s', (c.plan_id,))
            for li in plan.lines:
                await tx.execute(
                    """INSERT INTO fulfilment_plan_lines (tenant_id, plan_id, demand_id, slot, classification,
                         employee_id, readiness, learning_hours, days_until_start, explanation)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        c.tenant_id,
                        c.plan_id,
                        li.demand_id,
                        li.slot,
                        li.classification,
                        li.employee_id,
                        li.readiness,
                        li.learning_hours,
                        li.days_until_start,
                        json.dumps(li.explanation),
                    ),
                )
            recruit: dict[str, int] = {}
            for li in plan.lines:
                if li.classification == 'recruit':
                    recruit[li.demand_id] = recruit.get(li.demand_id, 0) + 1
            for demand_id, count in recruit.items():
                d = by_id[demand_id]
                await self.outbox.append(
                    tx,
                    topic=RECRUIT_TOPIC,
                    tenant_id=c.tenant_id,
                    aggregate_type='demand',
                    aggregate_id=demand_id,
                    payload={
                        'tenant_id': c.tenant_id,
                        'demand_id': demand_id,
                        'plan_id': c.plan_id,
                        'account_id': d.account_id,
                        'title': d.title,
                        'job_profile_id': d.job_profile_id,
                        'skills': [
                            {
                                'skill_id': s['skill_id'],
                                'weight': float(s['weight']),
                                'target_proficiency': float(s['target_proficiency']),
                                'must_have': bool(s.get('must_have', False)),
                            }
                            for s in d.skills
                        ],
                        'headcount': count,
                        'start_date': d.start.isoformat(),
                        'location': d.location,
                        'occurred_at': now.isoformat(),
                    },
                )

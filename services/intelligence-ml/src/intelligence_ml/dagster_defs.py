"""Dagster definitions (PRD §2.5(vi) "Dagster nightly"). Load with
`dagster dev -m intelligence_ml.dagster_defs`. The ops are thin: the work lives in plain,
tested functions (attrition.pipeline, gaps, plans).

- nightly (02:00): feature snapshots → scores → alerts, skill-gap rebuild, fulfilment plans
- monthly (1st, 03:00): attrition retrain
"""

# No `from __future__ import annotations`: Dagster inspects the real annotation types.
import asyncio
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any, TypeVar

import dagster as dg
from atlas_platform.db import PgDatabase

from intelligence_ml import gaps
from intelligence_ml.attrition import pipeline
from intelligence_ml.plans import PlanWorker

T = TypeVar('T')


class AtlasDatabase(dg.ConfigurableResource):  # type: ignore[type-arg]
    """The service database, as the app role (RLS applies to every query)."""

    dsn: str
    app_role: str | None = 'atlas_app'

    def run(self, work: Callable[[PgDatabase], Awaitable[T]]) -> T:
        async def go() -> T:
            db = PgDatabase(self.dsn, app_role=self.app_role, max_size=2)
            await db.open()
            try:
                return await work(db)
            finally:
                await db.close()

        return asyncio.run(go())


def _today(context: dg.OpExecutionContext) -> date:
    tag = context.run.tags.get('as_of') if context.run else None
    return date.fromisoformat(tag) if tag else date.today()


@dg.op
def attrition_nightly(context: dg.OpExecutionContext, database: AtlasDatabase) -> dict[str, Any]:
    """Feature snapshots, batch scores, drift and alerts for every tenant."""
    as_of = _today(context)
    return database.run(lambda db: pipeline.nightly(db, as_of))


@dg.op
def skill_gaps_nightly(database: AtlasDatabase) -> dict[str, int]:
    return database.run(gaps.rebuild)


@dg.op
def fulfilment_queue(context: dg.OpExecutionContext, database: AtlasDatabase) -> int:
    """Drains queued fulfilment plans (requests from intelligence-svc and the nightly ones)."""
    worker_id = f'dagster-{context.run_id[:8]}'

    async def drain(db: PgDatabase) -> int:
        worker, n = PlanWorker(db, worker_id), 0
        while await worker.run_once() is not None:
            n += 1
        return n

    return database.run(drain)


@dg.op
def attrition_retrain(
    context: dg.OpExecutionContext, database: AtlasDatabase
) -> dict[str, str | None]:
    as_of = _today(context)
    return database.run(lambda db: pipeline.train(db, as_of))


@dg.job
def nightly() -> None:
    attrition_nightly()
    skill_gaps_nightly()
    fulfilment_queue()


@dg.job
def monthly_retrain() -> None:
    attrition_retrain()


defs = dg.Definitions(
    jobs=[nightly, monthly_retrain],
    schedules=[
        dg.ScheduleDefinition(job=nightly, cron_schedule='0 2 * * *', execution_timezone='UTC'),
        dg.ScheduleDefinition(
            job=monthly_retrain, cron_schedule='0 3 1 * *', execution_timezone='UTC'
        ),
    ],
    resources={'database': AtlasDatabase(dsn=dg.EnvVar('ATLAS_INTELLIGENCE_DATABASE_URL'))},
)

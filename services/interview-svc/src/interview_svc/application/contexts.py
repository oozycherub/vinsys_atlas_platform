"""Builds the graph context for a session: its frozen plan (cached per version: published plans
never change), the interviewer, and scoring bound to the session."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from atlas_platform.db import Database

from interview_svc.application.ports import GraphContext, Interviewer, SessionRow, Store
from interview_svc.application.scoring import ScoringService
from interview_svc.domain.errors import InterviewError
from interview_svc.domain.plan import Plan, parse_plan
from interview_svc.domain.state import Utterance


class Contexts:
    def __init__(
        self, db: Database, store: Store, interviewer: Interviewer, scoring: ScoringService
    ) -> None:
        self.db = db
        self.store = store
        self.interviewer = interviewer
        self.scoring = scoring
        self._plans: dict[tuple[str, int], tuple[Plan, str, dict[str, float]]] = {}

    async def plan(self, session: SessionRow) -> tuple[Plan, str, dict[str, float]]:
        cache_key = (session.interview_id, session.plan_version)
        if cache_key not in self._plans:
            async with self.db.tenant_tx(session.tenant_id) as tx:
                row = await self.store.get_interview(tx, session.interview_id)
                raw = await self.store.get_plan(tx, session.interview_id, session.plan_version)
            if row is None or raw is None:
                raise InterviewError('not_found', 'INTERVIEW_NOT_FOUND', 'Interview not found.')
            thresholds: dict[str, Any] = row['thresholds']
            self._plans[cache_key] = (
                parse_plan(raw),
                row['title'],
                {k: float(v) for k, v in thresholds.items()},
            )
        return self._plans[cache_key]

    async def context(
        self, session: SessionRow, say_now: Callable[[Utterance], Awaitable[None]]
    ) -> GraphContext:
        plan, title, thresholds = await self.plan(session)
        return GraphContext(
            plan=plan,
            title=title,
            interviewer=self.interviewer,
            scoring=self.scoring.bind(session, plan, thresholds),
            say_now=say_now,
        )

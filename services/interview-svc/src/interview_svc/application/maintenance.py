"""The worker's maintenance pass: pause timeouts (PRD: resume within 120 s, else the interview
ends), sessions whose worker died mid-SCORING, and expired demand hints."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from atlas_platform.db import Database

from interview_svc.application.ports import Clock, Store
from interview_svc.application.runner import LeaseLostError, SessionRunner
from interview_svc.domain.dialogue import PAUSE_LIMIT_MS
from interview_svc.domain.errors import InterviewError
from interview_svc.domain.state import Utterance

log = logging.getLogger('interview_svc')


class NullSink:
    """No one is listening (the candidate is gone): utterances only go to the transcript."""

    async def utter(self, u: Utterance) -> None:
        return None

    async def notice(self, kind: str, data: dict[str, Any]) -> None:
        return None


class Maintenance:
    def __init__(
        self, db: Database, store: Store, runner: SessionRunner, clock: Clock, batch: int = 20
    ) -> None:
        self.db = db
        self.store = store
        self.runner = runner
        self.clock = clock
        self.batch = batch

    async def run_once(self) -> dict[str, int]:
        counts = {'pause_timeouts': 0, 'resumed': 0, 'demand_expired': 0}
        cutoff = self.clock.now() - timedelta(milliseconds=PAUSE_LIMIT_MS)
        async with self.db.system_tx() as tx:
            paused = await self.store.expired_pauses(tx, cutoff, self.batch)
            stalled = await self.store.stalled(tx, self.batch)
            counts['demand_expired'] = await self.store.expire_demand(tx)
        for s in paused:
            counts['pause_timeouts'] += await self._drive(s.session_id, 'pause_timeout')
        for s in stalled:
            counts['resumed'] += await self._drive(s.session_id, None)
        return counts

    async def _drive(self, session_id: str, event: str | None) -> int:
        try:
            session = await self.runner.acquire(session_id)
        except InterviewError:
            return 0  # someone else has it, or it ended meanwhile
        try:
            if event is None:
                await self.runner.resume(session, NullSink())
            else:
                await self.runner.submit(session, event, {}, NullSink())
            return 1
        except (LeaseLostError, InterviewError) as error:
            log.info('maintenance skipped a session', extra={'error': type(error).__name__})
            return 0
        except Exception:  # retried on the next pass (e.g. the scorer is down)
            log.exception('maintenance failed for a session')
            return 0
        finally:
            await self.runner.release(session_id)

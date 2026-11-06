"""The agent worker process (ADR-0008 §3): claims voice sessions that need an agent (lease on
the session row, FOR UPDATE SKIP LOCKED), runs one VoiceAgent per session while renewing the
lease, and runs the maintenance pass. KEDA scales workers on `interview_pending_sessions()`."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

from atlas_platform.db import Database

from interview_svc.application.maintenance import Maintenance
from interview_svc.application.ports import SessionRow, Store
from interview_svc.application.runner import LeaseLostError, SessionRunner
from interview_svc.voice.agent import VoiceAgent

log = logging.getLogger('interview_svc')


class AgentWorker:
    def __init__(
        self,
        *,
        db: Database,
        store: Store,
        runner: SessionRunner,
        maintenance: Maintenance,
        make_agent: Callable[[SessionRow], Awaitable[VoiceAgent]],
        capacity: int = 4,
        renew_every_s: float = 15.0,
    ) -> None:
        self.db = db
        self.store = store
        self.runner = runner
        self.maintenance = maintenance
        self.make_agent = make_agent
        self.capacity = capacity
        self.renew_every_s = renew_every_s
        self.active: dict[str, asyncio.Task[None]] = {}

    async def claim_once(self) -> list[asyncio.Task[None]]:
        free = self.capacity - len(self.active)
        if free <= 0:
            return []
        async with self.db.system_tx() as tx:
            sessions = await self.store.claim_voice(
                tx, self.runner.worker_id, self.runner.lease_ttl_s, free
            )
        started = []
        for s in sessions:
            task = asyncio.ensure_future(self.run_session(s))
            self.active[s.session_id] = task
            task.add_done_callback(self._forget(s.session_id))
            started.append(task)
        return started

    def _forget(self, session_id: str) -> Callable[[asyncio.Task[None]], None]:
        def done(_task: asyncio.Task[None]) -> None:
            self.active.pop(session_id, None)

        return done

    async def run_session(self, session: SessionRow) -> None:
        agent_task: asyncio.Task[str | None] | None = None

        async def renew() -> None:
            while True:
                await asyncio.sleep(self.renew_every_s)
                if not await self.runner.renew(session.session_id):
                    log.warning('lease lost; stopping the agent')
                    if agent_task is not None:
                        agent_task.cancel()
                    return

        renewer = asyncio.ensure_future(renew())
        try:
            agent = await self.make_agent(session)
            agent_task = asyncio.ensure_future(agent.run())
            outcome = await agent_task
            log.info('voice session finished', extra={'outcome': outcome})
        except (LeaseLostError, asyncio.CancelledError):
            log.info('voice session handed over')
        except Exception:
            log.exception('voice session failed; another worker resumes from the checkpoint')
        finally:
            renewer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await renewer
            await self.runner.release(session.session_id)

    async def run_forever(
        self, stop: asyncio.Event, poll_s: float = 1.0, maintenance_s: float = 10.0
    ) -> None:  # pragma: no cover - process loop
        since = 0.0
        while not stop.is_set():
            await self.claim_once()
            since += poll_s
            if since >= maintenance_s:
                since = 0.0
                await self.maintenance.run_once()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=poll_s)
        for task in list(self.active.values()):
            task.cancel()

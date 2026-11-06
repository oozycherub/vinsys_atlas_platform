"""Runs the interview graph for one session under a lease (ADR-0008 §2-3).

For each input event: load the latest checkpoint (Redis when it is current, else Postgres),
finish any node a crashed worker left pending, write the event into a checkpoint, then run the
graph and checkpoint after every node. A checkpoint is written only while this worker still
holds the lease, so two workers can never both advance a session.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any, Protocol, cast

from atlas_platform.db import Database
from atlas_platform.ids import uuid7

from interview_svc.application.ports import (
    Checkpoint,
    Clock,
    GraphContext,
    HotState,
    Outbox,
    SessionRow,
    Store,
)
from interview_svc.domain.errors import InterviewError
from interview_svc.domain.state import (
    AWAIT,
    Emit,
    Event,
    InterviewState,
    Turn,
    Utterance,
    initial_state,
)
from interview_svc.graph.builder import accept_event, interview_graph

log = logging.getLogger('interview_svc')

FLAGGED_TOPIC = 'interview.session.flagged.v1'
ENDED_STATUSES = ('completed', 'declined', 'escalated', 'abandoned')


class Sink(Protocol):
    """Where the interviewer's words go (WebSocket, or TTS into the LiveKit room)."""

    async def utter(self, u: Utterance) -> None: ...

    async def notice(self, kind: str, data: dict[str, Any]) -> None: ...


class ContextFactory(Protocol):
    async def context(
        self, session: SessionRow, say_now: Callable[[Utterance], Awaitable[None]]
    ) -> GraphContext: ...


class LeaseLostError(Exception):
    """Another worker took the session over; this one must stop."""


def status_of(state: InterviewState) -> str:
    if state['phase'] == 'END':
        return state['outcome'] or 'completed'
    if state['next'] == 'SCORING' or state['phase'] in ('WRAP_UP', 'SCORING'):
        return 'scoring'
    if state['phase'] == 'PAUSED':
        return 'paused'
    return 'active'


class SessionRunner:
    def __init__(
        self,
        *,
        db: Database,
        store: Store,
        hot: HotState,
        outbox: Outbox,
        clock: Clock,
        contexts: ContextFactory,
        worker_id: str,
        lease_ttl_s: int = 60,
        flush_every_s: float = 30.0,
        on_turn_eval: Callable[[SessionRow, str, list[Turn]], None] | None = None,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self.db = db
        self.store = store
        self.hot = hot
        self.outbox = outbox
        self.clock = clock
        self.contexts = contexts
        self.worker_id = worker_id
        self.lease_ttl_s = lease_ttl_s
        self.flush_every_s = flush_every_s
        self.on_turn_eval = on_turn_eval
        self.failpoint = failpoint
        self._locks: dict[str, asyncio.Lock] = {}
        self._flushed_at: dict[str, datetime] = {}

    # --- leases ------------------------------------------------------------------------------

    async def acquire(self, session_id: str) -> SessionRow:
        async with self.db.system_tx() as tx:
            row = await self.store.acquire_lease(tx, session_id, self.worker_id, self.lease_ttl_s)
        if row is None:
            raise InterviewError(
                'conflict', 'INTERVIEW_IN_USE', 'The interview is open elsewhere or has ended.'
            )
        return row

    async def renew(self, session_id: str) -> bool:
        async with self.db.system_tx() as tx:
            return await self.store.renew_lease(tx, session_id, self.worker_id, self.lease_ttl_s)

    async def release(self, session_id: str) -> None:
        async with self.db.system_tx() as tx:
            await self.store.release_lease(tx, session_id, self.worker_id)
        self._locks.pop(session_id, None)
        self._flushed_at.pop(session_id, None)

    # --- running -----------------------------------------------------------------------------

    async def load(self, session: SessionRow) -> Checkpoint:
        cached = await self.hot.get(session.tenant_id, session.session_id)
        if cached is not None and cached.seq == session.checkpoint_seq:
            return cached
        async with self.db.tenant_tx(session.tenant_id) as tx:
            stored = await self.store.latest_checkpoint(tx, session.session_id)
        if stored is not None:
            return stored
        return Checkpoint(
            0, 'INIT', initial_state(session.session_id, session.tenant_id, session.mode)
        )

    async def submit(
        self, session: SessionRow, kind: str, payload: dict[str, Any], sink: Sink
    ) -> tuple[SessionRow, InterviewState]:
        """Handles one input event; returns the updated session row and state."""
        lock = self._locks.setdefault(session.session_id, asyncio.Lock())
        async with lock:
            cp = await self.load(session)
            ctx = await self.contexts.context(session, sink.utter)
            seq, state = cp.seq, cp.state
            if state['next'] != AWAIT:  # a crashed worker left a node pending: finish it first
                session, seq, state = await self._run(session, seq, state, ctx, sink)
            now = self.clock.now()
            started = session.started_at or now
            raw: dict[str, Any] = {
                **payload,
                'id': uuid7(),
                'type': kind,
                'at_ms': int((now - started).total_seconds() * 1000),
            }
            state = accept_event(state, cast(Event, raw))
            session = await self._persist(session, seq + 1, 'INPUT', state, [], started)
            seq += 1
            if state['next'] != AWAIT:
                session, seq, state = await self._run(session, seq, state, ctx, sink)
            session = await self._maybe_flush(session, state)
            return session, state

    async def resume(self, session: SessionRow, sink: Sink) -> tuple[SessionRow, InterviewState]:
        """Finishes a node left pending (maintenance, or a new worker taking over)."""
        lock = self._locks.setdefault(session.session_id, asyncio.Lock())
        async with lock:
            cp = await self.load(session)
            state = cp.state
            if state['next'] != AWAIT:
                ctx = await self.contexts.context(session, sink.utter)
                session, _, state = await self._run(session, cp.seq, state, ctx, sink)
            session = await self._maybe_flush(session, state)
            return session, state

    async def mark_interrupted(self, session: SessionRow, utterance_id: str) -> SessionRow:
        """Barge-in: the candidate spoke over this utterance, so TTS stopped part-way."""
        lock = self._locks.setdefault(session.session_id, asyncio.Lock())
        async with lock:
            cp = await self.load(session)
            state = cp.state
            hit = [t for t in state['turns'] if t['utterance_id'] == utterance_id]
            if not hit or hit[0]['interrupted']:
                return session
            hit[0]['interrupted'] = True
            session = await self._persist(session, cp.seq + 1, 'PLAYBACK', state, [], None)
            if hit[0]['index'] < session.turns_flushed:
                session = await self._flush(session, state, start=hit[0]['index'])
            return session

    async def _run(
        self, session: SessionRow, seq: int, state: InterviewState, ctx: GraphContext, sink: Sink
    ) -> tuple[SessionRow, int, InterviewState]:
        sent: set[str] = set()  # on a resume, earlier utterances are re-sent (ids dedupe)
        evaluated = set(state['pending_evals'])
        phase = state['phase']
        config: dict[str, Any] = {'configurable': {'ctx': ctx}, 'recursion_limit': 60}
        async for update in interview_graph().astream(state, config, stream_mode='updates'):
            for node, new_state in update.items():
                emits = list(new_state['emits'])
                new_state['emits'] = []
                seq += 1
                session = await self._persist(session, seq, node, new_state, emits, None)
                state = new_state
                if self.failpoint is not None:
                    self.failpoint(node)
                for u in state['outbox']:
                    if u['id'] not in sent:
                        sent.add(u['id'])
                        await sink.utter(u)
                for qid in state['pending_evals']:
                    if qid not in evaluated and self.on_turn_eval is not None:
                        evaluated.add(qid)
                        self.on_turn_eval(session, qid, list(state['turns']))
                if state['phase'] != phase:
                    phase = state['phase']
                    await sink.notice('phase', {'phase': phase})
                if node == 'REPEAT' and state['text_offered']:
                    await sink.notice('offer_text', {})
        if state['phase'] == 'END':
            await sink.notice(
                'ended', {'outcome': state['outcome'], 'evaluation': state['evaluation']}
            )
        return session, seq, state

    async def _persist(
        self,
        session: SessionRow,
        seq: int,
        node: str,
        state: InterviewState,
        emits: list[Emit],
        started: datetime | None,
    ) -> SessionRow:
        now = self.clock.now()
        status = status_of(state)
        started_at = session.started_at or started
        ended_at = session.ended_at or (now if status in ENDED_STATUSES else None)
        paused_at = (session.paused_at or now) if status == 'paused' else None
        async with self.db.tenant_tx(session.tenant_id) as tx:
            ok = await self.store.save_checkpoint(
                tx,
                session=session,
                seq=seq,
                node=node,
                state=state,
                worker_id=self.worker_id,
                status=status,
                started_at=started_at,
                ended_at=ended_at,
                paused_at=paused_at,
            )
            if not ok:
                raise LeaseLostError(session.session_id)
            for e in emits:
                await self.outbox.append(
                    tx,
                    topic=FLAGGED_TOPIC,
                    tenant_id=session.tenant_id,
                    aggregate_type='interview_session',
                    aggregate_id=session.session_id,
                    payload={
                        'tenant_id': session.tenant_id,
                        'interview_session_id': session.session_id,
                        'assessment_session_id': session.assessment_session_id,
                        'interview_id': session.interview_id,
                        'flag': e['flag'],
                        'turn_index': e['turn_index'],
                        'ended_session': e['ended'],
                        'occurred_at': now.isoformat(),
                    },
                )
        updated = dataclasses.replace(
            session,
            checkpoint_seq=seq,
            phase=state['phase'],
            status=status,
            started_at=started_at,
            ended_at=ended_at,
            paused_at=paused_at,
        )
        await self.hot.put(session.tenant_id, session.session_id, Checkpoint(seq, node, state))
        return updated

    async def _maybe_flush(self, session: SessionRow, state: InterviewState) -> SessionRow:
        """The transcript reaches `interview_turns` at least every 30 s, and at the end."""
        now = self.clock.now()
        last = self._flushed_at.setdefault(session.session_id, now)
        due = (now - last).total_seconds() >= self.flush_every_s
        if due or status_of(state) in (*ENDED_STATUSES, 'paused', 'scoring'):
            return await self._flush(session, state)
        return session

    async def _flush(
        self, session: SessionRow, state: InterviewState, start: int | None = None
    ) -> SessionRow:
        first = session.turns_flushed if start is None else start
        async with self.db.tenant_tx(session.tenant_id) as tx:
            await self.store.flush_turns(tx, session, state['turns'], first)
        self._flushed_at[session.session_id] = self.clock.now()
        return dataclasses.replace(
            session, turns_flushed=max(session.turns_flushed, len(state['turns']))
        )

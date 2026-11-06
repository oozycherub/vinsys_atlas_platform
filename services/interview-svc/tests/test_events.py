"""Consumed events: allocation hints, erasure (with acknowledgement), tenant purge, poison."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from atlas_platform.ids import uuid7

from interview_svc.application.events import ERASURE, PURGED, SESSION_STARTED
from tests.conftest import Harness, RecordingSink
from tests.test_runner import complete, start


async def demand(h: Harness, tenant: str) -> list[str]:
    async with h.db.tenant_tx(tenant) as tx:
        rows = await tx.fetch('SELECT assessment_session_id::text AS id FROM interview_demand')
    return [r['id'] for r in rows]


def started(tenant: str, assessment_id: str, session_id: str, deadline: str) -> dict[str, object]:
    return {
        'tenant_id': tenant,
        'session_id': session_id,
        'assessment_id': assessment_id,
        'assessment_version': 1,
        'candidate_id': str(uuid.uuid4()),
        'attempt_no': 1,
        'deadline_at': deadline,
        'occurred_at': deadline,
    }


async def test_session_started_is_an_allocation_hint_for_voice_assessments(
    harness: Harness, tenant: str
) -> None:
    h = harness
    assessment = str(uuid.uuid4())
    deadline = (h.clock.now() + timedelta(hours=1)).isoformat()
    first = str(uuid.uuid4())
    # An assessment never seen with a voice interview: no hint.
    assert await h.handlers.handle(
        SESSION_STARTED, uuid7(), started(tenant, assessment, first, deadline)
    )
    assert await demand(h, tenant) == []
    await h.session(tenant, await h.published(tenant, mode='voice'), assessment_id=assessment)
    second = str(uuid.uuid4())
    event_id = uuid7()
    payload = started(tenant, assessment, second, deadline)
    assert await h.handlers.handle(SESSION_STARTED, event_id, payload)
    assert not await h.handlers.handle(SESSION_STARTED, event_id, payload)  # duplicate
    assert await demand(h, tenant) == [second]
    # The hint goes when the interview session is created for it ...
    await h.interviews.create_session(
        tenant,
        await h.published(tenant, mode='voice'),
        {
            'assessment_id': assessment,
            'assessment_session_id': second,
            'question_id': str(uuid.uuid4()),
            'candidate_id': str(uuid.uuid4()),
        },
    )
    assert await demand(h, tenant) == []
    # ... or when the assessment's deadline passes.
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()  # expiry uses the DB clock
    third = str(uuid.uuid4())
    await h.handlers.handle(SESSION_STARTED, uuid7(), started(tenant, assessment, third, past))
    assert await demand(h, tenant) == [third]
    counts = await h.maintenance(h.runner('maint')).run_once()
    assert counts['demand_expired'] >= 1
    assert await demand(h, tenant) == []


async def test_erasure_deletes_interviews_and_recordings(harness: Harness, tenant: str) -> None:
    h = harness
    iid = await h.published(tenant)
    s, _ = await h.session(tenant, iid)
    keep, _ = await h.session(tenant, iid)
    runner = h.runner()
    sink = RecordingSink()
    s = await start(runner, s, sink)
    await complete(h, runner, s, sink)
    key = await h.recorder.finalize(tenant, s.session_id, {'candidate': b'RIFF', 'agent': b'RIFF'})
    async with h.db.tenant_tx(tenant) as tx:
        await h.store.set_recording(tx, s.session_id, key)
    request_id = str(uuid.uuid4())
    payload = {
        'tenant_id': tenant,
        'request_id': request_id,
        'candidate_id': s.candidate_id,
        'ack_required_from': ['interview-svc', 'parsing-svc'],
    }
    event_id = uuid7()
    assert await h.handlers.handle(ERASURE, event_id, payload)
    assert not await h.handlers.handle(ERASURE, event_id, payload)
    assert h.recorder.objects == {}
    async with h.db.tenant_tx(tenant) as tx:
        assert await h.store.session(tx, s.session_id) is None
        assert await h.store.session(tx, keep.session_id) is not None
        for table in ('interview_turns', 'interview_checkpoints', 'interview_evaluations'):
            rows = await tx.fetch(
                f'SELECT count(*) AS n FROM {table} WHERE session_id = %s',  # noqa: S608
                (s.session_id,),
            )
            assert rows[0]['n'] == 0, table
    acks = await h.outbox(tenant, 'privacy.erasure.acknowledged.v1')
    assert acks[-1]['request_id'] == request_id
    assert acks[-1]['service'] == 'interview-svc'
    # No acknowledgement when interview-svc is not asked for one.
    other = {**payload, 'request_id': str(uuid.uuid4()), 'ack_required_from': []}
    assert await h.handlers.handle(ERASURE, uuid7(), other)
    assert len(await h.outbox(tenant, 'privacy.erasure.acknowledged.v1')) == len(acks)


async def test_tenant_purge(harness: Harness, tenant: str) -> None:
    h = harness
    s, _ = await h.session(tenant, await h.published(tenant))
    event_id = uuid7()
    assert await h.handlers.handle(PURGED, event_id, {'tenant_id': tenant})
    assert not await h.handlers.handle(PURGED, event_id, {'tenant_id': tenant})
    async with h.db.tenant_tx(tenant) as tx:
        assert await h.store.session(tx, s.session_id) is None
        assert await h.store.get_interview(tx, s.interview_id) is None


@pytest.mark.parametrize(
    ('topic', 'payload'),
    [
        (SESSION_STARTED, {'tenant_id': 'nope'}),
        (
            SESSION_STARTED,
            {'tenant_id': str(uuid.uuid4()), 'assessment_id': 'x', 'session_id': 'y'},
        ),
        (ERASURE, {'tenant_id': str(uuid.uuid4()), 'candidate_id': 'x'}),
        ('something.else.happened.v1', {'tenant_id': str(uuid.uuid4())}),
    ],
)
async def test_poison_events_are_refused(
    harness: Harness, topic: str, payload: dict[str, object]
) -> None:
    with pytest.raises(ValueError, match=r'invalid|unexpected'):
        await harness.handlers.handle(topic, uuid7(), payload)

"""The voice pipeline with a fake LiveKit room: recorded WAV fixtures in, scripted STT, a fake TTS
whose playback advances with the room's clock (so barge-in timing is real), and agent workers
that claim sessions, crash, and hand over."""

from __future__ import annotations

import asyncio
import wave
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from interview_svc.application.ports import SessionRow
from interview_svc.voice.adapters import GatewayEndpointer
from interview_svc.voice.agent import VoiceAgent
from interview_svc.voice.audio import (
    EnergyVad,
    frames_of,
    read_wav,
    rms,
    sentences,
    silence,
    to_wav,
)
from interview_svc.voice.ports import AudioFrame, Transcript
from interview_svc.voice.worker import AgentWorker
from tests.conftest import FakeLlm, Harness

CLIPS = Path(__file__).parent / 'fixtures' / 'voice'


def clip(name: str) -> bytes:
    pcm, rate = read_wav((CLIPS / f'{name}.wav').read_bytes())
    assert rate == 16_000
    return pcm


class FakeRoom:
    """Candidate audio from a script; agent playback consumes room time frame by frame."""

    def __init__(self, *parts: str | int, crash_after_ms: int | None = None) -> None:
        pcm = b''.join(clip(p) if isinstance(p, str) else silence(p) for p in parts)
        self.frame_list = frames_of(pcm)
        self.crash_after_ms = crash_after_ms
        self.sent: list[dict[str, Any]] = []
        self.ticks = 0
        self.done = False
        self.closed = False
        self.played_ms = 0
        self.cond = asyncio.Condition()

    async def frames(self) -> AsyncIterator[AudioFrame]:
        for f in self.frame_list:
            await asyncio.sleep(0)
            async with self.cond:
                self.ticks += 1
                self.cond.notify_all()
            if self.crash_after_ms is not None and self.ticks * 20 >= self.crash_after_ms:
                raise ConnectionError('worker lost its network')
            yield f
        async with self.cond:
            self.done = True
            self.cond.notify_all()

    async def play(self, pcm: bytes, sample_rate: int) -> None:
        ms = len(pcm) * 1000 // (2 * sample_rate)
        async with self.cond:
            target = self.ticks + max(1, ms // 20)
            await self.cond.wait_for(lambda: self.done or self.ticks >= target)
        self.played_ms += ms

    async def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True


class FakeTts:
    """20 ms of audio per word."""

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        for _ in text.split():
            yield silence(20)


class ScriptedStt:
    def __init__(self, *heard: tuple[str, float]) -> None:
        self.heard = list(heard)
        self.calls = 0

    async def transcribe(self, pcm: bytes, sample_rate: int) -> Transcript:
        self.calls += 1
        text, logprob = self.heard.pop(0) if self.heard else ('', -0.1)
        return Transcript(text, logprob, 0.01)


class AlwaysComplete:
    async def complete(self, question: str, partial: str) -> bool:
        return True


ANSWERS = [
    ('I start with the cash conversion cycle: receivables, inventory and payables days.', -0.2),
    ('I build a thirteen week cash model with three scenarios and review it monthly.', -0.3),
    ('I told the client the covenant risk plainly and agreed a plan with them.', -0.25),
]


def agent_for(
    h: Harness, session: SessionRow, room: FakeRoom, stt: ScriptedStt, recordings: list[str]
) -> VoiceAgent:
    async def on_recording(s: SessionRow, key: str) -> None:
        recordings.append(key)
        async with h.db.tenant_tx(s.tenant_id) as tx:
            await h.store.set_recording(tx, s.session_id, key)

    return VoiceAgent(
        runner=h.runner(f'agent-{id(room)}'),
        session=session,
        transport=room,
        vad=EnergyVad(),
        stt=stt,
        tts=FakeTts(),
        endpointer=AlwaysComplete(),
        recorder=h.recorder,
        on_recording=on_recording,
    )


async def voice_session(h: Harness, tenant: str) -> tuple[SessionRow, str]:
    s, tok = await h.session(tenant, await h.published(tenant, mode='voice'))
    await h.interviews.join(s.session_id, tok)  # the candidate joined: wants an agent
    return s, tok


def full_script() -> tuple[str | int, ...]:
    return (
        1500,
        'yes',
        800,  # consent plays, the candidate says yes
        2000,
        'answer_long',
        800,  # greeting + q1 play; a long answer (with a short pause)
        2000,
        'answer_short',
        800,
        2000,
        'answer_short',
        800,
        2500,  # the wrap-up plays
    )


async def test_a_voice_candidate_completes_the_interview(harness: Harness, tenant: str) -> None:
    h = harness
    s, _ = await voice_session(h, tenant)
    room = FakeRoom(*full_script())
    stt = ScriptedStt(('Yes, I consent.', -0.1), *ANSWERS)
    recordings: list[str] = []
    runner = h.runner('agent-1')
    s = await runner.acquire(s.session_id)
    agent = agent_for(h, s, room, stt, recordings)
    agent.runner = runner
    outcome = await agent.run()
    await h.settle()
    assert outcome == 'completed'
    assert room.closed
    assert stt.calls == 4  # one transcription per turn: the 300 ms pause did not end a turn
    captions = [m['text'] for m in room.sent if m['type'] == 'caption']
    assert captions[0].startswith('Hello, and thank you for joining.')
    assert any('How do you forecast cash' in c for c in captions)
    assert {'type': 'ended', 'outcome': 'completed'}.items() <= next(
        m for m in room.sent if m['type'] == 'ended'
    ).items()
    assert recordings == [f't/{tenant}/interviews/{s.session_id}/']
    candidate = h.recorder.objects[f'{recordings[0]}candidate.wav']
    assert read_wav(candidate)[1] == 16_000
    async with h.db.tenant_tx(tenant) as tx:
        row = await h.store.session(tx, s.session_id)
        turns = await h.store.turns(tx, s.session_id)
    assert row is not None
    assert (row.status, row.recording_key) == ('completed', recordings[0])
    answers = [t for t in turns if t['kind'] == 'answer']
    assert [round(t['stt_conf'], 2) for t in answers] == [-0.2, -0.3, -0.25]
    assert all(t['t1_ms'] > t['t0_ms'] for t in answers)


async def test_barge_in_stops_speech_within_150_ms(harness: Harness, tenant: str) -> None:
    h = harness
    s, _ = await voice_session(h, tenant)
    # The candidate starts answering 200 ms into the greeting.
    before = 1500 + 600 + 800 + 200
    room = FakeRoom(1500, 'yes', 800, 200, 'answer_short', 800, 3000)
    stt = ScriptedStt(('Yes.', -0.1), ANSWERS[0])
    runner = h.runner('agent-1')
    s = await runner.acquire(s.session_id)
    agent = agent_for(h, s, room, stt, [])
    agent.runner = runner
    await agent.run()
    assert agent.barge_in_at is not None
    assert agent.barge_in_at - before <= 150
    assert agent.interrupted  # the greeting (and the queued question) were cut off
    state = (await runner.load(agent.session)).state
    cut = [t for t in state['turns'] if t['interrupted']]
    assert [t['kind'] for t in cut] == ['greeting', 'question']
    assert state['turns'][-1]['role'] == 'interviewer'  # the barge-in answer was heard
    assert any(t['kind'] == 'answer' for t in state['turns'])


async def test_low_confidence_audio_is_repeated_then_text_is_offered(
    harness: Harness, tenant: str
) -> None:
    h = harness
    s, _ = await voice_session(h, tenant)
    room = FakeRoom(1500, 'yes', 800, 2000, 'mumble', 800, 1500, 'mumble', 800, 2500)
    stt = ScriptedStt(('Yes.', -0.1), ('mm the uh', -1.6), ('mm', -1.4))
    runner = h.runner('agent-1')
    s = await runner.acquire(s.session_id)
    agent = agent_for(h, s, room, stt, [])
    agent.runner = runner
    await agent.run()
    assert {'type': 'offer_text'} in room.sent
    captions = [m['text'] for m in room.sent if m['type'] == 'caption']
    assert any(c.startswith('Sorry, I did not catch that') for c in captions)
    state = (await runner.load(agent.session)).state
    assert [t['excluded'] for t in state['turns'] if t['kind'] == 'answer'] == [True, True]
    assert state['phase'] == 'PAUSED'  # the room closed afterwards: the interview pauses


async def test_silence_brings_a_nudge(harness: Harness, tenant: str) -> None:
    h = harness
    s, _ = await voice_session(h, tenant)
    room = FakeRoom(1500, 'yes', 800, 12_000)
    runner = h.runner('agent-1')
    s = await runner.acquire(s.session_id)
    agent = agent_for(h, s, room, ScriptedStt(('Yes.', -0.1)), [])
    agent.runner = runner
    await agent.run()
    captions = [m['text'] for m in room.sent if m['type'] == 'caption']
    assert captions[-1] == 'Take your time. Whenever you are ready, please share your answer.'


async def test_workers_claim_voice_sessions_and_hand_over_after_a_crash(
    harness: Harness, tenant: str
) -> None:
    h = harness
    async with h.db.system_tx() as tx:  # other tests' voice sessions: not this test's to claim
        await tx.execute('UPDATE interview_sessions SET wants_worker = false')
    s, _ = await voice_session(h, tenant)
    stt_shared = ScriptedStt(('Yes, I consent.', -0.1), *ANSWERS)
    recordings: list[str] = []
    rooms: list[FakeRoom] = []

    def worker(name: str, room: FakeRoom) -> AgentWorker:
        runner = h.runner(name)

        async def make_agent(session: SessionRow) -> VoiceAgent:
            rooms.append(room)
            agent = agent_for(h, session, room, stt_shared, recordings)
            agent.runner = runner
            return agent

        return AgentWorker(
            db=h.db,
            store=h.store,
            runner=runner,
            maintenance=h.maintenance(runner),
            make_agent=make_agent,
            capacity=2,
            renew_every_s=0.05,
        )

    # Worker A takes the session and dies in the middle of the first answer.
    a = worker('worker-a', FakeRoom(*full_script(), crash_after_ms=1500 + 600 + 800 + 2000 + 300))
    tasks = await a.claim_once()
    assert len(tasks) == 1
    await asyncio.gather(*tasks)
    assert a.active == {}
    async with h.db.tenant_tx(tenant) as tx:
        row = await h.store.session(tx, s.session_id)
    assert row is not None
    assert (row.status, row.worker_id) == ('active', None)
    # Worker B claims it and the candidate (re)joins its room: the interview resumes.
    b = worker(
        'worker-b',
        FakeRoom(
            2000, 'answer_long', 800, 2000, 'answer_short', 800, 2000, 'answer_short', 800, 2500
        ),
    )
    stt_shared.heard = list(ANSWERS)
    tasks = await b.claim_once()
    assert len(tasks) == 1
    await asyncio.gather(*tasks)
    await h.settle()
    async with h.db.tenant_tx(tenant) as tx:
        row = await h.store.session(tx, s.session_id)
    assert row is not None
    assert row.status == 'completed'
    welcome = [m['text'] for m in rooms[1].sent if m['type'] == 'caption']
    assert welcome[0].startswith('Walk me through')  # B re-asks where A was cut off
    assert await b.claim_once() == []  # nothing left to claim


async def test_endpointer_and_audio_helpers() -> None:
    llm = FakeLlm(
        scripts={
            'interview.endpointing@1': lambda v: {'complete': v['partial_transcript'].endswith('.')}
        }
    )
    e = GatewayEndpointer(llm, 't1')
    assert await e.complete('Q?', 'I would start with the ratios.')
    assert not await e.complete('Q?', 'I would start with')
    assert not await e.complete('Q?', '   ')
    assert sentences('One. Two!  Three? ') == ['One.', 'Two!', 'Three?']
    assert rms(b'') == 0.0
    assert AudioFrame(silence(20)).ms == 20
    assert read_wav(to_wav(silence(40)))[0] == silence(40)
    with pytest.raises((EOFError, wave.Error)):
        read_wav(b'RIFF')

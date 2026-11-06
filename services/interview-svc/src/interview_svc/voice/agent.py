"""The voice agent for one session (PRD §2.4b media path, §2.4d edge cases).

audio frames → VAD → endpointing (700 ms of silence and a "complete" verdict, or 2.5 s) → STT
→ the interview graph → sentence-chunked streaming TTS → the room. The agent is also the
graph's sink: utterances queue for playback, and speech over playback (barge-in) stops TTS
within a few frames and marks what was cut off as interrupted.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from interview_svc.application.ports import Recorder, SessionRow
from interview_svc.application.runner import SessionRunner
from interview_svc.domain.dialogue import MOVE_ON_MS, NUDGE_MS, OFFER_MOVE_ON_MS
from interview_svc.domain.state import Utterance
from interview_svc.voice.audio import sentences, to_wav
from interview_svc.voice.ports import (
    FRAME_MS,
    SAMPLE_RATE,
    AudioFrame,
    Endpointer,
    Stt,
    Transport,
    Tts,
    Vad,
)

log = logging.getLogger('interview_svc')

ENDPOINT_SILENCE_MS = 700
MAX_ENDPOINT_WAIT_MS = 2_500
BARGE_IN_MS = 60
SILENCE_MARKS = (NUDGE_MS, OFFER_MOVE_ON_MS, MOVE_ON_MS)
SPOKEN_KINDS = ('question', 'repeat', 'probe', 'knockout', 'redirect')


class VoiceAgent:
    def __init__(
        self,
        *,
        runner: SessionRunner,
        session: SessionRow,
        transport: Transport,
        vad: Vad,
        stt: Stt,
        tts: Tts,
        endpointer: Endpointer,
        recorder: Recorder,
        on_recording: Callable[[SessionRow, str], Awaitable[None]],
        barge_in_ms: int = BARGE_IN_MS,
    ) -> None:
        self.runner = runner
        self.session = session
        self.transport = transport
        self.vad = vad
        self.stt = stt
        self.tts = tts
        self.endpointer = endpointer
        self.recorder = recorder
        self.on_recording = on_recording
        self.barge_in_ms = barge_in_ms
        self.queue: asyncio.Queue[Utterance] = asyncio.Queue()
        self.playing: Utterance | None = None
        self.quiet = asyncio.Event()  # set while nothing is playing or queued
        self.quiet.set()
        self._play_task: asyncio.Task[None] | None = None
        self.spoken: set[str] = set()
        self.interrupted: list[str] = []
        self.question = ''
        self.ended = False
        self.outcome: str | None = None
        self.agent_pcm = bytearray()
        self.candidate_pcm = bytearray()
        self.clock_ms = 0  # agent time, advanced by frames
        self.idle_ms = 0
        self.silence_marks: set[int] = set()
        self.barge_in_at: int | None = None  # agent ms when playback was cut (for tests)

    # --- Sink (called by the runner) ---------------------------------------------------------

    async def utter(self, u: Utterance) -> None:
        if u['id'] in self.spoken:
            return  # replayed after a worker crash
        self.spoken.add(u['id'])
        if u['kind'] in SPOKEN_KINDS:
            self.question = u['text']
        self.quiet.clear()
        await self.queue.put(u)
        await self.transport.send({'type': 'caption', 'id': u['id'], 'text': u['text']})

    async def notice(self, kind: str, data: dict[str, Any]) -> None:
        await self.transport.send({'type': kind, **data})
        if kind == 'ended':
            self.ended = True
            self.outcome = data.get('outcome')

    # --- playback ----------------------------------------------------------------------------

    @property
    def speaking(self) -> bool:
        return self.playing is not None or not self.queue.empty()

    async def _player(self) -> None:
        while True:
            u = await self.queue.get()
            self.playing = u
            self._play_task = asyncio.ensure_future(self._play(u))
            with contextlib.suppress(asyncio.CancelledError):
                await self._play_task
            self.playing = None
            self._play_task = None
            self.idle_ms = 0
            self.silence_marks.clear()
            if self.queue.empty():
                self.quiet.set()

    async def _play(self, u: Utterance) -> None:
        for sentence in sentences(u['text']):
            async for chunk in self.tts.synthesize(sentence):
                self.agent_pcm.extend(chunk)
                await self.transport.play(chunk, SAMPLE_RATE)

    async def _barge_in(self) -> None:
        """Stops TTS now; what was cut off or never played is marked interrupted."""
        cut: list[Utterance] = []
        if self.playing is not None:
            cut.append(self.playing)
        while not self.queue.empty():
            cut.append(self.queue.get_nowait())
        if self._play_task is not None:
            self._play_task.cancel()
        self.barge_in_at = self.clock_ms
        for u in cut:
            self.interrupted.append(u['id'])
            self.session = await self.runner.mark_interrupted(self.session, u['id'])

    # --- main loop ---------------------------------------------------------------------------

    async def _submit(self, kind: str, payload: dict[str, Any]) -> None:
        self.session, _ = await self.runner.submit(self.session, kind, payload, self)

    async def run(self) -> str | None:
        player = asyncio.ensure_future(self._player())
        try:
            await self._submit('start' if self.session.started_at is None else 'rejoin', {})
            await self._listen()
            if not self.ended:
                await self._submit('disconnect', {})
            else:
                await self._drain()
                await self._finalize_recording()
        finally:
            player.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await player
            await self.transport.close()
        return self.outcome

    async def _drain(self, timeout_s: float = 30.0) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.quiet.wait(), timeout_s)

    async def _finalize_recording(self) -> None:
        tracks = {
            'candidate': to_wav(bytes(self.candidate_pcm)),
            'agent': to_wav(bytes(self.agent_pcm)),
        }
        key = await self.recorder.finalize(self.session.tenant_id, self.session.session_id, tracks)
        await self.on_recording(self.session, key)

    async def _listen(self) -> None:
        buffer = bytearray()
        speech_ms = 0  # consecutive speech (barge-in)
        silence_ms = 0  # since the candidate's last speech frame
        start_ms = 0
        checked = False
        async for frame in self.transport.frames():
            self.clock_ms += FRAME_MS
            self.candidate_pcm.extend(frame.pcm)
            speech = self.vad.is_speech(frame)
            if speech:
                speech_ms += FRAME_MS
                if self.speaking and speech_ms >= self.barge_in_ms:
                    await self._barge_in()
                if not buffer:
                    start_ms = self.clock_ms - FRAME_MS
                buffer.extend(frame.pcm)
                silence_ms = 0
                checked = False
                self.idle_ms = 0
                self.silence_marks.clear()
            else:
                speech_ms = 0
                if buffer:
                    buffer.extend(frame.pcm)
                    silence_ms += FRAME_MS
                    done = await self._endpoint(buffer, silence_ms, checked, start_ms)
                    checked = checked or silence_ms >= ENDPOINT_SILENCE_MS
                    if done:
                        buffer.clear()
                        silence_ms = 0
                        checked = False
                elif not self.speaking:
                    await self._idle(frame)
            if self.ended and not self.speaking:
                return

    async def _endpoint(
        self, buffer: bytearray, silence_ms: int, checked: bool, start_ms: int
    ) -> bool:
        """End of turn: ≥ 700 ms of silence and the completeness check says so, or 2.5 s."""
        if silence_ms < ENDPOINT_SILENCE_MS or (checked and silence_ms < MAX_ENDPOINT_WAIT_MS):
            return False
        heard = await self.stt.transcribe(bytes(buffer), SAMPLE_RATE)
        if silence_ms < MAX_ENDPOINT_WAIT_MS and not await self._complete(heard.text):
            return False
        if heard.text.strip():
            await self._submit(
                'utterance',
                {
                    'text': heard.text.strip(),
                    't0_ms': start_ms,
                    't1_ms': self.clock_ms - silence_ms,
                    'avg_logprob': heard.avg_logprob,
                    'no_speech_prob': heard.no_speech_prob,
                },
            )
        return True

    async def _complete(self, partial: str) -> bool:
        try:
            async with asyncio.timeout(0.4):
                return await self.endpointer.complete(self.question, partial)
        except Exception:  # noqa: BLE001 - silence alone decides (2.5 s)
            return False

    async def _idle(self, frame: AudioFrame) -> None:
        self.idle_ms += frame.ms
        for mark in SILENCE_MARKS:
            if self.idle_ms >= mark and mark not in self.silence_marks:
                self.silence_marks.add(mark)
                await self._submit('silence', {'silent_ms': self.idle_ms})

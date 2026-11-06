"""Production voice adapters. Heavy dependencies (livekit, torch/silero, faster-whisper) are
imported lazily and live in the optional `voice` dependency group, so the API image and the
tests do not need them. Only the endpointer runs in tests: the others need GPUs or a media
server (ADR-0008 consequences)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx

from interview_svc.application.ports import LlmGateway
from interview_svc.prompts import ENDPOINTING, PURPOSE_TURN
from interview_svc.voice.ports import SAMPLE_RATE, AudioFrame, Transcript


class GatewayEndpointer:
    """The semantic-completeness check (fast route) on the partial transcript."""

    def __init__(self, llm: LlmGateway, tenant_id: str) -> None:
        self.llm = llm
        self.tenant_id = tenant_id

    async def complete(self, question: str, partial: str) -> bool:
        if not partial.strip():
            return False
        out = await self.llm.complete(
            self.tenant_id,
            PURPOSE_TURN,
            ENDPOINTING,
            {'question': question or '(none)', 'partial_transcript': partial},
        )
        return bool(out.get('complete'))


class SileroVad:  # pragma: no cover - needs torch and the Silero model
    """Silero VAD on 30 ms windows (PRD: speech/non-speech, 30 ms window)."""

    def __init__(self, threshold: float = 0.5) -> None:
        import numpy as np
        import torch
        from silero_vad import load_silero_vad

        self.np = np
        self.torch = torch
        self.model = load_silero_vad()
        self.threshold = threshold

    def is_speech(self, frame: AudioFrame) -> bool:
        samples = self.np.frombuffer(frame.pcm, dtype=self.np.int16).astype(self.np.float32) / 32768
        window = self.np.resize(samples, 512)  # the model's window at 16 kHz
        prob = float(self.model(self.torch.from_numpy(window), frame.sample_rate).item())
        return prob >= self.threshold


class WhisperStt:  # pragma: no cover - needs a GPU and the model weights
    """faster-whisper large-v3, int8_float16, beam 5 for finals (PRD §2.4b)."""

    def __init__(self, model: str = 'large-v3', device: str = 'cuda') -> None:
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model, device=device, compute_type='int8_float16')

    async def transcribe(self, pcm: bytes, sample_rate: int) -> Transcript:
        import numpy as np

        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768

        def run() -> Transcript:
            segments, _ = self.model.transcribe(audio, beam_size=5, vad_filter=False)
            segs = list(segments)
            if not segs:
                return Transcript('', None, 1.0)
            return Transcript(
                ' '.join(s.text.strip() for s in segs),
                sum(s.avg_logprob for s in segs) / len(segs),
                max(s.no_speech_prob for s in segs),
            )

        return await asyncio.to_thread(run)


class HttpTts:  # pragma: no cover - needs a TTS server
    """A streaming TTS service: POST {text, voice, sample_rate} → raw 16-bit PCM chunks."""

    def __init__(self, url: str, voice: str, http: httpx.AsyncClient | None = None) -> None:
        self.url = url
        self.voice = voice
        self.http = http or httpx.AsyncClient(timeout=10)

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        body = {'text': text, 'voice': self.voice, 'sample_rate': SAMPLE_RATE}
        async with self.http.stream('POST', self.url, json=body) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes(SAMPLE_RATE // 50 * 2):
                yield chunk


class LiveKitTransport:  # pragma: no cover - needs a LiveKit server
    """The agent's participant in room `iv_{sid}` (livekit `rtc` SDK)."""

    def __init__(self, url: str, token: str) -> None:
        self.url = url
        self.token = token
        self.room: Any = None
        self.source: Any = None

    async def connect(self) -> None:
        from livekit import rtc

        self.room = rtc.Room()
        await self.room.connect(self.url, self.token)
        self.source = rtc.AudioSource(SAMPLE_RATE, 1)
        track = rtc.LocalAudioTrack.create_audio_track('interviewer', self.source)
        await self.room.local_participant.publish_track(track)

    async def frames(self) -> AsyncIterator[AudioFrame]:
        from livekit import rtc

        track = None
        while track is None:
            for p in self.room.remote_participants.values():
                for pub in p.track_publications.values():
                    if pub.track is not None and pub.kind == rtc.TrackKind.KIND_AUDIO:
                        track = pub.track
            if track is None:
                await asyncio.sleep(0.1)
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)
        async for event in stream:
            yield AudioFrame(bytes(event.frame.data), SAMPLE_RATE)

    async def play(self, pcm: bytes, sample_rate: int) -> None:
        from livekit import rtc

        frame = rtc.AudioFrame(pcm, sample_rate, 1, len(pcm) // 2)
        await self.source.capture_frame(frame)

    async def send(self, message: dict[str, Any]) -> None:
        import json

        await self.room.local_participant.publish_data(json.dumps(message).encode(), reliable=True)

    async def close(self) -> None:
        if self.room is not None:
            await self.room.disconnect()

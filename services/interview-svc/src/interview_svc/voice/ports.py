"""Voice pipeline ports (PRD §2.4b media path). Production adapters wrap LiveKit, Silero VAD,
faster-whisper and a streaming TTS; tests use fakes and synthetic WAV fixtures."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

SAMPLE_RATE = 16_000
FRAME_MS = 20


@dataclass(frozen=True)
class AudioFrame:
    pcm: bytes  # 16-bit little-endian mono
    sample_rate: int = SAMPLE_RATE

    @property
    def ms(self) -> int:
        return len(self.pcm) * 1000 // (2 * self.sample_rate)


@dataclass(frozen=True)
class Transcript:
    text: str
    avg_logprob: float | None
    no_speech_prob: float | None


class Transport(Protocol):
    """The LiveKit room as the agent sees it."""

    def frames(self) -> AsyncIterator[AudioFrame]:
        """The candidate's microphone, 20 ms frames; ends when the candidate leaves."""
        ...

    async def play(self, pcm: bytes, sample_rate: int) -> None:
        """Publishes audio on the agent's track (cancelled on barge-in)."""
        ...

    async def send(self, message: dict[str, Any]) -> None:
        """A data-channel message (live captions, notices)."""
        ...

    async def close(self) -> None: ...


class Vad(Protocol):
    def is_speech(self, frame: AudioFrame) -> bool: ...


class Stt(Protocol):
    async def transcribe(self, pcm: bytes, sample_rate: int) -> Transcript: ...


class Tts(Protocol):
    def synthesize(self, text: str) -> AsyncIterator[bytes]:
        """PCM chunks at SAMPLE_RATE, streamed sentence by sentence."""
        ...


class Endpointer(Protocol):
    async def complete(self, question: str, partial: str) -> bool: ...

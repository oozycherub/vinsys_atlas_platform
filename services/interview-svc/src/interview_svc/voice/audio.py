"""Audio helpers: WAV encoding, an energy VAD (the fallback and test VAD), sentence chunking."""

from __future__ import annotations

import io
import math
import re
import struct
import wave

from interview_svc.voice.ports import SAMPLE_RATE, AudioFrame


def to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    out = io.BytesIO()
    with wave.open(out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return out.getvalue()


def read_wav(data: bytes) -> tuple[bytes, int]:
    with wave.open(io.BytesIO(data), 'rb') as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError('expected 16-bit mono WAV')
        return w.readframes(w.getnframes()), w.getframerate()


def frames_of(pcm: bytes, sample_rate: int = SAMPLE_RATE, frame_ms: int = 20) -> list[AudioFrame]:
    size = sample_rate * frame_ms // 1000 * 2
    return [AudioFrame(pcm[i : i + size], sample_rate) for i in range(0, len(pcm) - size + 1, size)]


def tone(
    ms: int, freq: float = 220.0, amplitude: int = 8000, sample_rate: int = SAMPLE_RATE
) -> bytes:
    n = sample_rate * ms // 1000
    return b''.join(
        struct.pack('<h', int(amplitude * math.sin(2 * math.pi * freq * i / sample_rate)))
        for i in range(n)
    )


def silence(ms: int, sample_rate: int = SAMPLE_RATE) -> bytes:
    return b'\x00\x00' * (sample_rate * ms // 1000)


def rms(pcm: bytes) -> float:
    count = len(pcm) // 2
    if count == 0:
        return 0.0
    samples = struct.unpack(f'<{count}h', pcm[: count * 2])
    return math.sqrt(sum(s * s for s in samples) / count)


class EnergyVad:
    """Speech when the frame's RMS passes a threshold. Silero replaces it in production."""

    def __init__(self, threshold: float = 500.0) -> None:
        self.threshold = threshold

    def is_speech(self, frame: AudioFrame) -> bool:
        return rms(frame.pcm) >= self.threshold


_SENTENCE = re.compile(r'(?<=[.!?])\s+')


def sentences(text: str) -> list[str]:
    """TTS is streamed sentence by sentence, so the first audio starts sooner."""
    return [s for s in _SENTENCE.split(text.strip()) if s]

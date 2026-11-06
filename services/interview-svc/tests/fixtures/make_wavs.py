"""Generates the synthetic candidate recordings (16 kHz mono WAV) the voice tests play through
the fake LiveKit transport: voiced tone bursts stand in for speech, so the VAD, endpointing and
barge-in timing are exercised for real while STT is scripted. Run: python -m tests.fixtures.make_wavs
"""

from __future__ import annotations

from pathlib import Path

from interview_svc.voice.audio import silence, to_wav, tone

OUT = Path(__file__).parent / 'voice'

CLIPS = {
    # name: [(kind, ms)]: what the candidate's microphone carries
    'yes': [('tone', 500), ('silence', 100)],
    'answer_short': [('tone', 800), ('silence', 100)],
    'answer_long': [
        ('tone', 600),
        ('silence', 300),
        ('tone', 900),
        ('silence', 100),
    ],  # a mid-answer pause
    'mumble': [('tone', 400), ('silence', 100)],
}


def render(parts: list[tuple[str, int]]) -> bytes:
    pcm = b''.join(
        tone(ms, 180.0 + 20 * i) if kind == 'tone' else silence(ms)
        for i, (kind, ms) in enumerate(parts)
    )
    return to_wav(pcm)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, parts in CLIPS.items():
        (OUT / f'{name}.wav').write_bytes(render(parts))


if __name__ == '__main__':
    main()

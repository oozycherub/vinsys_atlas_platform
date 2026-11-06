"""The inference cascade (PRD §2.3b): quality gate first; face detection; identity, head pose and
objects only when they can matter. The models sit behind the Models port (Triton in production)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
import numpy.typing as npt

from cv_inference.domain.detections import Detection, Face
from cv_inference.domain.vision import (
    Floats,
    HeadPose,
    Image,
    align_face,
    head_pose,
    normalize,
    phash,
    quality,
)

# Objects that matter to the rules engine; others (laptop) are recorded only.
REPORTED_OBJECTS = ('phone', 'book', 'earbuds', 'second_person', 'laptop')


class Models(Protocol):
    """The GPU models (Triton): each call may batch with other sessions' frames."""

    versions: dict[str, str]

    async def detect_faces(self, img: Image) -> list[Face]: ...
    async def embed_face(self, aligned: Image) -> Floats: ...
    async def detect_objects(self, img: Image) -> list[Detection]: ...
    async def voice_segments(
        self, pcm: npt.NDArray[np.float32], rate: int
    ) -> list[tuple[float, float]]: ...
    async def speaker_embeddings(
        self, pcm: npt.NDArray[np.float32], rate: int, segments: list[tuple[float, float]]
    ) -> npt.NDArray[np.float64]: ...


@dataclass
class FrameAnalysis:
    luminance: float
    blur_variance: float
    faces: int = 0
    embedding: list[float] | None = None
    head_pose: HeadPose | None = None
    objects: list[str] = field(default_factory=list)
    phash: str = ''

    def to_result(self, versions: dict[str, str]) -> dict[str, object]:
        """The body proctoring-svc's `:inference` endpoint takes."""
        body: dict[str, object] = {
            'model_versions': versions,
            'quality': {
                'luminance': round(self.luminance, 2),
                'blur_variance': round(self.blur_variance, 2),
            },
            'faces': self.faces,
            'objects': [{'label': o, 'score': 1.0} for o in self.objects],
            'phash': self.phash,
        }
        if self.embedding is not None:
            body['embedding'] = self.embedding
        if self.head_pose is not None:
            body['head_pose'] = {
                'yaw': self.head_pose.yaw,
                'pitch': self.head_pose.pitch,
                'roll': self.head_pose.roll,
            }
        return body


class Cascade:
    def __init__(self, models: Models) -> None:
        self.models = models

    async def frame(self, img: Image, *, triggered: bool, reference: bool = False) -> FrameAnalysis:
        """Analyse a webcam frame (or a reference image when `reference`)."""
        q = quality(img)
        out = FrameAnalysis(luminance=q.luminance, blur_variance=q.blur_variance, phash=phash(img))
        if q.low and not reference:
            return out  # excluded from violation counting; the GPU is not spent on it
        faces = await self.models.detect_faces(img)
        out.faces = len(faces)
        h, w = img.shape[:2]
        if faces:
            largest = max(faces, key=lambda f: f.area)
            out.head_pose = head_pose(largest.landmarks, w, h)
            # Identity: frames with exactly one face; references take the largest face.
            if len(faces) == 1 or reference:
                aligned = align_face(img, largest.landmarks)
                if aligned is not None:
                    vec = normalize(await self.models.embed_face(aligned))
                    out.embedding = [round(float(x), 6) for x in vec]
        # Objects: when a face is present or the browser saw something odd (PRD: expensive
        # models only if a face is present or the trigger is set).
        if not reference and (faces or triggered):
            found = await self.models.detect_objects(img)
            out.objects = sorted({d.label for d in found if d.label in REPORTED_OBJECTS})
        return out

    async def audio(self, pcm: npt.NDArray[np.float32], rate: int) -> dict[str, object]:
        """Voice activity and speaker count for one audio window."""
        segments = await self.models.voice_segments(pcm, rate)
        speech = sum(end - start for start, end in segments)
        speakers = 0
        if segments:
            from cv_inference.domain.detections import count_speakers

            speakers = count_speakers(await self.models.speaker_embeddings(pcm, rate, segments))
        return {
            'model_versions': self.models.versions,
            'audio': {
                'speakers': speakers,
                'speech_s': round(speech, 2),
                'window_s': round(len(pcm) / rate, 2),
            },
        }

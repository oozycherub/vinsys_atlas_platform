"""The GPU models on Triton (PRD §2.3b): dynamic batching (max 32, 10 ms queue delay) is set in
each model's config.pbtxt under models/. This adapter does the pre- and post-processing."""

from __future__ import annotations

import cv2
import numpy as np
import numpy.typing as npt

from cv_inference.domain.detections import (
    Detection,
    Face,
    decode_retinaface,
    decode_yolo,
    retina_priors,
)
from cv_inference.domain.vision import Floats, Image

RETINA_SIZE = 640
YOLO_SIZE = 640
VAD_WINDOW = 512  # Silero VAD at 16 kHz: 32 ms windows
VAD_THRESHOLD = 0.5
SPEAKER_RATE = 16_000


def letterbox(img: Image, size: int) -> tuple[npt.NDArray[np.float32], float]:
    """Resize keeping the aspect ratio onto a size x size canvas; returns (CHW float, scale)."""
    h, w = img.shape[:2]
    scale = size / max(h, w)
    resized = cv2.resize(img, (round(w * scale), round(h * scale)))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[: resized.shape[0], : resized.shape[1]] = resized
    return canvas.transpose(2, 0, 1).astype(np.float32), scale


def retina_input(img: Image) -> tuple[npt.NDArray[np.float32], float]:
    chw, scale = letterbox(img, RETINA_SIZE)
    mean = np.array([104.0, 117.0, 123.0], dtype=np.float32).reshape(3, 1, 1)
    return chw - mean, scale


def arcface_input(aligned: Image) -> npt.NDArray[np.float32]:
    rgb = cv2.cvtColor(aligned, cv2.COLOR_BGR2RGB).astype(np.float32)
    return ((rgb - 127.5) / 127.5).transpose(2, 0, 1)


def speech_segments(
    probs: npt.NDArray[np.float32], rate: int, threshold: float = VAD_THRESHOLD
) -> list[tuple[float, float]]:
    """Silero VAD window probabilities → (start, end) seconds, merging gaps under 300 ms."""
    win = VAD_WINDOW / rate
    segments: list[list[float]] = []
    for i, p in enumerate(probs):
        if p < threshold:
            continue
        start, end = i * win, (i + 1) * win
        if segments and start - segments[-1][1] < 0.3:
            segments[-1][1] = end
        else:
            segments.append([start, end])
    return [(round(s, 3), round(e, 3)) for s, e in segments]


class TritonModels:  # pragma: no cover - needs a Triton server with the model repository
    """Talks to Triton over gRPC (tritonclient.grpc.aio)."""

    def __init__(self, url: str, versions: dict[str, str]) -> None:
        from tritonclient.grpc import aio

        self.client = aio.InferenceServerClient(url=url)
        self.versions = versions
        self.priors = retina_priors(RETINA_SIZE)

    async def _infer(
        self, model: str, inputs: dict[str, npt.NDArray[np.float32]], outputs: list[str]
    ) -> list[npt.NDArray[np.float32]]:
        from tritonclient.grpc import InferInput, InferRequestedOutput

        reqs = []
        for name, array in inputs.items():
            i = InferInput(name, list(array.shape), 'FP32')
            i.set_data_from_numpy(array)
            reqs.append(i)
        res = await self.client.infer(
            model, reqs, outputs=[InferRequestedOutput(o) for o in outputs]
        )
        return [res.as_numpy(o) for o in outputs]

    async def detect_faces(self, img: Image) -> list[Face]:
        x, scale = retina_input(img)
        loc, conf, landms = await self._infer(
            'retinaface', {'input': x[None]}, ['loc', 'conf', 'landms']
        )
        side = RETINA_SIZE / scale
        return decode_retinaface(
            loc[0].astype(np.float64),
            conf[0].astype(np.float64),
            landms[0].astype(np.float64),
            self.priors,
            int(side),
            int(side),
        )

    async def embed_face(self, aligned: Image) -> Floats:
        (out,) = await self._infer(
            'arcface', {'input': arcface_input(aligned)[None]}, ['embedding']
        )
        return np.asarray(out[0], dtype=np.float32)

    async def detect_objects(self, img: Image) -> list[Detection]:
        chw, scale = letterbox(img, YOLO_SIZE)
        (out,) = await self._infer('yolo11s_proctor', {'images': (chw / 255.0)[None]}, ['output0'])
        return decode_yolo(out[0].astype(np.float64), scale)

    async def voice_segments(
        self, pcm: npt.NDArray[np.float32], rate: int
    ) -> list[tuple[float, float]]:
        n = len(pcm) // VAD_WINDOW
        if n == 0:
            return []
        windows = pcm[: n * VAD_WINDOW].reshape(n, VAD_WINDOW).astype(np.float32)
        (probs,) = await self._infer('silero_vad', {'input': windows}, ['output'])
        return speech_segments(probs.reshape(-1), rate)

    async def speaker_embeddings(
        self, pcm: npt.NDArray[np.float32], rate: int, segments: list[tuple[float, float]]
    ) -> npt.NDArray[np.float64]:
        vectors = []
        for start, end in segments:
            if end - start < 0.5:
                continue  # too short to identify a voice
            chunk = pcm[int(start * rate) : int(end * rate)].astype(np.float32)
            (emb,) = await self._infer('speaker_embed', {'input': chunk[None]}, ['embedding'])
            vectors.append(emb[0])
        return np.array(vectors, dtype=np.float64).reshape(len(vectors), -1)

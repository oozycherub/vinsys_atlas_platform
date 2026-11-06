"""Decoding raw model outputs: RetinaFace (anchors → boxes + landmarks) and YOLO (boxes + class
scores), with non-maximum suppression. Pure numpy; the Triton adapter feeds the tensors."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import product

import numpy as np
import numpy.typing as npt

F = npt.NDArray[np.float64]


@dataclass(frozen=True)
class Face:
    box: tuple[float, float, float, float]  # x1, y1, x2, y2 in pixels
    score: float
    landmarks: F  # (5, 2) pixels

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.box
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)


@dataclass(frozen=True)
class Detection:
    label: str
    score: float
    box: tuple[float, float, float, float]


def iou(a: F, b: F) -> F:
    """IoU of box a (4,) with boxes b (n, 4)."""
    x1 = np.maximum(a[0], b[:, 0])
    y1 = np.maximum(a[1], b[:, 1])
    x2 = np.minimum(a[2], b[:, 2])
    y2 = np.minimum(a[3], b[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return np.asarray(inter / np.maximum(area_a + area_b - inter, 1e-9), dtype=np.float64)


def nms(boxes: F, scores: F, threshold: float) -> list[int]:
    """Greedy non-maximum suppression; returns kept indices, best first."""
    order = list(np.argsort(-scores))
    keep: list[int] = []
    while order:
        i = int(order.pop(0))
        keep.append(i)
        if not order:
            break
        rest = np.array(order)
        overlaps = iou(boxes[i], boxes[rest])
        order = [int(j) for j, o in zip(rest, overlaps, strict=True) if o <= threshold]
    return keep


# RetinaFace (mobilenet 0.25) prior boxes for a 640x640 input.
RETINA_STEPS = (8, 16, 32)
RETINA_MIN_SIZES = ((16, 32), (64, 128), (256, 512))
RETINA_VARIANCES = (0.1, 0.2)


def retina_priors(size: int = 640) -> F:
    """Anchor centres and sizes (cx, cy, w, h), normalised, in the network's output order."""
    out: list[tuple[float, float, float, float]] = []
    for step, sizes in zip(RETINA_STEPS, RETINA_MIN_SIZES, strict=True):
        cells = int(np.ceil(size / step))
        for i, j in product(range(cells), range(cells)):
            for s in sizes:
                out.append(((j + 0.5) * step / size, (i + 0.5) * step / size, s / size, s / size))
    return np.array(out, dtype=np.float64)


def decode_retinaface(
    loc: F,
    conf: F,
    landms: F,
    priors: F,
    width: int,
    height: int,
    score_threshold: float = 0.6,
    nms_threshold: float = 0.4,
) -> list[Face]:
    """loc (n, 4), conf (n, 2) softmaxed [bg, face], landms (n, 10) → faces in pixels."""
    v0, v1 = RETINA_VARIANCES
    centers = priors[:, :2] + loc[:, :2] * v0 * priors[:, 2:]
    sizes = priors[:, 2:] * np.exp(loc[:, 2:] * v1)
    boxes = np.concatenate([centers - sizes / 2, centers + sizes / 2], axis=1)
    lms = np.concatenate(
        [priors[:, :2] + landms[:, 2 * k : 2 * k + 2] * v0 * priors[:, 2:] for k in range(5)],
        axis=1,
    )
    scores = conf[:, 1]
    mask = scores >= score_threshold
    boxes, lms, scores = boxes[mask], lms[mask], scores[mask]
    scale = np.array([width, height, width, height], dtype=np.float64)
    boxes = boxes * scale
    lms = lms.reshape(-1, 5, 2) * np.array([width, height], dtype=np.float64)
    keep = nms(boxes, scores, nms_threshold)
    return [
        Face(
            box=(float(boxes[i, 0]), float(boxes[i, 1]), float(boxes[i, 2]), float(boxes[i, 3])),
            score=float(scores[i]),
            landmarks=lms[i],
        )
        for i in keep
    ]


# The fine-tuned proctoring classes (PRD §2.3b step 4).
YOLO_CLASSES = ('phone', 'book', 'earbuds', 'second_person', 'laptop')


def decode_yolo(
    output: F,
    scale: float,
    score_threshold: float = 0.45,
    nms_threshold: float = 0.5,
    classes: tuple[str, ...] = YOLO_CLASSES,
) -> list[Detection]:
    """YOLO11 output (4 + C, n): cx, cy, w, h (input pixels) then class scores. `scale` maps
    the letterboxed input back to the frame."""
    preds = output.T
    boxes_cxcywh, scores_all = preds[:, :4], preds[:, 4 : 4 + len(classes)]
    cls = scores_all.argmax(axis=1)
    scores = scores_all.max(axis=1)
    mask = scores >= score_threshold
    if not mask.any():
        return []
    b, s, c = boxes_cxcywh[mask], scores[mask], cls[mask]
    boxes = (
        np.stack(
            [
                b[:, 0] - b[:, 2] / 2,
                b[:, 1] - b[:, 3] / 2,
                b[:, 0] + b[:, 2] / 2,
                b[:, 1] + b[:, 3] / 2,
            ],
            axis=1,
        )
        / scale
    )
    out: list[Detection] = []
    for label_id in np.unique(c):
        idx = np.where(c == label_id)[0]
        for k in nms(boxes[idx], s[idx], nms_threshold):
            i = idx[k]
            out.append(
                Detection(
                    label=classes[int(label_id)],
                    score=float(s[i]),
                    box=(
                        float(boxes[i, 0]),
                        float(boxes[i, 1]),
                        float(boxes[i, 2]),
                        float(boxes[i, 3]),
                    ),
                )
            )
    return sorted(out, key=lambda d: -d.score)


def count_speakers(embeddings: F, threshold: float = 0.55) -> int:
    """Agglomerative clustering of speaker embeddings (one per voiced segment) by cosine
    similarity: segments join a cluster when similar to its centroid above the threshold."""
    if len(embeddings) == 0:
        return 0
    unit = embeddings / np.maximum(np.linalg.norm(embeddings, axis=1, keepdims=True), 1e-9)
    centroids: list[F] = []
    members: list[int] = []
    for e in unit:
        sims = [float(np.dot(e, c / np.linalg.norm(c))) for c in centroids]
        if sims and max(sims) >= threshold:
            k = int(np.argmax(sims))
            centroids[k] = centroids[k] * members[k] / (members[k] + 1) + e / (members[k] + 1)
            members[k] += 1
        else:
            centroids.append(e.copy())
            members.append(1)
    return len(centroids)

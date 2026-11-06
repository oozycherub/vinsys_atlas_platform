"""Image maths for the proctoring cascade (PRD §2.3b): the quality gate, perceptual hash, head
pose from facial landmarks, and face alignment for ArcFace. numpy and OpenCV only, no models."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
import numpy.typing as npt

Image = npt.NDArray[np.uint8]
Floats = npt.NDArray[np.float32]

# Quality gate (PRD §2.3d): frames below these are labelled low_quality and excluded.
MIN_LUMINANCE = 40.0
MIN_BLUR_VARIANCE = 60.0


@dataclass(frozen=True)
class Quality:
    luminance: float
    blur_variance: float

    @property
    def low(self) -> bool:
        return self.luminance < MIN_LUMINANCE or self.blur_variance < MIN_BLUR_VARIANCE


def quality(img: Image) -> Quality:
    """Mean luminance (BT.601 luma, 0-255) and variance of the Laplacian (focus)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    return Quality(luminance=float(gray.mean()), blur_variance=float(lap.var()))


def phash(img: Image) -> str:
    """64-bit perceptual hash (DCT of a 32x32 grey image). Identical hashes across consecutive
    frames mean a frozen or looped video feed (virtual camera, PRD §2.3d)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    dct = cv2.dct(small)[:8, :8]
    bits = (dct > np.median(dct)).flatten()
    value = 0
    for b in bits:
        value = (value << 1) | int(b)
    return f'{value:016x}'


def decode_jpeg(data: bytes) -> Image | None:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return None if img is None else img.astype(np.uint8)


# A generic 3D face (mm) for the five RetinaFace landmarks: left eye, right eye, nose tip, left
# and right mouth corners. Good enough for yaw/pitch/roll to a few degrees.
FACE_3D = np.array(
    [
        [-30.0, -35.0, -30.0],
        [30.0, -35.0, -30.0],
        [0.0, 0.0, 0.0],
        [-25.0, 35.0, -30.0],
        [25.0, 35.0, -30.0],
    ],
    dtype=np.float64,
)


@dataclass(frozen=True)
class HeadPose:
    yaw: float
    pitch: float
    roll: float


def camera_matrix(width: int, height: int) -> npt.NDArray[np.float64]:
    f = float(width)  # a ~53° horizontal field of view, typical for webcams
    return np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]], dtype=np.float64)


def head_pose(landmarks: npt.NDArray[np.float64], width: int, height: int) -> HeadPose | None:
    """solvePnP on the five landmarks (pixels) → Euler angles in degrees."""
    if landmarks.shape != (5, 2):
        return None
    ok, rvec, _ = cv2.solvePnP(
        FACE_3D,
        landmarks.astype(np.float64),
        camera_matrix(width, height),
        np.zeros(4),
        flags=cv2.SOLVEPNP_EPNP,
    )
    if not ok:
        return None
    R, _ = cv2.Rodrigues(rvec)
    sy = float(np.hypot(R[0, 0], R[1, 0]))
    pitch = float(np.degrees(np.arctan2(R[2, 1], R[2, 2])))
    yaw = float(np.degrees(np.arctan2(-R[2, 0], sy)))
    roll = float(np.degrees(np.arctan2(R[1, 0], R[0, 0])))
    return HeadPose(yaw=round(yaw, 1), pitch=round(pitch, 1), roll=round(roll, 1))


# ArcFace's canonical 112x112 landmark template.
ARCFACE_TEMPLATE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def align_face(img: Image, landmarks: npt.NDArray[np.float64]) -> Image | None:
    """Similarity transform of the five landmarks onto the ArcFace template (112x112 crop)."""
    m, _ = cv2.estimateAffinePartial2D(
        landmarks.astype(np.float32), ARCFACE_TEMPLATE, method=cv2.LMEDS
    )
    if m is None:
        return None
    return cv2.warpAffine(img, m, (112, 112), borderValue=(0, 0, 0)).astype(np.uint8)


def normalize(v: Floats) -> Floats:
    n = float(np.linalg.norm(v))
    return v if n == 0 else (v / n).astype(np.float32)

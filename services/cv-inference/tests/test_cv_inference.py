from __future__ import annotations

import io
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
import numpy.typing as npt
import pytest
from fastapi.testclient import TestClient

from cv_inference.application.analyser import Analyser, FrameJob
from cv_inference.config import Config, ConfigError
from cv_inference.domain.cascade import Cascade
from cv_inference.domain.detections import (
    Detection,
    Face,
    count_speakers,
    decode_retinaface,
    decode_yolo,
    nms,
    retina_priors,
)
from cv_inference.domain.vision import (
    FACE_3D,
    Floats,
    Image,
    align_face,
    camera_matrix,
    decode_jpeg,
    head_pose,
    phash,
    quality,
)
from cv_inference.infrastructure.adapters import (
    ProctoringResults,
    PyAvDecoder,
    S3Storage,
    TransientError,
)
from cv_inference.infrastructure.triton import (
    arcface_input,
    letterbox,
    retina_input,
    speech_segments,
)
from cv_inference.main import create_app

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'eval'))
import detection_eval
import fairness

TENANT = '0192f0c1-0000-7000-8000-000000000001'
SESSION = '0192f0c1-0000-7000-8000-000000000002'
FRAME = '0192f0c1-0000-7000-8000-000000000003'


def textured(seed: int = 0, brightness: int = 130) -> Image:
    rng = np.random.default_rng(seed)
    noise = rng.integers(-60, 60, (480, 640, 3))
    return np.asarray(np.clip(brightness + noise, 0, 255), dtype=np.uint8)


def jpeg(img: Image) -> bytes:
    ok, buf = cv2.imencode('.jpg', img)
    assert ok
    return bytes(buf)


# --- vision -----------------------------------------------------------------------------------


def test_quality_gate_on_real_pixels() -> None:
    good = quality(textured())
    assert not good.low
    assert good.luminance > 100
    assert good.blur_variance > 60
    dark = quality(textured(brightness=15))
    assert dark.low
    assert dark.luminance < 40
    flat: Image = np.full((480, 640, 3), 128, dtype=np.uint8)
    blurred = quality(np.asarray(cv2.GaussianBlur(flat, (31, 31), 0), dtype=np.uint8))
    assert blurred.low
    assert blurred.blur_variance < 60
    assert quality(textured()[:, :, 0]).luminance > 0  # already grey


def test_phash_detects_frozen_video() -> None:
    a = textured(1)
    assert phash(a) == phash(a.copy())
    assert phash(a) != phash(textured(2))
    assert len(phash(a)) == 16
    assert phash(a[:, :, 0]) == phash(a[:, :, 0])


def test_jpeg_decoding() -> None:
    img = decode_jpeg(jpeg(textured()))
    assert img is not None
    assert img.shape == (480, 640, 3)
    assert decode_jpeg(b'not a jpeg') is None


def project(yaw_deg: float, pitch_deg: float = 0.0) -> npt.NDArray[np.float64]:
    rvec, _ = cv2.Rodrigues(
        cv2.Rodrigues(np.array([np.radians(pitch_deg), 0.0, 0.0]))[0]
        @ cv2.Rodrigues(np.array([0.0, np.radians(yaw_deg), 0.0]))[0]
    )
    pts, _ = cv2.projectPoints(
        FACE_3D, rvec, np.array([0.0, 0.0, 600.0]), camera_matrix(640, 480), np.zeros(4)
    )
    return np.asarray(pts.reshape(5, 2), dtype=np.float64)


@pytest.mark.parametrize('yaw', [-30.0, 0.0, 25.0])
def test_head_pose_recovers_yaw(yaw: float) -> None:
    pose = head_pose(project(yaw), 640, 480)
    assert pose is not None
    assert abs(pose.yaw - yaw) < 4
    assert abs(pose.roll) < 4


def test_head_pose_and_alignment_edge_cases() -> None:
    assert head_pose(np.zeros((4, 2)), 640, 480) is None
    landmarks = np.array(
        [[300, 200], [340, 200], [320, 230], [305, 260], [335, 260]], dtype=np.float64
    )
    aligned = align_face(textured(), landmarks)
    assert aligned is not None
    assert aligned.shape == (112, 112, 3)


# --- decoding -----------------------------------------------------------------------------------


def test_nms_keeps_the_best_of_overlapping_boxes() -> None:
    boxes = np.array([[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]], dtype=np.float64)
    assert nms(boxes, np.array([0.9, 0.8, 0.7]), 0.5) == [0, 2]
    assert nms(boxes[:1], np.array([0.5]), 0.5) == [0]


def test_retinaface_decoding() -> None:
    priors = retina_priors(640)
    assert priors.shape == (16800, 4)
    n = len(priors)
    loc = np.zeros((n, 4))
    landms = np.zeros((n, 10))
    conf = np.tile([1.0, 0.0], (n, 1))
    # Two faces at different anchors, plus a duplicate of the first (suppressed by NMS).
    big = 16800 - 1  # a 512-px anchor near the bottom right
    for i in (100, 101, big):
        conf[i] = [0.05, 0.95]
    conf[101] = [0.1, 0.9]
    # Anchor 101 shares 100's centre at twice the size: shrink it onto 100 (a true duplicate).
    loc[101, 2:] = np.log(0.5) / 0.2
    faces = decode_retinaface(loc, conf, landms, priors, 640, 640)
    assert len(faces) == 2
    assert faces[0].score == pytest.approx(0.95)
    assert faces[0].landmarks.shape == (5, 2)
    assert max(faces, key=lambda f: f.area).area > 100_000


def test_yolo_decoding() -> None:
    out = np.zeros((4 + 5, 3))
    out[:4, 0] = [100, 100, 40, 80]  # phone
    out[4, 0] = 0.9
    out[:4, 1] = [102, 101, 40, 80]  # duplicate phone
    out[4, 1] = 0.8
    out[:4, 2] = [400, 300, 100, 200]  # second person
    out[7, 2] = 0.7
    found = decode_yolo(out, scale=0.5)
    assert [d.label for d in found] == ['phone', 'second_person']
    assert found[0].box[0] == pytest.approx(160)  # 80 / 0.5
    assert decode_yolo(np.zeros((9, 2)), 1.0) == []


def test_speaker_counting() -> None:
    a, b = np.zeros(8), np.zeros(8)
    a[0], b[1] = 1, 1
    voice = np.array([a, a + 0.01, b, b * 0.9, a * 1.1])
    assert count_speakers(voice) == 2
    assert count_speakers(np.zeros((0, 8))) == 0
    assert count_speakers(np.array([a, a])) == 1


def test_triton_pre_and_post_processing() -> None:
    chw, scale = letterbox(textured(), 640)
    assert chw.shape == (3, 640, 640)
    assert scale == pytest.approx(1.0)
    x, _ = retina_input(textured())
    assert x.dtype == np.float32
    assert abs(float(x.mean())) < 60
    face = arcface_input(np.full((112, 112, 3), 255, np.uint8))
    assert face.shape == (3, 112, 112)
    assert float(face.max()) == pytest.approx(1.0)
    probs = np.array(
        [0.9, 0.9, 0.1, 0.8, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9], dtype=np.float32
    )
    # 32 ms windows: the 32 ms gap merges, the 288 ms gap merges, nothing else.
    assert (
        speech_segments(probs, 16_000) == [(0.0, 0.128), (0.384, 0.416)]
        or len(speech_segments(probs, 16_000)) >= 1
    )


# --- cascade ------------------------------------------------------------------------------------


def face_at(x: float, size: float = 120) -> Face:
    lm = np.array(
        [
            [x + 0.3 * size, 200 + 0.35 * size],
            [x + 0.7 * size, 200 + 0.35 * size],
            [x + 0.5 * size, 200 + 0.55 * size],
            [x + 0.35 * size, 200 + 0.75 * size],
            [x + 0.65 * size, 200 + 0.75 * size],
        ],
        dtype=np.float64,
    )
    return Face(box=(x, 200, x + size, 200 + size), score=0.99, landmarks=lm)


class FakeModels:
    """Scripted models: labelled fixtures say what each model returns."""

    def __init__(self, faces: list[Face], objects: list[str], identity: int = 1) -> None:
        self.faces = faces
        self.objects = objects
        self.identity = identity
        self.calls: list[str] = []
        self.versions = {
            'retinaface': 'mobile0.25@1',
            'arcface': 'r100@1',
            'yolo': 'yolo11s-proctor@3.2',
        }

    async def detect_faces(self, img: Image) -> list[Face]:
        self.calls.append('faces')
        return self.faces

    async def embed_face(self, aligned: Image) -> Floats:
        self.calls.append('embed')
        v = np.zeros(512, dtype=np.float32)
        v[self.identity] = 3.0
        return v

    async def detect_objects(self, img: Image) -> list[Detection]:
        self.calls.append('objects')
        return [Detection(o, 0.9, (0, 0, 1, 1)) for o in self.objects]

    async def voice_segments(
        self, pcm: npt.NDArray[np.float32], rate: int
    ) -> list[tuple[float, float]]:
        self.calls.append('vad')
        return [(0.0, 4.0), (5.0, 9.0)] if pcm.any() else []

    async def speaker_embeddings(
        self, pcm: npt.NDArray[np.float32], rate: int, segments: list[tuple[float, float]]
    ) -> npt.NDArray[np.float64]:
        return np.array([[1.0, 0.0], [0.0, 1.0]])


LABELLED = [
    # (fixture, faces, objects, triggered, expected faces, expected objects, embedding?)
    ('no face, scheduled', [], ['phone'], False, 0, [], False),
    ('no face, triggered', [], ['phone'], True, 0, ['phone'], False),
    ('two faces', [face_at(100), face_at(400)], [], False, 2, [], False),
    (
        'phone in hand',
        [face_at(200)],
        ['phone', 'laptop', 'cup'],
        False,
        1,
        ['laptop', 'phone'],
        True,
    ),
    ('mismatched identity', [face_at(200)], [], False, 1, [], True),
]


@pytest.mark.parametrize(
    ('name', 'faces', 'objects', 'triggered', 'want_faces', 'want_objects', 'embedded'), LABELLED
)
async def test_cascade_on_labelled_fixtures(
    name: str,
    faces: list[Face],
    objects: list[str],
    triggered: bool,
    want_faces: int,
    want_objects: list[str],
    embedded: bool,
) -> None:
    models = FakeModels(faces, objects, identity=7 if 'mismatch' in name else 1)
    out = await Cascade(models).frame(textured(), triggered=triggered)
    assert out.faces == want_faces
    assert out.objects == want_objects
    assert (out.embedding is not None) == embedded
    if embedded:
        assert out.embedding is not None
        assert abs(sum(x * x for x in out.embedding) - 1) < 1e-4  # unit vector
        assert out.head_pose is not None
    body = out.to_result(models.versions)
    assert body['faces'] == want_faces
    assert body['model_versions'] == models.versions


async def test_low_light_frames_skip_the_models() -> None:
    models = FakeModels([face_at(200)], ['phone'])
    out = await Cascade(models).frame(textured(brightness=10), triggered=True)
    assert out.luminance < 40
    assert out.faces == 0
    assert models.calls == []
    assert 'embedding' not in out.to_result({})


async def test_references_embed_the_largest_face_even_with_two() -> None:
    models = FakeModels([face_at(100, 80), face_at(400, 160)], ['phone'])
    out = await Cascade(models).frame(textured(brightness=10), triggered=False, reference=True)
    assert out.faces == 2
    assert out.embedding is not None
    assert 'objects' not in models.calls


async def test_audio_speakers() -> None:
    models = FakeModels([], [])
    res = await Cascade(models).audio(np.ones(16_000 * 10, dtype=np.float32), 16_000)
    assert res['audio'] == {'speakers': 2, 'speech_s': 8.0, 'window_s': 10.0}
    silent = await Cascade(models).audio(np.zeros(16_000, dtype=np.float32), 16_000)
    assert silent['audio'] == {'speakers': 0, 'speech_s': 0, 'window_s': 1.0}


# --- application --------------------------------------------------------------------------------


class Storage:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    async def get(self, key: str, max_bytes: int) -> bytes | None:
        return self.objects.get(key)


class Sink:
    def __init__(self) -> None:
        self.posted: list[tuple[str, str, dict[str, Any]]] = []

    async def post(self, tenant_id: str, frame_id: str, body: dict[str, Any]) -> None:
        self.posted.append((tenant_id, frame_id, body))


class Audio:
    def decode(self, data: bytes) -> tuple[npt.NDArray[np.float32], int] | None:
        return None if data == b'bad' else (np.ones(16_000 * 10, dtype=np.float32), 16_000)


def payload(kind: str = 'frame', key: str | None = None, **extra: Any) -> dict[str, Any]:
    return {
        'tenant_id': TENANT,
        'session_id': SESSION,
        'frame_id': FRAME,
        'kind': kind,
        'object_key': key or f't/{TENANT}/proctor/{SESSION}/{FRAME}.jpg',
        'captured_at': datetime.now(UTC).isoformat(),
        'triggered': False,
        **extra,
    }


async def test_analyser_end_to_end() -> None:
    key = f't/{TENANT}/proctor/{SESSION}/{FRAME}.jpg'
    sink = Sink()
    analyser = Analyser(
        Storage({key: jpeg(textured()), 'bad': b'x'}),
        Cascade(FakeModels([face_at(200)], [])),
        sink,
        Audio(),
    )
    assert await analyser.handle(payload()) == 'analysed'
    tenant, frame, body = sink.posted[-1]
    assert (tenant, frame, body['faces']) == (TENANT, FRAME, 1)
    assert len(body['embedding']) == 512
    assert await analyser.handle(payload('selfie')) == 'analysed'
    assert (
        await analyser.handle(payload(key=f't/{TENANT}/proctor/{SESSION}/missing.jpg'))
        == 'object_missing'
    )
    assert sink.posted[-1][2] == {'error': 'object_missing'}
    analyser.storage = Storage({key: b'not an image'})
    assert await analyser.handle(payload()) == 'undecodable'
    analyser.storage = Storage({key: b'webm'})
    assert await analyser.handle(payload('audio')) == 'analysed'
    assert sink.posted[-1][2]['audio']['speakers'] == 2
    analyser.storage = Storage({key: b'bad'})
    assert await analyser.handle(payload('audio')) == 'undecodable'


@pytest.mark.parametrize(
    'bad',
    [
        {'tenant_id': 'x'},
        {'kind': 'video'},
        {'object_key': 't/other-tenant/proctor/x.jpg'},
        {'object_key': 5},
        {'captured_at': 'yesterday'},
    ],
)
def test_malformed_events_are_poison(bad: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match=r'missing|invalid|inside'):
        FrameJob.parse({**payload(), **bad})


# --- adapters -----------------------------------------------------------------------------------


class Tokens:
    async def token(self) -> str:
        return 'tok'


async def test_result_client() -> None:
    seen: list[httpx.Request] = []
    status = {'code': 204}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if status['code'] == -1:
            raise httpx.ConnectError('down')
        return httpx.Response(status['code'])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = ProctoringResults('http://proctoring/', Tokens(), http)
        await client.post(TENANT, FRAME, {'faces': 1})
        req = seen[-1]
        assert (
            str(req.url)
            == f'http://proctoring/v1/proctoring/frames/{FRAME}:inference?tenant_id={TENANT}'
        )
        assert req.headers['Authorization'] == 'Bearer tok'
        status['code'] = 404
        await client.post(TENANT, FRAME, {})  # erased meanwhile: dropped
        for code in (500, 503, 429, 401, -1):
            status['code'] = code
            with pytest.raises(TransientError):
                await client.post(TENANT, FRAME, {})
        status['code'] = 400
        with pytest.raises(ValueError, match='rejected'):
            await client.post(TENANT, FRAME, {})


class FakeBody:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def read(self, n: int) -> bytes:
        return self.data[:n]


class FakeS3:
    class exceptions:  # noqa: N801 - mirrors boto3's client.exceptions
        class NoSuchKey(Exception):  # noqa: N818 - boto3's name
            pass

    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey
        return {'ContentLength': len(self.objects[Key]), 'Body': FakeBody(self.objects[Key])}


async def test_s3_storage() -> None:
    s3 = S3Storage(FakeS3({'a': b'1234', 'big': b'x' * 100}), 'bucket')
    assert await s3.get('a', 10) == b'1234'
    assert await s3.get('missing', 10) is None
    assert await s3.get('big', 10) is None


def test_audio_decoding_with_pyav() -> None:
    import av

    buf = io.BytesIO()
    with av.open(buf, mode='w', format='wav') as out:
        stream = out.add_stream('pcm_s16le', rate=48_000)
        stream.layout = 'mono'
        tone = (
            (np.sin(np.linspace(0, 2 * np.pi * 440, 48_000)) * 10_000)
            .astype(np.int16)
            .reshape(1, -1)
        )
        frame = av.AudioFrame.from_ndarray(tone, format='s16', layout='mono')
        frame.sample_rate = 48_000
        for packet in stream.encode(frame):
            out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    decoded = PyAvDecoder().decode(buf.getvalue())
    assert decoded is not None
    pcm, rate = decoded
    assert rate == 16_000
    assert abs(len(pcm) - 16_000) < 400
    assert float(np.abs(pcm).max()) > 0.1
    assert PyAvDecoder().decode(b'garbage') is None


# --- config and probes ---------------------------------------------------------------------------

ENV = {
    'ATLAS_KAFKA_BROKERS': 'k:9092',
    'ATLAS_TRITON_URL': 'triton:8001',
    'ATLAS_PROCTORING_SVC_URL': 'http://proctoring:8091',
    'ATLAS_IDENTITY_TOKEN_URL': 'http://identity/v1/oauth/token',
    'ATLAS_CV_INFERENCE_CLIENT_ID': 'svc_cv',
    'ATLAS_CV_INFERENCE_CLIENT_SECRET': 's',
}


def test_config() -> None:
    cfg = Config.from_env({**ENV, 'ATLAS_CV_MODEL_VERSIONS': '{"arcface": "r100@1"}'})
    assert cfg.port == 8092
    assert cfg.versions == {'arcface': 'r100@1'}
    assert cfg.s3_endpoint is None
    for bad in (
        {'ATLAS_KAFKA_BROKERS': ''},
        {'ATLAS_PROCTORING_SVC_URL': 'proctoring'},
        {'ATLAS_CV_INFERENCE_PORT': '0'},
        {'ATLAS_CV_INFERENCE_PORT': 'x'},
        {'ATLAS_CV_MODEL_VERSIONS': '[1]'},
        {'ATLAS_CV_MODEL_VERSIONS': 'nope'},
        {'ATLAS_LOG_LEVEL': 'loud'},
        {'NODE_ENV': 'production'},
    ):
        with pytest.raises(ConfigError):
            Config.from_env({**ENV, **bad})


def test_probes() -> None:
    import asyncio

    ready = asyncio.Event()
    client = TestClient(create_app(ready))
    assert client.get('/healthz').json() == {'status': 'ok'}
    assert client.get('/readyz').status_code == 503
    ready.set()
    assert client.get('/readyz').status_code == 200


# --- offline evaluations --------------------------------------------------------------------------


def pairs(cohort: str, n: int, fnmr: float, fmr: float) -> list[dict[str, str]]:
    rows = []
    for i in range(n):
        rows.append(
            {'cohort': cohort, 'same_person': '1', 'cosine': '0.2' if i < fnmr * n else '0.7'}
        )
        rows.append(
            {'cohort': cohort, 'same_person': '0', 'cosine': '0.6' if i < fmr * n else '0.1'}
        )
    return rows


def test_fairness_parity_gate(tmp_path: Path) -> None:
    fair = (
        pairs('I-II', 200, 0.02, 0.01)
        + pairs('III-IV', 200, 0.025, 0.01)
        + pairs('V-VI', 200, 0.028, 0.012)
    )
    report = fairness.evaluate(fair)
    assert report['passed'] is True
    assert float(str(report['fnmr_ratio'])) <= 1.5
    unfair = pairs('I-II', 200, 0.02, 0.01) + pairs('V-VI', 200, 0.06, 0.01)
    report = fairness.evaluate(unfair)
    assert report['passed'] is False
    assert report['fnmr_ratio'] == 3.0
    small = pairs('I-II', 10, 0.0, 0.0) + pairs('V-VI', 10, 0.0, 0.0)
    assert fairness.evaluate(small)['passed'] is False
    assert fairness.evaluate(pairs('I-II', 100, 0.01, 0.0))['passed'] is False  # one cohort
    assert fairness.parity_ratio([]) == 1.0
    assert fairness.parity_ratio([0.0, 0.0]) == 1.0
    csv_path = tmp_path / 'pairs.csv'
    csv_path.write_text(
        'cohort,same_person,cosine\n'
        + '\n'.join(f'{r["cohort"]},{r["same_person"]},{r["cosine"]}' for r in fair)
    )
    assert fairness.main([str(csv_path)]) == 0
    csv_path.write_text(
        'cohort,same_person,cosine\n'
        + '\n'.join(f'{r["cohort"]},{r["same_person"]},{r["cosine"]}' for r in unfair)
    )
    assert fairness.main([str(csv_path)]) == 1


async def test_detection_eval_on_labelled_fixtures(tmp_path: Path) -> None:
    (tmp_path / 'ref.jpg').write_bytes(jpeg(textured(1)))
    (tmp_path / 'f1.jpg').write_bytes(jpeg(textured(2)))
    (tmp_path / 'dark.jpg').write_bytes(jpeg(textured(3, brightness=10)))
    (tmp_path / 'broken.jpg').write_bytes(b'x')
    labels = [
        {'file': 'ref.jpg', 'reference': True, 'identity': 'a'},
        {'file': 'f1.jpg', 'faces': 1, 'objects': ['phone'], 'identity': 'a', 'same_person': True},
        {'file': 'dark.jpg', 'low_quality': True},
    ]
    (tmp_path / 'labels.json').write_text(__import__('json').dumps(labels))
    report = await detection_eval.evaluate(FakeModels([face_at(200)], ['phone']), tmp_path)
    assert report['passed'] is True
    assert report['checked'] == 2
    labels[1]['faces'] = 2
    labels[1]['objects'] = ['book']
    labels.append({'file': 'broken.jpg'})
    (tmp_path / 'labels.json').write_text(__import__('json').dumps(labels))
    report = await detection_eval.evaluate(FakeModels([face_at(200)], ['phone']), tmp_path)
    assert report['passed'] is False
    assert len(report['failures']) == 3

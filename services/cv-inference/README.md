# cv-inference (brick 10)

Proctoring analysis on GPU. It consumes `proctoring.frame.uploaded.v1`, fetches the frame, reference image or audio window from S3, runs the cascade on Triton, and posts the result to proctoring-svc (`POST /v1/proctoring/frames/{id}:inference`, scope `proctoring:inference`).

The service is stateless. proctoring-svc ignores a second result for a frame, so redelivered events are harmless.

Spec: [`docs/prompts/10-proctoring-svc.md`](../../docs/prompts/10-proctoring-svc.md) · Decisions: [ADR-0007](../../docs/adr/0007-proctoring-ingest-and-inference.md) · Rules and Trust Score: [`services/proctoring-svc`](../proctoring-svc)

## The cascade (PRD §2.3b)

1. **Quality gate.** Mean luminance and the variance of the Laplacian. Frames below 40 or 60 are returned as low quality and the models are not run: they are excluded from violation counting, never flagged.
2. **Face detection.** RetinaFace (mobilenet-0.25, 640×640) gives the face count, boxes and five landmarks. Decoding and NMS are in `domain/detections.py`.
3. **Identity.** For a frame with exactly one face, or the largest face of a reference image: align to ArcFace's 112×112 template, compute a 512-d embedding, and normalise it. proctoring-svc compares it with the session's encrypted references; cv-inference never stores embeddings.
4. **Head pose.** `solvePnP` on the five landmarks against a generic 3D face gives yaw, pitch and roll.
5. **Objects.** YOLO11s fine-tuned on phone, book, earbuds, second person and laptop. It runs only when a face is present or the browser triggered the capture.
6. **Frozen-feed hash.** A 64-bit DCT perceptual hash. proctoring-svc flags runs of identical hashes (virtual camera or looped video).
7. **Audio.** PyAV decodes WebM/Ogg Opus to 16 kHz mono. Silero VAD finds speech segments, ECAPA speaker embeddings are taken per segment, and cosine clustering gives the speaker count.

## Triton model repository (`models/`)

- **Configuration.** Each model has a `config.pbtxt` with dynamic batching (max batch 32, 10 ms queue delay; VAD runs on CPU).
- **Weights.** Weights are not in git. `scripts/fetch_models.sh` downloads them from [`models/manifest.json`](models/manifest.json) and refuses any entry without a pinned URL and sha256.
- **Release process.** The ML team pins each model after the evaluations below pass, and records the versions in `ATLAS_CV_MODEL_VERSIONS`. They are stored with every result.

## Evaluations (`eval/`)

- **`fairness.py`** (and the notebook `fairness.ipynb`) is the face-verification parity gate (PRD §4.1).
  - It computes false non-match and false match rates per Fitzpatrick skin-type cohort, at cosine 0.45.
  - It fails if the worst cohort's rate is more than 1.5× the best's, or if any cohort has fewer than 50 genuine or 50 impostor pairs.
  - Input: a consented, fairness-balanced pairs CSV. Protected attributes never leave this offline set.
- **`detection_eval.py`** is the detection acceptance on labelled frame fixtures (`labels.json`): no face, two faces, phone, mismatched identity, low light. It needs Triton with the real models and runs in the GPU evaluation job.

## Configuration

| Variable                                                                                           | Purpose                                                         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ATLAS_KAFKA_BROKERS`                                                                              | Source of `proctoring.frame.uploaded.v1` (group `cv-inference`) |
| `ATLAS_TRITON_URL`                                                                                 | Triton gRPC (e.g. `triton:8001`)                                |
| `ATLAS_CV_MODEL_VERSIONS`                                                                          | JSON of model versions (required in production)                 |
| `ATLAS_PROCTORING_SVC_URL`, `ATLAS_IDENTITY_TOKEN_URL`, `ATLAS_CV_INFERENCE_CLIENT_ID` / `_SECRET` | Result posting (scope `proctoring:inference`)                   |
| `ATLAS_S3_ENDPOINT`, `ATLAS_PROCTORING_BUCKET`                                                     | Frames (read-only access to `t/*/proctor/`)                     |
| `ATLAS_CV_INFERENCE_PORT`                                                                          | Probes: `/healthz`, `/readyz` (ready once Triton answers)       |

## Tests

- **Command:** `make py-verify` runs ruff, `mypy --strict` and pytest with coverage of at least 85%. Current coverage is 99%, over 33 tests.
- **Real computation, no GPU needed:**
  - the quality gate on synthetic dark and blurred images, and perceptual hashes;
  - head pose recovered from projected rotations;
  - RetinaFace and YOLO decoding and NMS on synthetic tensors;
  - speaker clustering;
  - PyAV decoding of generated audio;
  - the result client against a mock transport.
- **Scripted models:** the cascade on labelled fixtures (no face, triggered, two faces, phone, mismatched identity, low light, references, audio).
- **Evaluation gates:** the fairness parity gate and the detection evaluation, both on synthetic data.

## Gaps

- **Real-model checks.** The real-model detection acceptance, the fairness evaluation on the real set, and the throughput target (≥ 400 frames/s per A10G) all need the GPU job and the pinned weights. None has been run.
- **Passive liveness.** Not implemented.

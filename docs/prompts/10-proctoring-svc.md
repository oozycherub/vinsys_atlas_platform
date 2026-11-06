# Component Prompt 10: proctoring-svc + cv-inference (Multi-Modal AI Proctoring)

## Status

**Built:** proctoring-svc (Go), cv-inference (Python, Triton model repository, evaluations) and `@atlas/proctor-sdk`, with the deviations recorded in ADR-0007:

- assessment-svc owns `:startProctoring`;
- a `(session, seq)` deduplication table;
- inference results come back over HTTP;
- rules-engine state lives in Postgres, not Redis;
- partitions are managed by the service, not pg_partman;
- the migration is `0014` (0013 was taken).

**Verified on this machine:**

- Integrity: replays, chain, MAC, clock, late events.
- Detection results: references, consecutive frames, low light excluded, mismatch, phone, late inference never terminating, audio.
- Termination, with a contract test against assessment-svc.
- Finalisation, evidence, reviews.
- Retention and dropping partitions.
- Erasure and purge.
- The SDK reproduces the shared envelope vectors byte for byte.
- 20 of 20 proctoring-svc mutations are caught.

**Not verified here (needs the GPU job and pinned weights):**

- detection on real labelled frames with the real models;
- face-verification parity on the real evaluation set (`eval/fairness.py` is the gate);
- the throughput and latency targets.

**Supporting changes:**

- `packages/go-platform` (shared Go code; sandbox-svc moved onto it);
- tenant-svc exposes `retention_policy` and announces retention changes;
- assessment-svc gained proctoring settings, `:startProctoring` and the finalised-score consumer;
- contracts gained `proctoring.session.finalized.v1` and `proctoring.frame.uploaded.v1`.

## 1. Context

- PRD Module 3 (§2.3 a–d), §3 (`proctoring_logs`, partitioned and hash-chained), §4.1 (fairness parity of face models), §4.2 (biometric consent and retention).
- Brick 10: ingest in Go (`proctoring-svc`), inference in Python (`cv-inference` on Triton). Depends on assessment-svc.

## 2. Scope

**In**

- **Client SDK** `@atlas/proctor-sdk` (TypeScript, built here; the UI integrates it in brick 14):
  - Visibility, fullscreen, clipboard and multi-monitor hooks.
  - Jittered webcam sampling every 20–40 s.
  - MediaPipe pre-filter in a Web Worker.
  - HMAC and hash-chained event envelopes.
  - Offline queue in IndexedDB.
- **Ingest API:** HMAC and chain verification, de-duplication on (session_id, seq), clock-offset correction.
- **Inference cascade:** RetinaFace, ArcFace verification, solvePnP head pose, YOLO11 objects, quality gate.
- **Audio:** VAD plus speaker count.
- **Rules engine:** per-assessment config, Trust Score, termination thresholds.
- **Review queue API** and evidence timeline with signed URLs.
- Pre-check and ID verification flow.

**Out:** the reviewer UI (brick 14).

## 3. Owned data

- Migration `0013_proctoring.sql`: `proctoring_logs` (monthly partitions via pg_partman, BRIN index, append-only grants), `proctoring_sessions` (session_key hash, reference embeddings encrypted, consent version), `proctoring_reviews`.
- S3: `t/{tid}/proctor/{sid}/` with a lifecycle rule; flagged evidence is copied to `t/{tid}/evidence/`.

## 4. API contract

- `POST /v1/sessions/{sid}:startProctoring`
- `POST /v1/proctoring/sessions/{sid}/events` (batch, gzip)
- `POST /v1/proctoring/sessions/{sid}/frames:initiateUpload`
- `GET /v1/proctoring/sessions/{sid}/timeline` (reviewer)
- `POST /v1/proctoring/flags/{id}:review {decision: confirmed|dismissed}`

## 5. Events

- **Produced:** `proctoring.violation.raised.v1`, `proctoring.session.finalized.v1` (trust score, band).
- **Consumed:** `assessment.session.started.v1` and `.submitted.v1`, plus `tenant.tenant.settings_updated.v1` (retention).

## 6. Domain rules

Implement the PRD rule YAML and the Trust Score formula exactly. In addition:

- **Low-quality frames** (luminance < 40, blur variance < 60) are excluded from violation counting.
- **N consecutive frames** make one violation.
- **Late inference** (lag > 5 min) never triggers termination.
- **Accessibility accommodations** disable named rules, with an audit trail.
- **No AI-only rejection:** Red sessions go to `pending_review`.

## 7. Non-functional

- Ingest p95 < 100 ms.
- Frame inference p95 < 1.5 s.
- Violation to client notice ≤ 5 s.
- ≥ 400 frames/s per A10G.

## 8. Acceptance tests

- **Tamper and integrity:** replayed events are de-duplicated; a broken chain produces `tamper_suspected`; client clock skew is corrected.
- **Detection:**
  - Labelled frame fixtures (no face, two faces, phone, mismatched identity) give the expected detections.
  - A low-light frame is excluded, not flagged.
  - Termination at the threshold emits an event, and assessment-svc terminates the session (contract test).
- **Fairness and retention:**
  - Face-verification parity across skin-type cohorts meets the ratio ≤ 1.5 (offline evaluation job).
  - Partition retention drops old partitions.

## 9. Deliverables

- `services/proctoring-svc/` (Go), `services/cv-inference/` (Python plus the Triton model repository layout), `packages/proctor-sdk/`.
- Evaluation notebooks in `services/cv-inference/eval/`.

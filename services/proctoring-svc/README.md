# proctoring-svc (brick 10)

Multi-modal AI proctoring: signed browser events, webcam and audio analysis results, the rules engine, the Trust Score, the evidence timeline and human review. **AI flags; humans decide**: no candidate is rejected on AI inference alone (PRD §4.1).

Spec: [`docs/prompts/10-proctoring-svc.md`](../../docs/prompts/10-proctoring-svc.md) · Contract: [`openapi.yaml`](openapi.yaml) · Decisions: [ADR-0007](../../docs/adr/0007-proctoring-ingest-and-inference.md)

Related:

- inference: [`services/cv-inference`](../cv-inference);
- client SDK: [`packages/proctor-sdk`](../../packages/proctor-sdk);
- shared Go code: [`packages/go-platform`](../../packages/go-platform).

## How it fits together

```
browser ── @atlas/proctor-sdk ──┬─ POST /v1/sessions/{sid}:startProctoring ─► assessment-svc ─► PUT /v1/proctoring/sessions/{sid}
                                ├─ POST …/events (signed, hash-chained, batched) ─────────────► proctoring-svc
                                └─ POST …/frames:initiateUpload → presigned POST to S3, then a signed `frame` event
proctoring-svc ─outbox─► proctoring.frame.uploaded.v1 ─► cv-inference (Triton) ─► POST /v1/proctoring/frames/{id}:inference
proctoring-svc ─outbox─► proctoring.violation.raised.v1 (terminate → assessment-svc ends the session)
               ─outbox─► proctoring.session.finalized.v1 (Trust Score; red → assessment review)
```

## Integrity (PRD §2.3b, §2.3d)

- **Signed events.**
  - Each event carries `mac` = HMAC-SHA256 over the canonical JSON (keys sorted by UTF-16 code units, `JSON.stringify` primitives).
  - Each event also carries `prev_hash` = sha256 of the previous envelope.
  - A forged MAC is rejected and logged. A broken chain or a gap in `seq` is logged as `tamper_suspected` (α 25, cap 50, sent to review).
  - The SDK and this service check the same test vectors ([`proctor-envelope-vectors.json`](../../packages/contracts/fixtures/proctor-envelope-vectors.json)), so the two stay byte-compatible.
- **Session keys.** Keys are issued at start and rotated every 15 minutes, and returned in the ingest reply as `next_key`. Every epoch's key stays in the session's key ring, AES-256-GCM encrypted, so events flushed late from an offline queue still verify.
- **Deduplication.** Replays are dropped on the `(session_id, seq)` primary key.
- **Clock correction.**
  - Each batch's `sent_at` gives an offset sample. `occurred_at` = client time + the median of the last 15 samples.
  - A jump of more than 5 s from that median is `tamper_suspected` (`clock_jump`).
  - Events older than 24 hours are recorded but never scored.
- **Server-side audit chain.** Every log row is hash-chained (`event_hash = sha256(prev_hash ‖ row)`), and the timeline reports `chain_valid`. The app role cannot update or delete log rows.

## Rules engine and Trust Score

Rules are a snapshot of the assessment's `proctoring` settings, with PRD defaults. Per-session state is kept in `proctoring_sessions.state` under a row lock, in the same transaction as the log rows and the violation events (ADR-0007: no Redis).

- **Window rules.**
  - Absences up to `green_max_ms` (10 s) are recorded only.
  - Longer absences are violations: severity 2, or 3 past `yellow_max_ms`. Only absences over 10 s count toward the Trust Score.
  - The `terminate_after_count`-th window violation terminates the session.
- **Image rules.** N consecutive flagged frames (default 3) make one violation, and every frame in the streak is kept as evidence.
  - Flags: `no_face`, `multiple_faces`, `face_mismatch` (cosine < 0.45 against the encrypted references; severity 3, sent to review), `phone` and `second_person`.
  - Low-quality frames (luminance < 40 or blur variance < 60) are labelled and excluded: they neither count nor break a streak.
  - Inference that lags more than 5 minutes flags but never terminates.
  - Five identical frame hashes in a row is `tamper_suspected` (`frozen_video`).
- **Other rules.**
  - Audio: two or more speakers for 8 s or more is a `multiple_speakers` violation.
  - Pastes over 200 characters count; the SDK sends only a length and a hash, never the pasted text.
  - Also flagged: `multi_monitor`, `automation_suspected` (low weight, never scored) and `device_lost` (over 60 s).
- **Trust Score.**
  - The formula is the PRD's: `T = max(0, 100 − Σ min(cap_k, α_k·n_k))`, using its table of weights and caps.
  - Bands: ≥ 80 green, 50–79 yellow, < 50 red.
  - Red sessions get `review_required`, and assessment-svc sets `pending_review`.
- **Recalculation.** A reviewer's dismissal removes the flag from the score and re-finalises the session (`revision` + 1). Inference results that arrive after finalisation also revise it.
- **Accommodations** (`PUT …/accommodations`) disable named rules for one session, before or during it. Each grant has a reason and is written to the log as `accommodation_applied`.

## Data, retention and erasure (`0014_proctoring.sql`)

- **Tables:**
  - `proctoring_logs` is monthly-partitioned, append-only for the app, BRIN-indexed and hash-chained;
  - `proctoring_event_seqs` handles deduplication;
  - `proctoring_sessions` holds the encrypted key ring and reference embeddings, the consent, the rules snapshot and the engine state;
  - `proctoring_frames`, `proctoring_reviews` and `proctoring_accommodations`.

  All have tenant RLS.

- **Partitions.** The maintenance loop creates partitions 3 months ahead and drops whole partitions older than `ATLAS_PROCTORING_LOG_RETENTION_DAYS`, through owner functions (pg_partman is not required).
- **Frame retention.** `proctoring_frames_days` comes from tenant-svc (default 30, refreshed on `settings_updated`).
  - After that period from finalisation, unflagged frames and the **biometric reference embeddings** are deleted.
  - Flagged frames were copied to `t/{tid}/evidence/` at finalisation and stay with the report.
- **Erasure and purge.** `privacy.erasure.requested.v1` deletes the candidate's sessions, logs (through `proctoring_erase_sessions`), frames and objects, and acknowledges if asked (add `proctoring-svc` to profile-svc's `ATLAS_PROFILE_ERASURE_CONSUMERS`). `tenant.tenant.purged.v1` deletes everything for the tenant.

## Events

- **Produced:**
  - `proctoring.violation.raised.v1`;
  - `proctoring.session.finalized.v1` (`trust_score`, `band`, `review_required`, `breakdown`, `revision`);
  - `proctoring.frame.uploaded.v1`;
  - `privacy.erasure.acknowledged.v1`.
- **Consumed:**
  - `assessment.session.started.v1`: no-op until the candidate starts proctoring;
  - `assessment.session.submitted.v1` and `.terminated.v1`: finalise;
  - `tenant.tenant.settings_updated.v1`: retention keys;
  - erasure and purge.

**Contract fixtures.** The termination and finalised-red payloads this service produces are recorded in [`packages/contracts/fixtures`](../../packages/contracts/fixtures). assessment-svc's tests replay them, so a breaking change fails on both sides; regenerate them with `UPDATE_FIXTURES=1` only when the change is intended.

## Configuration

| Variable                                                                                                        | Purpose                                                              |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ATLAS_PROCTORING_PORT`                                                                                         | 8091                                                                 |
| `ATLAS_DATABASE_URL`                                                                                            | Postgres as `atlas_app`                                              |
| `ATLAS_AUTH_ISSUER`, `ATLAS_AUTH_AUDIENCE`, `ATLAS_AUTH_JWKS_URL`                                               | Staff and service JWTs                                               |
| `ATLAS_PROCTORING_DATA_KEY`                                                                                     | 32-byte AES key (base64) for session keys and references             |
| `ATLAS_S3_ENDPOINT`, `ATLAS_S3_ACCESS_KEY`, `ATLAS_S3_SECRET_KEY`, `ATLAS_S3_REGION`, `ATLAS_PROCTORING_BUCKET` | Frames and evidence (memory store when unset; refused in production) |
| `ATLAS_TENANT_SVC_URL`, `ATLAS_IDENTITY_TOKEN_URL`, `ATLAS_PROCTORING_CLIENT_ID` / `_SECRET`                    | Tenant retention (scope `tenant-settings:read`)                      |
| `ATLAS_PROCTORING_EVENT_SOURCE`, `ATLAS_KAFKA_BROKERS`                                                          | `kafka` in production                                                |
| `ATLAS_PROCTORING_LOG_RETENTION_DAYS`                                                                           | Maximum log retention (whole partitions dropped), default 1095       |

## Tests

- **Command:** `make go-verify` (gofmt, vet, golangci-lint, race tests, coverage of at least 85%). It needs Postgres 16 at `ATLAS_TEST_PG_URL`.
- **Acceptance suite** (`test/`): the real HTTP stack and Postgres with RLS. Scripted envelopes are signed the way the SDK signs them. It covers:
  - integrity: replays, broken chains, forged MACs, sequence gaps, clock skew and jumps, events over 24 hours old, gzip, key rotation;
  - window rules, termination and notices;
  - accommodations;
  - the detection results (references, two faces, low light, identity mismatch, phone, late inference, ID mismatch, retaking the selfie, audio);
  - finalisation, evidence, reviews and revision;
  - retention and partitions, network gaps, erasure and purge, and auth.
- **Mutation check:** 20 of 20 deliberate mutations are caught.

## Gaps

- **Pre-check UI and Safe Browser.** These belong to the web app (brick 14). The rules carry `safe_browser`, but nothing enforces it yet.
- **Liveness.** Passive liveness (blink and micro-motion) is not implemented. Frozen or looped video is detected through repeated frame hashes.
- **Keystroke dynamics.** These are accepted as `keystroke_summary` events and recorded, but not scored.
- **Active-learning export.** Review labels are stored in `proctoring_reviews`, but there is no export job to the YOLO training set yet.

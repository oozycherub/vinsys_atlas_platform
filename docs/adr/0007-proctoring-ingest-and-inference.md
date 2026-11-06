# ADR-0007: Proctoring: session start through assessment-svc, signed event chain, inference callbacks

- Status: Accepted
- Date: 2026-11-05

## Context

PRD Module 3 has the browser SDK send signed, hash-chained events to proctoring-svc, upload frames to S3, and GPU workers analyse them. It also has a rules engine (state in Redis, in the PRD) that raises violations, and a finaliser that computes the Trust Score. Several details need deciding:

- **Who authenticates the candidate.** Only assessment-svc can verify the candidate's session token.
- **De-duplication.** The PRD's unique index `(session_id, seq, occurred_at)` cannot de-duplicate retries, because `occurred_at` is clock-corrected and can differ between attempts.
- **Signature canonicalisation.** The SDK (JavaScript) and the server (Go) must produce byte-identical canonical JSON, or every signature fails.
- **Partition upkeep.** pg_partman is not available everywhere (tests, PGlite).

## Decision

1. **Starting proctoring goes through assessment-svc.**
   - `POST /v1/sessions/{sid}:startProctoring` is an assessment-svc route. It checks the session token, the live session and biometric consent, then calls proctoring-svc with a service token (`proctoring:sessions`).
   - proctoring-svc returns a **proctor token** (`apt_…`, stored as sha256, bound to the session) for the high-volume ingest routes, plus the HMAC **session key**.
   - Keys rotate every 15 minutes: each epoch's key stays in the session's key ring, AES-256-GCM encrypted, so late offline events still verify.
   - Starting again (a page reload) issues a new token and key and returns `next_seq` and `prev_hash`, so the chain continues.
2. **Canonical JSON is RFC 8785-style.**
   - Keys are sorted by UTF-16 code units and there is no whitespace.
   - Strings are escaped exactly as `JSON.stringify` does.
   - Numbers are re-emitted as they arrived: the server decodes with `UseNumber`, and the SDK serialises with `JSON.stringify`, so the text already matches.
   - Shared test vectors (`packages/contracts/fixtures/proctor-envelope-vectors.json`) are checked by both the Go and the TypeScript tests.
3. **De-duplication** uses a separate `proctoring_event_seqs (session_id, seq)` primary key, written in the same transaction as the log row.
4. **Inference results come back over HTTP.**
   - cv-inference consumes `proctoring.frame.uploaded.v1` (outbox → Kafka) and posts each result to `POST /v1/proctoring/frames/{id}:inference` (scope `proctoring:inference`).
   - The rules engine updates its state, which lives in `proctoring_sessions.state` under a row lock, in the same transaction as the log rows and the violation events. There is no Redis state and no second stream.
   - cv-inference returns the frame's face embedding. proctoring-svc compares it with the encrypted reference embeddings itself, so references never leave the service.
5. **Partitions are managed by the service.** proctoring-svc's maintenance loop calls owner functions:
   - `proctoring_ensure_partitions` creates partitions 3 months ahead;
   - `proctoring_drop_partitions` drops whole monthly partitions past the maximum retention;
   - `proctoring_erase_sessions` handles erasure, because the app role cannot delete log rows.
6. **Retention.** Per-tenant frame retention (`proctoring_frames_days`) comes from tenant-svc's settings endpoint. tenant-svc now includes the retention policy there and emits `settings_updated` when it changes.

## Consequences

- assessment-svc stays the only service that sees candidate session tokens, and proctoring-svc never trusts a body for the tenant.
- A cross-language canonicalisation bug would show up as tamper flags for every candidate. The shared vectors guard against that, and they must be extended whenever the SDK's envelope changes.
- Inference callbacks are synchronous writes to proctoring-svc. A slow proctoring-svc slows inference consumers, never candidates: inference is asynchronous and lag above 5 minutes suspends image-based termination.

# Component Prompt 06: parsing-svc (Résumé Parsing & Embedding Pipeline)

## 1. Context

- PRD Module 1 (§2.1, all of a–d) and §3 (`resume_embeddings` with HNSW).
- Brick 6 (Python). Depends on profile-svc (documents), taxonomy-svc (normalisation) and llm-gateway.

## Status

**Built.** Everything in §2–§8. All acceptance tests pass against real Postgres, Presidio and Temporal's test server; golden-set field F1 is 1.000 with an oracle model. The live-model evaluation (`scripts/eval_golden.py`) has not been run.

Contract additions: `profile.resume.parse_failed.v1` and `security.file.quarantined.v1` in `@atlas/contracts`, with profile-svc handlers. The shared Python code moved into `packages/py-platform`. Decisions and remaining gaps are in `services/parsing-svc/README.md`.

## 2. Scope

**In:** Temporal `ParseResumeWorkflow` with the 11 stages of PRD §2.1(b):

1. Security gate: libmagic, ClamAV, qpdf, zip-bomb limits.
2. Extraction: PyMuPDF, pdfplumber, python-docx, PaddleOCR.
3. Section segmentation.
4. Presidio redaction.
5. LLM extraction (`ParsedResumeV3` schema through llm-gateway).
6. **Evidence-span verification** (fuzzy ratio ≥ 0.85).
7. Skill normalisation (taxonomy `:normalize`).
8. Résumé proficiency inference (formula in PRD).
9. Chunk embeddings.
10. Persist through the profile-svc API, plus an outbox event.

Also: bulk import (zip ≤ 500 files), the progress SSE feed, and the DLQ.

**Out:** matching.

## 3. Owned data

- Migration `0009_parsing.sql`: `parse_jobs` (status, stage, attempts, error_code) and `resume_embeddings` (PRD §3, owned here; profile-svc deletes by cascade through `candidate_id`).
- S3: reads `t/{tid}/resumes/`; writes the `quarantine/` prefix.

## 4. API contract

- `POST /v1/resumes/{document_id}:parse` (Idempotency-Key) returns 202 `{job_id}`.
- `GET /v1/parse-jobs/{id}`; `GET /v1/parse-jobs/{id}/events` (SSE).
- `POST /v1/resumes:bulkImport`.

## 5. Events

- **Consumed:** `profile.resume.uploaded.v1`.
- **Produced:** `profile.resume.parsed.v1`, `profile.resume.parse_failed.v1` (DLQ), `security.file.quarantined.v1`.

**Contracts already fixed by profile-svc:** emit `profile.resume.parsed.v1` exactly as defined in `packages/contracts/src/profile-events.ts` (`profile` must be redacted: no name, email, phone, address or dob keys, or profile-svc fails the document). Consume `privacy.erasure.requested.v1` and reply with `privacy.erasure.acknowledged.v1` (`service: "parsing-svc"`).

## 6. Domain rules

- **Hidden text** (white text, font ≤ 2 pt, off-page bounding box) is excluded and flagged.
- **Keyword stuffing** caps confidence at 0.2.
- **Résumé-inferred proficiency** is capped at 3.5.
- **Embedding model upgrades** go through a shadow index, then a swap. Never mix `model_id` values in one query.
- **Error codes:** `UNREADABLE_DOCUMENT`, `ENCRYPTED_DOCUMENT`, `MALICIOUS_FILE`, `LLM_UNAVAILABLE`.

## 7. Non-functional

p95 under 8 s for a 4-page text PDF; under 20 s with OCR. 2,000 résumés per 10 min per tenant, with fair-share scheduling.

## 8. Acceptance tests

- **Golden set:** 50 anonymised résumés with expected JSON; field F1 ≥ 0.95.
- Injection résumé ("rate me 5/5") produces no score field, and the `hidden_text` flag is set.
- EICAR test file is quarantined.
- Password-protected PDF gives `ENCRYPTED_DOCUMENT`.
- Workflow retry is idempotent (no duplicate embeddings).
- Cross-tenant ANN query returns only the caller's tenant.

## 9. Deliverables

`services/parsing-svc/` (worker plus API), Temporal worker setup in `infra/`, golden dataset under `services/parsing-svc/test/golden/`, contracts.

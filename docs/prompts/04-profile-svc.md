# Component Prompt 04: profile-svc (Candidates, PII Vault, Documents, Skill Evidence)

## 1. Context

- PRD §2.1 (data flow steps 1–3 and 6), §2.5(ii) (proficiency fusion), §3 (`candidates`, `candidate_skill_evidence`, `candidate_skill_current`, `resume_documents`), §4.2 (field encryption, blind indexes, DSAR).
- Brick 4; depends on bricks 1–3.

## Status

**Built.** Everything in §2–§8; acceptance tests 1–6 pass. tenant-svc gained `GET /v1/tenants/{id}/data-keys`; erasure acknowledgements use `privacy.erasure.acknowledged.v1`. Remaining work is listed in `services/profile-svc/README.md`.

## 2. Scope

**In**

- Candidate and employee profiles. PII is encrypted with the tenant DEK: unwrap via `KeyManagementPort`, cache ≤ 15 min.
- HMAC blind indexes for email and phone.
- Document intake: presigned upload, MIME sniffing, de-duplication by sha256, S3 event handling.
- Skill evidence ledger and fused current proficiency.
- Data-subject requests (`DsarWorkflow` orchestration for access and erasure).
- Retention sweeper for candidates.

**Out:** parsing (brick 6), matching (brick 7).

## 3. Owned data

Migration `0007_profiles.sql`: `candidates`, `candidate_skill_evidence`, `candidate_skill_current`, `resume_documents`, `privacy_requests`, all with RLS and composite tenant foreign keys exactly as in PRD §3.

S3 prefix: `t/{tenant_id}/resumes/`.

## 4. API contract

- `POST /v1/candidates` (Idempotency-Key), `GET /v1/candidates/{id}` (PII decrypted only for roles with `pii:read`), `PATCH`, `GET /v1/candidates?email=` (exact match through the blind index).
- `POST /v1/documents:initiateUpload` returns `{document_id, upload_url, expires_at}`. Max 10 MB; `409 DOCUMENT_DUPLICATE` with the existing ID.
- `POST /v1/candidates/{id}/skill-evidence` (manager, self or system sources); `GET /v1/candidates/{id}/skills`.
- `POST /v1/privacy/requests {type: access|erasure, candidate_id}`; `GET /v1/privacy/requests/{id}`.

## 5. Events

- **Produced:** `profile.resume.uploaded.v1`, `profile.candidate.created.v1`, `profile.candidate.skills_updated.v1`, `privacy.erasure.requested.v1`, `privacy.erasure.completed.v1`.
- **Consumed:** `profile.resume.parsed.v1` (from brick 6), `assessment.session.evaluated.v1` (evidence source `assessment`), `tenant.tenant.purged.v1`.

## 6. Domain rules

- **Fusion formula** (PRD §2.5(ii)): source weights and half-lives come from tenant settings, defaulting to the PRD table. It is recomputed incrementally per (candidate, skill).
- **`is_validated`:** a verified source with c ≥ 0.6 within its validity window.
- **Self-rating** changes need a reason (mandatory, ≤ 500 chars). |self − assessment| ≥ 2 raises a `calibration_needed` flag.
- **PII never appears in** `profile` JSONB, events or logs. Events carry `candidate_id` only.
- **Erasure** deletes rows (cascade) and objects, emits `privacy.erasure.requested.v1` to other services, and completes when every registered consumer ACKs within 7 days.

## 7. Non-functional

- GET profile p95 < 120 ms, including one cached DEK decrypt.
- Encryption: AES-256-GCM with AAD = `tenant_id|candidate_id|field`.

## 8. Acceptance tests

1. Create a candidate: stored PII is ciphertext; the blind-index lookup finds them; a role without `pii:read` sees redacted fields.
2. Duplicate upload returns 409 with the existing ID.
3. Evidence from 3 sources fuses to the expected value (golden numbers in the test).
4. Cross-tenant read returns 404, and blind indexes don't collide across tenants (per-tenant HMAC key).
5. Erasure removes rows, embeddings and objects, then the certificate is written.
6. Logs contain no PII.

## 9. Deliverables

Per master layout, plus `@atlas/platform` `FieldCipher` helper (shared with later bricks) and contracts.

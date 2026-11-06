# profile-svc (brick 4)

Candidate and employee profiles with encrypted PII, résumé intake, the skill evidence ledger with fused proficiency, and data-subject requests (access and erasure).

Spec: [`docs/prompts/04-profile-svc.md`](../../docs/prompts/04-profile-svc.md) · Contract: [`openapi.yaml`](openapi.yaml)

## Design

```
http/            CandidatesController, DocumentsController, PrivacyController + zod DTOs
  └─▶ application/  CandidateService, EvidenceService, DocumentService, PrivacyService, ProfileEventHandlers
        └─▶ domain/   PII rules, fusion formula, evidence sources, MIME sniffing, erasure workflow
infrastructure/  Pg repositories, S3 / in-memory storage, taxonomy skill catalogue
@atlas/platform  FieldCipher + TenantKeyCache (shared with later bricks)
```

### PII

- **Encryption.** `pii_enc` holds `{full_name, email, phone, address, dob}` encrypted with the tenant's data key (AES-256-GCM, AAD `tenant_id|candidate_id|pii`). The key version is stored in the ciphertext header, so values written before a key rotation still decrypt.
- **Where keys come from.** Data keys come from tenant-svc (`GET /v1/tenants/{id}/data-keys`, scope `tenant-keys:read`) still wrapped. profile-svc unwraps them with its own KMS access (encryption context `purpose=tenant-dek`) and keeps them in memory for at most 15 minutes.
- **Blind indexes.** Email and phone lookups use HMAC-SHA256 indexes with a per-tenant key derived (HKDF) from the tenant's oldest live key version. They survive key rotation, never collide across tenants, and are destroyed by a tenant purge.
- **Who sees it.** PII is decrypted only for `pii:read`: tenant_admin, recruiter, hiring_manager, service principals with scope `pii:read`, and the person themself. Reviewers and SMEs see redacted profiles. Employees and candidates see only their own profile, and anyone else's answers 404.
- **Where it never goes.** PII never appears in `profile` / `consent` JSON (checked at the boundary, including parser output), in events (only `candidate_id`), in idempotency records (create responses are redacted) or in logs. The platform access log now drops query strings everywhere, because `?email=` would otherwise be logged.

### Documents

1. `POST /v1/documents:initiateUpload` returns a 15-minute presigned PUT. Its signed headers bind the content type, the length and the SHA-256 checksum, so S3 rejects bytes that differ from what was declared. A second upload of the same file gives `409 DOCUMENT_DUPLICATE` with the existing id; an expired, unfinished upload does not block the file.
2. The S3 / MinIO ObjectCreated notification (`POST /v1/internal/storage-events`, scope `storage-events:write`) checks the stored size and the real content type from the magic bytes. A match marks the document `uploaded` and emits `profile.resume.uploaded.v1`; a mismatch quarantines it. Repeated notifications are no-ops.
3. `profile.resume.parsed.v1` (from parsing-svc) stores the redacted snapshot, enriches the profile and records `resume_inference` evidence. A "redacted" profile that still contains PII fails the document (`pii_in_profile`) and is discarded, rather than retried forever.

### Skill evidence and fusion

`p(s) = Σ W·c·d·p / Σ W·c·d`, with `d = 0.5^(age_months / H_source)` and the PRD's source weights and half-lives. Expired evidence weighs 0.

- **Validated:** an assessment, certification, AI interview or manager record with confidence ≥ 0.6 that has not expired.
- **Calibration needed:** the latest self-rating and the latest assessment are 2 or more apart.

Fusion is recomputed incrementally per (candidate, skill) in the same transaction as the new evidence, and emits `profile.candidate.skills_updated.v1`.

Who may record which source:

| Caller                       | Sources                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| The person (their user id)   | `self` (reason required, ≤ 500 chars)                      |
| tenant_admin, hiring_manager | `manager`, `multi_rater`                                   |
| Service principals           | system sources: assessment, certification, ai_interview, … |

Skill ids are checked against taxonomy-svc: unknown or hidden skills are refused, and deprecated ones are recorded against their successor. Redelivered assessment or résumé evidence (same session or document) counts once.

### Data-subject requests

- **Access** compiles everything held about the person, stores the export encrypted, and returns it to tenant admins.
- **Erasure:**
  1. Refused under legal hold.
  2. Deletes the objects first, then the rows (cascade: evidence, current skills, documents).
  3. Emits `privacy.erasure.requested.v1` and writes a certificate with row counts and the object count.
  4. Completes when every service in `ATLAS_PROFILE_ERASURE_CONSUMERS` has sent `privacy.erasure.acknowledged.v1`; repeated and unknown acknowledgements are ignored. It then emits `privacy.erasure.completed.v1`.
- **Overdue:** `POST /v1/privacy:sweepOverdue` flags erasures not fully acknowledged within 7 days.
- **Retention:** `POST /v1/privacy:sweepRetention` erases non-employee candidates inactive beyond the retention period, except those under legal hold. A scheduler calls both per tenant.

## Owned data (`0007_profiles.sql`)

`candidates`, `candidate_skill_evidence` (append-only for the app), `candidate_skill_current`, `resume_documents`, `privacy_requests`. Every table has strict tenant RLS, and every query also filters `tenant_id = current_tenant_id()` explicitly. There are no foreign keys to other services' tables (tenants, users, skills).

## Events

- **Produced:** `profile.candidate.created.v1`, `profile.resume.uploaded.v1`, `profile.candidate.skills_updated.v1`, `privacy.erasure.requested.v1`, `privacy.erasure.completed.v1`.
- **Consumed** (`profile-svc.events`): `profile.resume.parsed.v1`, `profile.resume.parse_failed.v1` (sets `failed` or `failed_retryable`, but never un-parses a parsed document) and `security.file.quarantined.v1` (sets `quarantined`), all from parsing-svc (brick 6); `assessment.session.evaluated.v1` (brick 8; its `valid_until` becomes the evidence expiry), `privacy.erasure.acknowledged.v1`, `tenant.tenant.purged.v1` (rows, every object under `t/{tenant}/`, cached keys).

The contracts for events produced by later bricks are already fixed in `packages/contracts/src/profile-events.ts`.

## Configuration

| Variable                                                                                         | Notes                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `ATLAS_DATABASE_URL`, `ATLAS_AUTH_*`                                                             | as other services                                              |
| `ATLAS_IDENTITY_TOKEN_URL`, `ATLAS_PROFILE_CLIENT_ID`, `ATLAS_PROFILE_CLIENT_SECRET`             | client credentials (scope `tenant-keys:read`)                  |
| `ATLAS_TENANT_SVC_URL`, `ATLAS_TAXONOMY_SVC_URL`                                                 | key ring and skill checks                                      |
| `ATLAS_PROFILE_KEK_MODE` (`local`/`aws`), `ATLAS_PROFILE_LOCAL_KEK` / `ATLAS_PROFILE_KMS_KEY_ID` | must be the KEK tenant-svc wraps with; `local` refused in prod |
| `ATLAS_PROFILE_STORAGE` (`memory`/`s3`), `ATLAS_PROFILE_S3_BUCKET`, `ATLAS_PROFILE_S3_ENDPOINT`  | `memory` refused in prod; endpoint for MinIO                   |
| `ATLAS_PROFILE_ERASURE_CONSUMERS`                                                                | comma-separated services that must acknowledge erasures        |
| `ATLAS_PROFILE_RETENTION_DAYS`                                                                   | default 730                                                    |
| `ATLAS_PROFILE_EVENT_SOURCE`, `ATLAS_KAFKA_BROKERS`                                              | `kafka` required in prod                                       |
| `ATLAS_PROFILE_PORT`                                                                             | default 8084                                                   |

## Known gaps

- **Tenant-level settings are not read from tenant-svc yet:** the fusion weights and half-lives (PRD defaults are used) and the retention period (a service-wide default is used). Both need a service-readable tenant settings API.
- **Résumé embeddings** belong to parsing-svc (brick 6). Erasure fans out to it, and its table will cascade from `candidates`.
- **Nightly decay refresh** of `candidate_skill_current` is not scheduled. Values are exact whenever evidence changes.
- **Storage bridge:** the S3 / MinIO notification delivery has to be configured to call `/v1/internal/storage-events`. Expired `pending_upload` rows are reused rather than swept.
- **Not run against real systems** (Postgres, S3/MinIO, KMS, tenant-svc and taxonomy-svc over the network); not measured: GET p95 < 120 ms.

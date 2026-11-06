# Component Prompt 01: tenant-svc (Tenant Directory & Lifecycle)

> Read `docs/MASTER_ORCHESTRATION_PROMPT.md` first. This prompt must not contradict it.

## 1. Context

- PRD §1.2.1 (isolation models), §1.2.2 (enforcement), §1.2.4 (lifecycle and crypto-shredding), §4.2 (encryption keys).
- Brick **1** of 14. It depends only on brick 0 (platform, contracts, foundation migration). Every later service asks tenant-svc, directly or through the gateway's cache, "which cell serves this tenant, and is it active?"

## 2. Scope

**In scope**

- Tenant directory: create tenants, place them in a cell, and resolve them by slug for the API gateway.
- Lifecycle state machine: `provisioning → active ⇄ suspended → offboarding → purged`.
- Per-tenant settings (limits, matching weights, feature flags, compliance jurisdictions) and retention policy, with optimistic concurrency.
- Per-tenant data encryption key (DEK): generate on create, rotate on demand, destroy on purge (crypto-shredding). Only the wrapped key is stored.
- Lifecycle events via the outbox, plus an audit trail of status changes.

**Out of scope (later bricks)**

- Billing.
- Users and roles (identity-svc).
- Physically provisioning cells (Terraform). tenant-svc only _chooses_ a cell from configuration.

## 3. Owned data

Migrations `0002_tenant_directory.sql` and `0003_tenant_key_ring.sql`:

- `tenants`: the directory row, settings, retention policy, active `dek_version`, `version` for optimistic locking.
- `tenant_data_keys`: the key ring. One row per DEK version (wrapped only), with `retired_at` and `destroyed_at`. At most one active key per tenant. Rows are never deleted.
- `tenant_status_history`: append-only audit of transitions (who, when, why).

Neither table has RLS. The directory is platform-level data and is only reachable through tenant-svc's authorisation rules.

## 4. API contract (`services/tenant-svc/openapi.yaml`)

| Method & path                            | Roles                                       | Notes                                                                                                         |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /v1/tenants`                       | super_admin                                 | Requires `Idempotency-Key`. Body: `slug, display_name, data_region, isolation_tier?`. Returns 201 and `ETag`. |
| `GET /v1/tenants`                        | super_admin                                 | Filters `status`, `data_region`; cursor pagination (`limit` ≤ 100, `cursor`).                                 |
| `GET /v1/tenants/{id}`                   | super_admin, tenant_admin (own tenant only) | Returns `ETag: "<version>"`. A cross-tenant read returns 404, never 403, so tenant IDs can't be probed.       |
| `PATCH /v1/tenants/{id}`                 | super_admin, tenant_admin (own)             | `display_name`. `If-Match` required (428 if missing, 412 on mismatch).                                        |
| `PUT /v1/tenants/{id}/settings`          | super_admin, tenant_admin (own)             | Full settings document; `If-Match` required.                                                                  |
| `PUT /v1/tenants/{id}/retention-policy`  | super_admin                                 | `If-Match` required.                                                                                          |
| `POST /v1/tenants/{id}:activate`         | super_admin                                 | provisioning → active                                                                                         |
| `POST /v1/tenants/{id}:suspend`          | super_admin                                 | `{reason}` required; active → suspended                                                                       |
| `POST /v1/tenants/{id}:reactivate`       | super_admin                                 | suspended → active                                                                                            |
| `POST /v1/tenants/{id}:offboard`         | super_admin                                 | `{reason}`; active/suspended → offboarding; sets `purge_not_before = now + grace`                             |
| `POST /v1/tenants/{id}:purge`            | super_admin                                 | offboarding → purged, only after `purge_not_before`; destroys the DEK                                         |
| `POST /v1/tenants/{id}:rotateDataKey`    | super_admin                                 | Active tenants only; increments `dek_version`                                                                 |
| `GET /v1/tenant-directory:resolve?slug=` | service with scope `tenant-directory:read`  | For the gateway: `{tenant_id, cell_id, data_region, isolation_tier, status}`                                  |
| `GET /healthz`, `GET /readyz`            | public                                      | Liveness, and database readiness                                                                              |

Error codes: `PLATFORM_MANAGED_SETTING` (403), `TENANT_SLUG_TAKEN` (409), `TENANT_SLUG_RESERVED` (422), `TENANT_NOT_FOUND` (404), `INVALID_TENANT_TRANSITION` (422), `PURGE_GRACE_PERIOD_ACTIVE` (422), `TENANT_NOT_ACTIVE` (422), `UNSUPPORTED_DATA_REGION` (422), `VERSION_MISMATCH` (412), `IF_MATCH_REQUIRED` (428), `INVALID_SETTINGS` (400/422), `IDEMPOTENCY_KEY_REUSED` (422).

## 5. Events (registered in `@atlas/contracts/tenant-events.ts`)

- **Produced:** `tenant.tenant.provisioned.v1`, `.activated.v1`, `.suspended.v1`, `.reactivated.v1`, `.offboarding_started.v1`, `.purged.v1`, `.settings_updated.v1`, `.data_key_rotated.v1`. All are keyed by `tenant_id` and written with `tenant_id` set (the outbox RLS requires the tenant context).
- **Consumed:** none.

## 6. Domain rules

- **Slug:** `^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$` (3–63 characters, no leading or trailing hyphen, no `--`). It may not be a reserved word: `www, api, app, admin, auth, login, static, assets, status, docs, help, support, mail, internal, system, platform, atlas`. Slugs are immutable.
- **Data region** must be in configured `ATLAS_TENANT_CELLS`.
- **Cell placement:**
  - Dedicated tenants get `<region>-dedicated-<slug>`.
  - Pooled tenants get one of the region's pooled cells, chosen deterministically by `fnv1a(tenant_id) mod n`, so a retry lands in the same cell.
- **Transitions** (all others raise `INVALID_TENANT_TRANSITION`):
  `provisioning→active`, `active→suspended`, `suspended→active`, `active→offboarding`, `suspended→offboarding`, `offboarding→purged`.
- **Purge** requires `now ≥ purge_not_before` (grace period default 30 days, `ATLAS_TENANT_PURGE_GRACE_DAYS`, minimum 1). On purge:
  - Every DEK version in the key ring is destroyed (ciphertext set to NULL, `destroyed_at` set).
  - Settings are reset to platform defaults.
  - `display_name` is replaced by `"[purged]"`.
- **Key rotation** adds a new DEK version and retires the previous one. Retired versions are kept so data encrypted with them stays readable; only purge destroys them.
- **Platform-managed settings:** only super_admin may change `limits` and `features`. A tenant admin may resend them unchanged in the full-document PUT; changing them gives 403 `PLATFORM_MANAGED_SETTING`.
- **Custom methods** (`:activate` … `:rotateDataKey`) accept an optional `If-Match`; when sent and stale, 412.
- **Settings:**
  - `limits.api_rps` 1–10,000; `limits.parse_concurrency` 1–500; `limits.sandbox_concurrency` 1–2,000.
  - `matching.weights` keys `sem, cov, exp, lex` each in [0, 1] and summing to 1 ± 1e-6.
  - `features` is a map of `module.feature.variant` to boolean.
  - `compliance.jurisdictions` uses ISO-3166 alpha-2 or region codes (`US-NY`, `EU`).
  - Every successful update increments `version`.
- **Retention policy:** day values in ranges (`candidate_inactive_days` 30–3,650, `proctoring_frames_days` 1–365, `interview_audio_days` 1–1,095, `assessment_reports_days` 30–3,650).
- **DEK:** generated through the `KeyManagementPort` (local AES-256-GCM key-wrapping in development; AWS KMS adapter in production). The plaintext key is never persisted, logged or returned.

## 7. Non-functional

- `resolve` p95 < 20 ms (single indexed lookup); the gateway caches results for 60 s.
- Every mutation records the actor's `sub` in `tenant_status_history` and in event payloads.
- `tenant_admin` may never change lifecycle, retention or keys.

## 8. Acceptance tests (Given / When / Then)

1. Given a super_admin, when POST /v1/tenants with a valid body and an Idempotency-Key, then 201: status `provisioning`, a pooled cell for the region, an ETag, a `tenant.tenant.provisioned.v1` outbox row, and no plaintext key anywhere.
2. Given the same Idempotency-Key and body, when retried, then the same response is returned with `Idempotent-Replayed: true`, and only one tenant exists.
3. Given an existing slug, when creating again with a new key, then 409 `TENANT_SLUG_TAKEN`.
4. Given slug `admin`, then 422 `TENANT_SLUG_RESERVED`. Given `Bad_Slug`, then 400 `VALIDATION_FAILED`.
5. Given no token, then 401. Given a tenant_admin calling POST /v1/tenants, then 403.
6. Given tenant A's admin, when GET tenant B, then 404 (**cross-tenant leak test**). GET own tenant gives 200.
7. Lifecycle: activate, suspend (reason required), reactivate, offboard, then purge before grace (422), advance the clock, purge (200). Each step writes history and an event. An invalid transition (activate a suspended tenant) gives 422.
8. Settings PUT without If-Match gives 428; with a stale version, 412; with weights summing to 0.9, 400; valid gives 200, an incremented version and a `settings_updated` event. A tenant admin changing `limits` or `features` gives 403.
9. Resolve by slug as a service principal with scope gives 200; without the scope, 403; unknown slug, 404.
10. `/healthz` and `/readyz` are 200 without auth.
11. After rotation both key versions exist and unwrap; after purge, every version is destroyed.

## 9. Deliverables checklist

- `db/migrations/0002_tenant_directory.sql`, `db/migrations/0003_tenant_key_ring.sql`
- `services/tenant-svc/{openapi.yaml, README.md, package.json, tsconfig.json}`
- `src/domain/{tenant.ts, slug.ts, settings.ts, cell-placement.ts, errors.ts}`
- `src/application/{ports.ts, tenant.service.ts}`
- `src/infrastructure/{pg-tenant.repository.ts, local-key-management.ts}`
- `src/http/{tenants.controller.ts, directory.controller.ts, health.controller.ts, dto.ts}`
- `src/{config.ts, app.module.ts, main.ts}`
- `test/unit/*.test.ts` (domain), `test/integration/tenants.api.test.ts` (acceptance tests 1–10)

# tenant-svc (brick 1)

Tenant directory and lifecycle for Atlas. It owns which customer organisations exist, which **cell** serves each one, their lifecycle state, their settings and retention policy, and their **data encryption key** (stored wrapped only).

Spec: [`docs/prompts/01-tenant-svc.md`](../../docs/prompts/01-tenant-svc.md) · Contract: [`openapi.yaml`](openapi.yaml)

## Design

```
http/            NestJS controllers + zod DTOs   (TenantsController, DirectoryController, HealthController)
  └─▶ application/  TenantService use cases — one transaction each; ports for repository & KMS
        └─▶ domain/   pure rules: slug, cell placement, settings invariants, lifecycle state machine
infrastructure/  PgTenantRepository (SQL-first), LocalKeyManagement (AES-256-GCM key wrapping)
```

Lifecycle: `provisioning → active ⇄ suspended → offboarding → purged`. Purge is allowed only after the grace period. It destroys every version of the tenant's data key (crypto-shredding).

Data keys live in a **key ring**: rotation adds a version and retires the old one, which is kept so existing ciphertext stays readable.

Only platform staff may change the `limits` and `features` settings; tenant admins may change the rest.

**Data keys for other services.** `GET /v1/tenants/{id}/data-keys` (role `service`, scope `tenant-keys:read`) returns the live wrapped key versions; callers unwrap them with their own KMS access. Local and AWS modes use the same wrapping format (`KeyEncryption`, context `tenant-dek`).

## Owned data

| Table                   | Migration                   | Notes                                                                                             |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `tenants`               | `0002_tenant_directory.sql` | Platform-level (no RLS). Optimistic concurrency via `version` (ETag). The app role cannot DELETE. |
| `tenant_status_history` | `0002_tenant_directory.sql` | Append-only audit (the app role cannot UPDATE or DELETE)                                          |
| `tenant_data_keys`      | `0003_tenant_key_ring.sql`  | Wrapped DEK per version; at most one active. Destroyed by nulling, never deleted.                 |

## Events produced (outbox)

`tenant.tenant.{provisioned, activated, suspended, reactivated, offboarding_started, purged, settings_updated, data_key_rotated}.v1`. A retention-policy change also emits `settings_updated`, with `changed_keys` such as `retention_policy.proctoring_frames_days`; services that erase on a schedule (proctoring frames) read the policy from `GET /v1/tenants/{id}/settings`, which includes `retention_policy`. Schemas are in `packages/contracts/src/tenant-events.ts`.

## Configuration

| Variable                                   | Required   | Default | Notes                                                                |
| ------------------------------------------ | ---------- | ------- | -------------------------------------------------------------------- |
| `ATLAS_DATABASE_URL`                       | yes        |         | Connect as `atlas_app` (via PgBouncer in transaction mode)           |
| `ATLAS_AUTH_ISSUER`, `ATLAS_AUTH_AUDIENCE` | yes        |         | JWT validation                                                       |
| `ATLAS_AUTH_JWKS_URL`                      | prod       |         | Asymmetric verification (RS256/ES256)                                |
| `ATLAS_AUTH_SHARED_SECRET`                 | dev only   |         | HS256; rejected when `NODE_ENV=production`                           |
| `ATLAS_TENANT_CELLS`                       | yes        |         | JSON, e.g. `{"eu-central-1":{"pooled":["eu-pool-01","eu-pool-02"]}}` |
| `ATLAS_TENANT_KMS_MODE`                    | no         | `local` | `aws` in production (`local` is rejected)                            |
| `ATLAS_TENANT_KMS_KEY_ID`                  | aws mode   |         | KMS key ARN or `alias/<name>`; region from `AWS_REGION`              |
| `ATLAS_TENANT_KMS_KEY_NAME`                | no         | `dev`   | Key ref becomes `local:<name>`                                       |
| `ATLAS_TENANT_LOCAL_KEK`                   | local mode |         | base64 32-byte key: `openssl rand -base64 32`                        |
| `ATLAS_TENANT_PURGE_GRACE_DAYS`            | no         | `30`    | 1–365                                                                |
| `ATLAS_TENANT_PORT`                        | no         | `8081`  |                                                                      |
| `ATLAS_LOG_LEVEL`                          | no         | `info`  |                                                                      |

## Run and test

```bash
npm test                               # from repo root: unit + integration (PGlite, no Docker needed)
make infra-up && make migrate          # local Postgres/Redis/Redpanda/MinIO via Docker
npm run build && node services/tenant-svc/dist/main.js
```

## Known gaps (tracked for later bricks)

- **Outbox relay** is configured (`infra/debezium/`) but not yet run against Kafka Connect.
- **AWS KMS** mode is unit-tested with a mocked KMS client only.
- **Concurrency tests** (`FOR UPDATE`, unique-index races) run against real Postgres in the nightly job (ADR-0005). PGlite is single-connection.

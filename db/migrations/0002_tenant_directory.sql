-- 0002_tenant_directory: owned by tenant-svc (docs/prompts/01-tenant-svc.md §3).
-- Platform-level directory: no RLS; access is mediated by tenant-svc's authorisation rules.

CREATE TYPE tenant_status AS ENUM ('provisioning', 'active', 'suspended', 'offboarding', 'purged');
CREATE TYPE tenant_isolation_tier AS ENUM ('pooled', 'dedicated');

CREATE TABLE tenants (
  tenant_id         uuid PRIMARY KEY,
  slug              text NOT NULL UNIQUE
                      CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$' AND slug !~ '--'),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  isolation_tier    tenant_isolation_tier NOT NULL DEFAULT 'pooled',
  status            tenant_status NOT NULL DEFAULT 'provisioning',
  cell_id           text NOT NULL,
  data_region       text NOT NULL,
  kms_key_ref       text NOT NULL,                     -- KEK identifier (KMS ARN or local:<name>)
  dek_ciphertext    bytea,                             -- wrapped data key; NULL after purge (crypto-shred)
  dek_version       int NOT NULL DEFAULT 1 CHECK (dek_version >= 1),
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_policy  jsonb NOT NULL,
  purge_not_before  timestamptz,
  version           int NOT NULL DEFAULT 1 CHECK (version >= 1),   -- optimistic concurrency (ETag)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  purged_at         timestamptz,
  CHECK ((status = 'purged') = (purged_at IS NOT NULL)),
  CHECK (status = 'purged' OR dek_ciphertext IS NOT NULL),
  CHECK ((status = 'offboarding') <= (purge_not_before IS NOT NULL))
);

CREATE INDEX ix_tenants_status_created ON tenants (status, created_at DESC, tenant_id DESC);
CREATE INDEX ix_tenants_region ON tenants (data_region, status);

CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_status_history (
  history_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (tenant_id),
  from_status  tenant_status,                           -- NULL for the initial provisioning row
  to_status    tenant_status NOT NULL,
  reason       text CHECK (length(reason) <= 1000),
  actor        text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tenant_history_tenant ON tenant_status_history (tenant_id, occurred_at);

-- 0001 grants full DML on new tables by default; narrow it here.
-- Tenants are never hard-deleted by the app (purge is a state); history is append-only.
REVOKE DELETE ON tenants FROM atlas_app;
REVOKE UPDATE, DELETE ON tenant_status_history FROM atlas_app;

-- 0003_tenant_key_ring: owned by tenant-svc (docs/prompts/01-tenant-svc.md §3).
-- A tenant keeps EVERY data-key version until purge. Rotation adds a version and retires the
-- previous one; retired keys still decrypt existing ciphertext. Purge destroys all versions
-- (crypto-shredding). Before this migration, rotation overwrote the only key, which would have
-- made existing ciphertext unreadable.

CREATE TABLE tenant_data_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants (tenant_id),
  dek_version     int NOT NULL CHECK (dek_version >= 1),
  kms_key_ref     text NOT NULL,                 -- KEK that wrapped this version
  dek_ciphertext  bytea,                         -- wrapped key; NULL once destroyed
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,                   -- no longer used for new writes; still decrypts
  destroyed_at    timestamptz,                   -- set by purge
  PRIMARY KEY (tenant_id, dek_version),
  CHECK ((dek_ciphertext IS NULL) = (destroyed_at IS NOT NULL)),
  CHECK (retired_at IS NULL OR retired_at >= created_at)
);

-- At most one active (not retired, not destroyed) key per tenant.
CREATE UNIQUE INDEX ux_tenant_data_keys_active ON tenant_data_keys (tenant_id)
  WHERE retired_at IS NULL AND destroyed_at IS NULL;

INSERT INTO tenant_data_keys (tenant_id, dek_version, kms_key_ref, dek_ciphertext, created_at, destroyed_at)
SELECT tenant_id, dek_version, kms_key_ref, dek_ciphertext, created_at,
       CASE WHEN dek_ciphertext IS NULL THEN coalesce(purged_at, now()) END
FROM tenants;

-- The ring is now the only place key material lives. Dropping the column also drops the
-- table CHECK that referenced it.
ALTER TABLE tenants DROP COLUMN dek_ciphertext;

-- Keys are destroyed by nulling the ciphertext, never by deleting the row (audit trail).
REVOKE DELETE ON tenant_data_keys FROM atlas_app;

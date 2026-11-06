-- 0004_identity: owned by identity-svc (docs/prompts/02-identity-svc.md §3).
-- Tenant-owned tables use strict RLS (tenant_id = current_tenant_id(), no system bypass).
-- Platform-level tables (tenant_access, signing_keys, service_clients) have no RLS.
-- Emails are stored lower-cased with a CHECK instead of citext, so the schema runs on any
-- Postgres build (including PGlite in tests) without the extension.

-- Local projection of tenant status, fed by tenant.tenant.* events. Read before a tenant is
-- known to the caller (login by subdomain), so it is platform-level.
CREATE TABLE tenant_access (
  tenant_id   uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  status      text NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'offboarding', 'purged')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id            uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  email              text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  roles              text[] NOT NULL CHECK (
                       cardinality(roles) >= 1
                       AND roles <@ ARRAY['tenant_admin', 'recruiter', 'hiring_manager', 'reviewer', 'sme', 'employee', 'candidate']
                     ),
  business_unit_ids  uuid[] NOT NULL DEFAULT '{}',
  status             text NOT NULL CHECK (status IN ('invited', 'active', 'deactivated')),
  last_login_at      timestamptz,
  version            int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, email)
);
CREATE INDEX ix_users_tenant_created ON users (tenant_id, created_at DESC, user_id DESC);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Single-use invitation links (72 h). Only the SHA-256 of the token is stored.
CREATE TABLE user_invitations (
  invitation_id  uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  token_hash     bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  invited_by     text NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ix_invitations_user ON user_invitations (tenant_id, user_id);

-- Password-less login links (30 min), bound to the browser that requested them.
CREATE TABLE magic_links (
  link_id        uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  token_hash     bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  binding_hash   bytea NOT NULL CHECK (length(binding_hash) = 32),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE
);

-- Rotating refresh tokens. A family is one login; reuse of a rotated token revokes the family.
CREATE TABLE refresh_tokens (
  token_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  family_id     uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  rotated_from  uuid REFERENCES refresh_tokens (token_id) ON DELETE CASCADE,
  amr           text[] NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ix_refresh_family ON refresh_tokens (tenant_id, family_id);
CREATE INDEX ix_refresh_user ON refresh_tokens (tenant_id, user_id) WHERE revoked_at IS NULL;

-- Per-tenant SSO federation config. `enforced` blocks magic-link login (SSO_REQUIRED).
CREATE TABLE sso_connections (
  tenant_id     uuid PRIMARY KEY,
  protocol      text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  enforced      boolean NOT NULL DEFAULT false,
  metadata      jsonb NOT NULL,
  domain_hints  text[] NOT NULL DEFAULT '{}',
  version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_sso_updated BEFORE UPDATE ON sso_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'user_invitations', 'magic_links', 'refresh_tokens', 'sso_connections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
  END LOOP;
END $$;

-- Token-signing keys (ES256). The private JWK is sealed with the platform KEK (AES-256-GCM,
-- AAD = kid). A key signs from activates_at until retires_at and stays in JWKS until
-- publish_until, so tokens it signed keep verifying until they expire.
CREATE TABLE signing_keys (
  kid                     text PRIMARY KEY CHECK (kid ~ '^[A-Za-z0-9_-]{8,64}$'),
  alg                     text NOT NULL CHECK (alg = 'ES256'),
  public_jwk              jsonb NOT NULL,
  private_key_ciphertext  bytea NOT NULL,
  kek_ref                 text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  activates_at            timestamptz NOT NULL,
  retires_at              timestamptz,
  publish_until           timestamptz,
  CHECK (retires_at IS NULL OR retires_at >= activates_at),
  CHECK ((retires_at IS NULL) = (publish_until IS NULL)),
  CHECK (publish_until IS NULL OR publish_until >= retires_at)
);
-- At most one key without a retirement date (the newest).
CREATE UNIQUE INDEX ux_signing_keys_open ON signing_keys ((true)) WHERE retires_at IS NULL;

-- Machine principals (OAuth client credentials). Secrets are argon2id PHC strings.
CREATE TABLE service_clients (
  client_id    text PRIMARY KEY CHECK (client_id ~ '^svc_[a-z0-9-]{3,60}$'),
  tenant_id    uuid,                                -- NULL for platform services (e.g. the gateway)
  secret_hash  text NOT NULL CHECK (secret_hash LIKE '$argon2id$%'),
  scopes       text[] NOT NULL DEFAULT '{}',
  description  text NOT NULL DEFAULT '',
  disabled_at  timestamptz,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 0001 grants full DML by default; narrow it.
REVOKE DELETE ON signing_keys, service_clients, tenant_access FROM atlas_app;
REVOKE UPDATE ON user_invitations FROM atlas_app;
GRANT UPDATE (consumed_at) ON user_invitations TO atlas_app;
REVOKE UPDATE ON magic_links FROM atlas_app;
GRANT UPDATE (consumed_at) ON magic_links TO atlas_app;

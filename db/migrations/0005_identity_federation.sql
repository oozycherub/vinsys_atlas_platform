-- 0005_identity_federation: owned by identity-svc (docs/prompts/02-identity-svc.md, increment 2b).
-- SSO federation (OIDC and SAML), the authorization-code + PKCE flow for Atlas's own web app,
-- and platform-staff accounts.

-- SSO connection secrets: the OIDC client secret is sealed (KeyEncryption, context
-- "sso-client-secret:<tenant_id>") and never returned by the API. JIT provisioning is opt-in.
ALTER TABLE sso_connections
  ADD COLUMN client_secret_ciphertext bytea,
  ADD COLUMN kek_ref text,
  ADD COLUMN jit_role text CHECK (jit_role IN ('recruiter', 'hiring_manager', 'reviewer', 'sme', 'employee', 'candidate')),
  ADD CONSTRAINT sso_secret_has_kek CHECK ((client_secret_ciphertext IS NULL) = (kek_ref IS NULL));

-- Platform staff (super_admin). Not tenant data, so no RLS. Sign-in only via the workforce IdP.
CREATE TABLE staff_accounts (
  staff_id       uuid PRIMARY KEY,
  email          text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  display_name   text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  roles          text[] NOT NULL CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['super_admin']),
  status         text NOT NULL CHECK (status IN ('active', 'disabled')),
  last_login_at  timestamptz,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
REVOKE DELETE ON staff_accounts FROM atlas_app;

-- In-flight federated logins (10 minutes, single use). Looked up by the hash of the `state`
-- (OIDC) or RelayState (SAML) the browser brings back. Platform-level: the staff flow has no
-- tenant, and the row is found before the tenant is trusted.
CREATE TABLE federation_states (
  state_hash        bytea PRIMARY KEY CHECK (length(state_hash) = 32),
  kind              text NOT NULL CHECK (kind IN ('tenant', 'staff')),
  tenant_id         uuid,
  protocol          text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  nonce             text,                    -- OIDC: echoed in the ID token
  idp_code_verifier text,                    -- OIDC: our PKCE verifier towards the IdP
  saml_request_id   text,                    -- SAML: the response must answer this AuthnRequest
  client_id         text NOT NULL,
  redirect_uri      text NOT NULL,
  code_challenge    text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  client_state      text NOT NULL,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'tenant') = (tenant_id IS NOT NULL)),
  CHECK (protocol = 'saml' OR (nonce IS NOT NULL AND idp_code_verifier IS NOT NULL))
);
CREATE INDEX ix_federation_states_expiry ON federation_states (expires_at);

-- Atlas authorization codes for its own clients (60 seconds, single use, PKCE S256).
CREATE TABLE authorization_codes (
  code_hash       bytea PRIMARY KEY CHECK (length(code_hash) = 32),
  kind            text NOT NULL CHECK (kind IN ('tenant', 'staff')),
  tenant_id       uuid,
  subject_id      uuid NOT NULL,             -- users.user_id or staff_accounts.staff_id
  client_id       text NOT NULL,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  amr             text[] NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'tenant') = (tenant_id IS NOT NULL))
);
CREATE INDEX ix_authorization_codes_expiry ON authorization_codes (expires_at);

-- Single-use rows: the app may only mark them consumed (cleanup runs as the owner).
REVOKE UPDATE, DELETE ON federation_states, authorization_codes FROM atlas_app;
GRANT UPDATE (consumed_at) ON federation_states, authorization_codes TO atlas_app;

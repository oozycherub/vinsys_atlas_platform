-- 0007_profiles: owned by profile-svc (docs/prompts/04-profile-svc.md §3).
-- Strict tenant RLS on every table; composite (tenant_id, …) foreign keys inside the service.
-- No foreign keys to other services' tables (tenants, users, skills): they own those rows, and
-- references are checked through their APIs and kept consistent through events.

CREATE TYPE candidate_source AS ENUM ('external_applicant', 'employee', 'referral', 'sourced', 'rediscovered');
CREATE TYPE skill_evidence_source AS ENUM ('assessment', 'certification', 'manager', 'ai_interview', 'multi_rater',
                                           'project_inference', 'resume_inference', 'learning_completion', 'self');
CREATE TYPE parse_status AS ENUM ('pending_upload', 'uploaded', 'parsing', 'parsed',
                                  'failed', 'failed_retryable', 'quarantined');

CREATE TABLE candidates (
  tenant_id               uuid NOT NULL,
  candidate_id            uuid NOT NULL,
  user_id                 uuid,                                -- set when the profile belongs to a login
  source                  candidate_source NOT NULL,
  external_ref            text CHECK (length(external_ref) <= 200),
  -- PII: AES-256-GCM with the tenant DEK, AAD tenant|candidate|pii. {full_name, email, phone, address, dob}
  pii_enc                 bytea NOT NULL,
  email_bidx              bytea CHECK (octet_length(email_bidx) = 32),   -- HMAC blind index (per-tenant key)
  phone_bidx              bytea CHECK (octet_length(phone_bidx) = 32),
  current_title           text CHECK (length(current_title) <= 200),
  job_profile_id          uuid,
  department              text CHECK (length(department) <= 200),
  location_country        char(2) CHECK (location_country ~ '^[A-Z]{2}$'),
  total_experience_months int CHECK (total_experience_months BETWEEN 0 AND 900),
  profile                 jsonb NOT NULL DEFAULT '{}'::jsonb,  -- REDACTED ParsedResumeV3 (never PII)
  profile_version         int NOT NULL DEFAULT 0,
  marketplace_opt_in      boolean NOT NULL DEFAULT false,
  consent                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_activity_at        timestamptz NOT NULL DEFAULT now(),  -- drives retention
  legal_hold              boolean NOT NULL DEFAULT false,
  version                 int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id),
  UNIQUE (tenant_id, candidate_id)
);
CREATE UNIQUE INDEX ux_candidates_email_bidx ON candidates (tenant_id, email_bidx) WHERE email_bidx IS NOT NULL;
CREATE INDEX ix_candidates_phone_bidx ON candidates (tenant_id, phone_bidx) WHERE phone_bidx IS NOT NULL;
CREATE UNIQUE INDEX ux_candidates_external_ref ON candidates (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX ux_candidates_user ON candidates (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ix_candidates_tenant_activity ON candidates (tenant_id, last_activity_at DESC, candidate_id DESC);
CREATE INDEX ix_candidates_retention ON candidates (tenant_id, last_activity_at) WHERE legal_hold = false;
CREATE TRIGGER trg_candidates_updated BEFORE UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only ledger: every proficiency observation with its provenance.
CREATE TABLE candidate_skill_evidence (
  tenant_id     uuid NOT NULL,
  evidence_id   uuid NOT NULL,
  candidate_id  uuid NOT NULL,
  skill_id      uuid NOT NULL,                                 -- taxonomy-svc skill (checked via its API)
  source        skill_evidence_source NOT NULL,
  proficiency   numeric(3,2) NOT NULL CHECK (proficiency BETWEEN 0 AND 5),
  confidence    numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_ref    uuid,                                          -- session / document / rater id
  reason        text CHECK (length(reason) <= 500),            -- mandatory for self-ratings
  recorded_by   text NOT NULL,
  observed_at   timestamptz NOT NULL,
  valid_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evidence_id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, candidate_id) ON DELETE CASCADE,
  CHECK (source <> 'self' OR reason IS NOT NULL)
);
CREATE INDEX ix_cse_candidate_skill ON candidate_skill_evidence (tenant_id, candidate_id, skill_id, observed_at DESC);
CREATE UNIQUE INDEX ux_cse_source_ref ON candidate_skill_evidence (tenant_id, candidate_id, skill_id, source, source_ref)
  WHERE source_ref IS NOT NULL;                                -- an assessment session counts once per skill

-- Materialised fused proficiency, recomputed per (candidate, skill) on every new evidence.
CREATE TABLE candidate_skill_current (
  tenant_id           uuid NOT NULL,
  candidate_id        uuid NOT NULL,
  skill_id            uuid NOT NULL,
  proficiency         numeric(3,2) NOT NULL CHECK (proficiency BETWEEN 0 AND 5),
  is_validated        boolean NOT NULL DEFAULT false,
  calibration_needed  boolean NOT NULL DEFAULT false,
  evidence_count      int NOT NULL DEFAULT 0,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, candidate_id, skill_id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, candidate_id) ON DELETE CASCADE
);
CREATE INDEX ix_csc_skill_prof ON candidate_skill_current (tenant_id, skill_id, proficiency DESC);

CREATE TABLE resume_documents (
  tenant_id       uuid NOT NULL,
  document_id     uuid NOT NULL,
  candidate_id    uuid NOT NULL,
  storage_key     text NOT NULL UNIQUE,                        -- t/{tenant_id}/resumes/{document_id}
  sha256          bytea NOT NULL CHECK (octet_length(sha256) = 32),
  mime_type       text NOT NULL CHECK (mime_type IN ('application/pdf',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'application/msword', 'image/png', 'image/jpeg', 'text/plain')),
  byte_size       int NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  page_count      smallint,
  language        char(2),
  parse_status    parse_status NOT NULL DEFAULT 'pending_upload',
  parser_version  text,
  error_code      text,
  flags           text[] NOT NULL DEFAULT '{}',
  parsed_json     jsonb,                                       -- redacted snapshot of this document
  upload_expires_at timestamptz NOT NULL,
  uploaded_at     timestamptz,
  parsed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id),
  UNIQUE (tenant_id, document_id),
  UNIQUE (tenant_id, sha256),                                  -- identical uploads are de-duplicated
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, candidate_id) ON DELETE CASCADE,
  CHECK (storage_key = 't/' || tenant_id::text || '/resumes/' || document_id::text)
);
CREATE INDEX ix_resume_docs_candidate ON resume_documents (tenant_id, candidate_id, created_at DESC);
CREATE INDEX ix_resume_docs_pending ON resume_documents (created_at)
  WHERE parse_status IN ('pending_upload', 'parsing', 'failed_retryable');

-- Data-subject requests. Outlive the candidate (no FK) so the erasure certificate survives.
CREATE TABLE privacy_requests (
  tenant_id          uuid NOT NULL,
  request_id         uuid NOT NULL,
  candidate_id       uuid NOT NULL,
  request_type       text NOT NULL CHECK (request_type IN ('access', 'erasure')),
  reason             text NOT NULL CHECK (reason IN ('data_subject', 'retention')),
  status             text NOT NULL CHECK (status IN ('completed', 'awaiting_acks', 'overdue')),
  requested_by       text NOT NULL,
  ack_required_from  text[] NOT NULL DEFAULT '{}',
  acks               jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{service, at}]
  export_enc         bytea,                                    -- access: the export, encrypted (tenant DEK)
  certificate        jsonb,                                    -- erasure: what was deleted, when, who acknowledged
  due_at             timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  PRIMARY KEY (request_id),
  UNIQUE (tenant_id, request_id),
  CHECK ((request_type = 'access') = (export_enc IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX ix_privacy_requests_open ON privacy_requests (tenant_id, due_at) WHERE status = 'awaiting_acks';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['candidates', 'candidate_skill_evidence', 'candidate_skill_current', 'resume_documents', 'privacy_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The evidence ledger is append-only for the app (rows go only with their candidate).
REVOKE UPDATE ON candidate_skill_evidence FROM atlas_app;

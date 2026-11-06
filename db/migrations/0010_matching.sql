-- 0010_matching: owned by matching-svc (docs/prompts/07-matching-svc.md §3).
-- No foreign keys to other services' tables (0007 rule): candidates, job profiles and skills
-- are referenced by id and kept current through events.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE requisition_status AS ENUM ('open', 'on_hold', 'closed');
CREATE TYPE calibration_status AS ENUM ('uncalibrated', 'calibrated', 'stale');
CREATE TYPE match_band AS ENUM ('strong', 'good', 'partial', 'weak');

CREATE TABLE job_requisitions (
  tenant_id             uuid NOT NULL,
  requisition_id        uuid NOT NULL,
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
  openings              int NOT NULL DEFAULT 1 CHECK (openings BETWEEN 1 AND 1000),
  location              text CHECK (length(location) <= 200),
  hiring_manager_id     uuid,
  job_profile_id        uuid,
  min_experience_years  numeric(4,1) CHECK (min_experience_years BETWEEN 0 AND 60),
  keywords              text[] NOT NULL DEFAULT '{}',
  status                requisition_status NOT NULL DEFAULT 'open',
  calibration_status    calibration_status NOT NULL DEFAULT 'uncalibrated',
  -- Snapshot used for scoring: [{skill_id, weight, target, must_have, related: [{skill_id, rho}]}],
  -- plus job_profile_version and the BM25 query. Re-calibration replaces it.
  calibration           jsonb,
  calibration_version   int NOT NULL DEFAULT 0,
  calibrated_at         timestamptz,
  version               int NOT NULL DEFAULT 1,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requisition_id),
  UNIQUE (tenant_id, requisition_id)
);
CREATE INDEX ix_requisitions_list ON job_requisitions (tenant_id, created_at DESC, requisition_id DESC);
CREATE INDEX ix_requisitions_profile ON job_requisitions (tenant_id, job_profile_id) WHERE job_profile_id IS NOT NULL;
CREATE TRIGGER trg_requisitions_updated BEFORE UPDATE ON job_requisitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ē_j per embedding model (the job description plus required-skill text).
CREATE TABLE requisition_embeddings (
  tenant_id       uuid NOT NULL,
  requisition_id  uuid NOT NULL,
  model_id        text NOT NULL,
  content_sha256  text NOT NULL,
  embedding       vector(1024) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, requisition_id, model_id),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES job_requisitions (tenant_id, requisition_id) ON DELETE CASCADE
);

-- Read model of what scoring needs about a candidate, fed by profile events. The profile text is
-- the REDACTED parsed profile (no names), so lexical scoring never sees PII.
CREATE TABLE candidate_features (
  tenant_id                uuid NOT NULL,
  candidate_id             uuid NOT NULL,
  skills                   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{skill_id, proficiency, is_validated}]
  evidence                 jsonb NOT NULL DEFAULT '{}'::jsonb,   -- skill_id → short redacted snippet
  total_experience_months  int CHECK (total_experience_months BETWEEN 0 AND 900),
  current_title            text,
  profile_text             text NOT NULL DEFAULT '' CHECK (length(profile_text) <= 50000),
  profile_tsv              tsvector GENERATED ALWAYS AS (to_tsvector('english', profile_text)) STORED,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, candidate_id)
);
CREATE INDEX ix_candidate_features_tsv ON candidate_features USING gin (profile_tsv);

CREATE TABLE match_scores (
  tenant_id        uuid NOT NULL,
  requisition_id   uuid NOT NULL,
  candidate_id     uuid NOT NULL,
  score            numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  band             match_band NOT NULL,
  components       jsonb NOT NULL,
  explanation      jsonb NOT NULL,
  weights_version  text NOT NULL,
  computed_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, requisition_id, candidate_id),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES job_requisitions (tenant_id, requisition_id) ON DELETE CASCADE
);
CREATE INDEX ix_match_scores_rank ON match_scores (tenant_id, requisition_id, score DESC);
CREATE INDEX ix_match_scores_candidate ON match_scores (tenant_id, candidate_id, score DESC);

-- Durable work queue for incremental re-scoring (one row per subject; re-enqueueing coalesces).
CREATE TABLE match_work (
  tenant_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('candidate', 'requisition')),
  subject_id   uuid NOT NULL,
  reason       text NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, subject_id)
);
CREATE INDEX ix_match_work_order ON match_work (enqueued_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_requisitions', 'requisition_embeddings', 'candidate_features', 'match_scores'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The re-scoring worker claims work across tenants in a system transaction.
ALTER TABLE match_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_work FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON match_work
  USING (tenant_id = current_tenant_id() OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id = current_tenant_id() OR current_setting('app.system', true) = 'on');

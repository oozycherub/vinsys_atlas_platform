-- 0011_assessments: owned by assessment-svc (docs/prompts/08-assessment-svc.md §3; PRD §3 §8).
-- No foreign keys to other services' tables (0007 rule): candidates and skills are referenced by
-- id; erasure and tenant purge remove this service's rows through events.

CREATE TYPE question_type      AS ENUM ('mcq', 'multiple_answer', 'true_false', 'fill_blank', 'descriptive', 'coding');
CREATE TYPE question_difficulty AS ENUM ('easy', 'medium', 'hard');
CREATE TYPE assessment_kind    AS ENUM ('skills_test', 'coding', 'ai_interview', 'mixed');
CREATE TYPE assessment_status  AS ENUM ('draft', 'published', 'inactive', 'archived');
CREATE TYPE navigation_mode    AS ENUM ('fixed_section_order', 'section_switch');
CREATE TYPE session_status     AS ENUM ('invited', 'started', 'in_progress', 'paused', 'submitted',
                                        'terminated', 'expired', 'evaluated', 'cancelled');
CREATE TYPE review_status      AS ENUM ('not_required', 'pending_review', 'in_review', 'cleared', 'confirmed_violation');
CREATE TYPE candidate_pipeline AS ENUM ('pending', 'shortlisted', 'on_hold', 'rejected');

CREATE TABLE question_banks (
  tenant_id    uuid NOT NULL,
  bank_id      uuid NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '',
  skill_ids    uuid[] NOT NULL DEFAULT '{}',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bank_id),
  UNIQUE (tenant_id, bank_id)
);

-- A question version is immutable: editing creates version n+1, and assessments pin a version.
CREATE TABLE questions (
  tenant_id      uuid NOT NULL,
  question_id    uuid NOT NULL,
  version        int NOT NULL CHECK (version >= 1),
  bank_id        uuid,
  type           question_type NOT NULL,
  prompt         text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 20000),
  -- Includes the HIDDEN parts: correct options, accepted answers, rubric, test cases.
  payload        jsonb NOT NULL,
  marks          numeric(6,2) NOT NULL CHECK (marks > 0 AND marks <= 1000),
  negative_marks numeric(6,2) NOT NULL DEFAULT 0 CHECK (negative_marks >= 0),
  difficulty     question_difficulty NOT NULL DEFAULT 'medium',
  skill_ids      uuid[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, version),
  UNIQUE (tenant_id, question_id, version),
  FOREIGN KEY (tenant_id, bank_id) REFERENCES question_banks (tenant_id, bank_id)
);
CREATE INDEX ix_questions_bank ON questions (tenant_id, bank_id, status);
-- Content is immutable; only the status changes. DELETE stays: tenant purge removes the rows.
REVOKE UPDATE ON questions FROM atlas_app;
GRANT UPDATE (status) ON questions TO atlas_app;

-- Classical item statistics (difficulty index p = correct / attempts), updated on evaluation.
CREATE TABLE question_stats (
  tenant_id     uuid NOT NULL,
  question_id   uuid NOT NULL,
  version       int NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  correct       int NOT NULL DEFAULT 0,
  score_sum     numeric(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, question_id, version)
);

CREATE TABLE assessments (
  tenant_id         uuid NOT NULL,
  assessment_id     uuid NOT NULL,
  version           int NOT NULL CHECK (version >= 1),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  candidate_alias   text,
  kind              assessment_kind NOT NULL,
  status            assessment_status NOT NULL DEFAULT 'draft',
  navigation        navigation_mode NOT NULL DEFAULT 'fixed_section_order',
  duration_seconds  int NOT NULL CHECK (duration_seconds BETWEEN 60 AND 21600),
  definition        jsonb NOT NULL,              -- sections[] with pinned question versions or bank draws
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- attempts, cool-down, pause allowance, shuffling
  report_config     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- performance bands, skill validity months
  proctoring_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  job_profile_id    uuid,
  lock_version      int NOT NULL DEFAULT 0,
  created_by        text NOT NULL,
  published_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, version),
  UNIQUE (tenant_id, assessment_id, version)
);
CREATE INDEX ix_assessments_tenant_status ON assessments (tenant_id, status, updated_at DESC);
CREATE TRIGGER trg_assessments_updated BEFORE UPDATE ON assessments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Published versions are immutable (defence in depth below the application rule).
CREATE OR REPLACE FUNCTION assessments_published_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.definition IS DISTINCT FROM OLD.definition
    OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
    OR NEW.navigation IS DISTINCT FROM OLD.navigation
    OR NEW.settings IS DISTINCT FROM OLD.settings
    OR NEW.report_config IS DISTINCT FROM OLD.report_config
    OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
    RAISE EXCEPTION 'published assessment versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_assessments_immutable BEFORE UPDATE ON assessments
  FOR EACH ROW EXECUTE FUNCTION assessments_published_immutable();

CREATE TABLE assessment_invites (
  tenant_id           uuid NOT NULL,
  invite_id           uuid NOT NULL,
  assessment_id       uuid NOT NULL,
  assessment_version  int NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('open', 'targeted')),
  token_hash          bytea NOT NULL UNIQUE,     -- sha256 of the link token; the token is shown once
  candidate_id        uuid,                      -- targeted invites
  max_uses            int CHECK (max_uses >= 1),
  uses                int NOT NULL DEFAULT 0,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invite_id),
  UNIQUE (tenant_id, invite_id),
  FOREIGN KEY (tenant_id, assessment_id, assessment_version) REFERENCES assessments (tenant_id, assessment_id, version),
  CHECK (kind = 'open' OR candidate_id IS NOT NULL)
);

CREATE TABLE assessment_sessions (
  tenant_id           uuid NOT NULL,
  session_id          uuid NOT NULL,
  assessment_id       uuid NOT NULL,
  assessment_version  int NOT NULL,
  candidate_id        uuid NOT NULL,
  attempt_no          smallint NOT NULL DEFAULT 1 CHECK (attempt_no BETWEEN 1 AND 51),
  invite_id           uuid,
  access_token_hash   bytea NOT NULL UNIQUE,     -- the candidate's session token (bound to this session)
  status              session_status NOT NULL DEFAULT 'invited',
  plan                jsonb NOT NULL,            -- the pinned questions of this attempt (bank draws resolved)
  current_section     smallint NOT NULL DEFAULT 1,
  invited_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  deadline_at         timestamptz,               -- server-authoritative timer
  submitted_at        timestamptz,
  evaluated_at        timestamptz,
  last_heartbeat_at   timestamptz,
  paused_at           timestamptz,
  paused_seconds      int NOT NULL DEFAULT 0,
  client_info         jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_score           numeric(8,2),
  max_score           numeric(8,2),
  percent_score       numeric(5,2) GENERATED ALWAYS AS
                        (CASE WHEN max_score > 0 THEN round(raw_score * 100 / max_score, 2) END) STORED,
  performance_band    text,
  skill_scores        jsonb,
  trust_score         smallint CHECK (trust_score BETWEEN 0 AND 100),
  review_status       review_status NOT NULL DEFAULT 'not_required',
  candidate_status    candidate_pipeline NOT NULL DEFAULT 'pending',
  termination_reason  text,
  lock_version        int NOT NULL DEFAULT 0,    -- every transition is a compare-and-set on this
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id),
  UNIQUE (tenant_id, session_id),
  UNIQUE (tenant_id, assessment_id, candidate_id, attempt_no),
  FOREIGN KEY (tenant_id, assessment_id, assessment_version) REFERENCES assessments (tenant_id, assessment_id, version),
  CHECK (submitted_at IS NULL OR started_at IS NOT NULL),
  CHECK (deadline_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX ix_sessions_assessment ON assessment_sessions (tenant_id, assessment_id, status, submitted_at DESC);
CREATE INDEX ix_sessions_candidate ON assessment_sessions (tenant_id, candidate_id, created_at DESC);
CREATE INDEX ix_sessions_live ON assessment_sessions (deadline_at) WHERE status IN ('started', 'in_progress', 'paused');
CREATE INDEX ix_sessions_review ON assessment_sessions (tenant_id, review_status)
  WHERE review_status IN ('pending_review', 'in_review');
CREATE TRIGGER trg_sessions_updated BEFORE UPDATE ON assessment_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE session_responses (
  tenant_id     uuid NOT NULL,
  session_id    uuid NOT NULL,
  question_id   uuid NOT NULL,
  answer        jsonb,
  client_rev    int NOT NULL DEFAULT 0,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  auto_score    numeric(8,2),              -- deterministic scoring, or the judge / interview result
  manual_score  numeric(8,2),              -- reviewers' consensus
  state         text NOT NULL DEFAULT 'saved'
                CHECK (state IN ('saved', 'scored', 'pending_review', 'pending_judge', 'reviewed')),
  judge         jsonb,
  PRIMARY KEY (tenant_id, session_id, question_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES assessment_sessions (tenant_id, session_id) ON DELETE CASCADE
);

CREATE TABLE review_assignments (
  tenant_id     uuid NOT NULL,
  session_id    uuid NOT NULL,
  reviewer_id   text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  scores        jsonb,                     -- {question_id: marks}
  comment       text CHECK (length(comment) <= 5000),
  assigned_by   text NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (tenant_id, session_id, reviewer_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES assessment_sessions (tenant_id, session_id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['question_banks', 'questions', 'question_stats', 'assessments', 'assessment_invites',
                           'session_responses', 'review_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- Sessions and invites are also resolved by token (the candidate has no tenant claim) and swept
-- for expiry across tenants, both inside system transactions.
ALTER TABLE assessment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assessment_sessions
  USING (tenant_id = current_tenant_id() OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id = current_tenant_id() OR current_setting('app.system', true) = 'on');
DROP POLICY tenant_isolation ON assessment_invites;
CREATE POLICY tenant_isolation ON assessment_invites
  USING (tenant_id = current_tenant_id() OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id = current_tenant_id());

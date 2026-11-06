-- Brick 11: interview-svc (docs/prompts/11-interview-svc.md, PRD Module 4). ADR-0008.
-- No foreign keys to other services' tables. Transcripts are candidate data: erasure deletes the
-- candidate's sessions and everything below them cascades.

-- An AI interview: a template recruiters build from a job profile. Its plan is versioned; a
-- published version is frozen (every candidate gets the same core questions, PRD §2.4b).
CREATE TABLE interviews (
  tenant_id          uuid NOT NULL,
  interview_id       uuid PRIMARY KEY,
  job_profile_id     uuid NOT NULL,
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  mode               text NOT NULL CHECK (mode IN ('voice', 'text')),
  language           text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_version  int,                                   -- the version new sessions use
  -- Recommendation thresholds on the weighted 1–5 score (deterministic code, never the LLM).
  thresholds         jsonb NOT NULL DEFAULT '{"advance": 3.5, "hold": 2.5}'::jsonb,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  lock_version       int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, interview_id)
);
CREATE INDEX ix_interviews_created ON interviews (tenant_id, created_at DESC, interview_id DESC);
CREATE TRIGGER trg_interviews_updated BEFORE UPDATE ON interviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE interview_plans (
  tenant_id     uuid NOT NULL,
  interview_id  uuid NOT NULL REFERENCES interviews (interview_id) ON DELETE CASCADE,
  version       int NOT NULL CHECK (version >= 1),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  plan          jsonb NOT NULL,
  source        text NOT NULL CHECK (source IN ('generated', 'recruiter')),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  published_by  text,
  PRIMARY KEY (interview_id, version)
);

-- A published plan is frozen: only its status may move on (published → superseded).
CREATE OR REPLACE FUNCTION interview_plans_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.version <> OLD.version
                                OR NEW.interview_id <> OLD.interview_id) THEN
    RAISE EXCEPTION 'interview plan % v% is frozen', OLD.interview_id, OLD.version
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'a superseded plan cannot be republished' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_interview_plans_frozen BEFORE UPDATE ON interview_plans
  FOR EACH ROW EXECUTE FUNCTION interview_plans_frozen();

-- One AI interview taken by one candidate (an `ai_interview` question of an assessment session).
CREATE TABLE interview_sessions (
  tenant_id              uuid NOT NULL,
  session_id             uuid PRIMARY KEY,
  interview_id           uuid NOT NULL REFERENCES interviews (interview_id),
  plan_version           int NOT NULL,
  assessment_id          uuid NOT NULL,
  assessment_session_id  uuid NOT NULL,
  question_id            uuid NOT NULL,
  candidate_id           uuid NOT NULL,
  mode                   text NOT NULL CHECK (mode IN ('voice', 'text')),
  status                 text NOT NULL DEFAULT 'created'
                         CHECK (status IN ('created', 'active', 'paused', 'scoring', 'completed',
                                           'declined', 'escalated', 'abandoned')),
  phase                  text NOT NULL DEFAULT 'CONSENT',
  token_hash             bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  jurisdictions          text[] NOT NULL DEFAULT '{}',      -- tenant compliance snapshot
  checkpoint_seq         bigint NOT NULL DEFAULT 0,
  -- Agent allocation: the worker holding the lease runs the graph; a lapsed lease is reclaimed and
  -- the session resumes from its last checkpoint on another worker.
  worker_id              text,
  lease_expires_at       timestamptz,
  wants_worker           boolean NOT NULL DEFAULT false,      -- voice: joined, needs an agent
  paused_at              timestamptz,                         -- PAUSED since (max 120 s)
  recording_key          text,
  turns_flushed          int NOT NULL DEFAULT 0,
  started_at             timestamptz,
  ended_at               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  lock_version           int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, session_id),
  UNIQUE (assessment_session_id, question_id)
);
CREATE INDEX ix_interview_sessions_candidate ON interview_sessions (tenant_id, candidate_id);
CREATE INDEX ix_interview_sessions_claimable ON interview_sessions (lease_expires_at)
  WHERE wants_worker AND status IN ('created', 'active', 'paused', 'scoring');
CREATE INDEX ix_interview_sessions_assessment ON interview_sessions (tenant_id, assessment_id);
CREATE INDEX ix_interview_sessions_paused ON interview_sessions (paused_at) WHERE status = 'paused';

-- Expected demand: an assessment session started whose assessment has had voice interviews, so an
-- agent is likely needed within minutes (`assessment.session.started.v1` → KEDA pre-scaling).
-- Removed when the interview session is created, or when the assessment's deadline passes.
CREATE TABLE interview_demand (
  tenant_id              uuid NOT NULL,
  assessment_session_id  uuid PRIMARY KEY,
  assessment_id          uuid NOT NULL,
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_interview_demand_expiry ON interview_demand (expires_at);

-- LangGraph checkpoints: the whole graph state after every node (PRD §2.4b).
CREATE TABLE interview_checkpoints (
  tenant_id   uuid NOT NULL,
  session_id  uuid NOT NULL REFERENCES interview_sessions (session_id) ON DELETE CASCADE,
  seq         bigint NOT NULL CHECK (seq >= 1),
  node        text NOT NULL,
  state       jsonb NOT NULL,
  worker_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE interview_turns (
  tenant_id    uuid NOT NULL,
  session_id   uuid NOT NULL REFERENCES interview_sessions (session_id) ON DELETE CASCADE,
  turn_index   int NOT NULL CHECK (turn_index >= 0),
  role         text NOT NULL CHECK (role IN ('interviewer', 'candidate')),
  kind         text NOT NULL,
  qid          text,
  text         text NOT NULL CHECK (length(text) <= 20000),
  t0_ms        bigint NOT NULL,
  t1_ms        bigint NOT NULL,
  stt_conf     real,                                        -- avg_logprob (voice only)
  interrupted  boolean NOT NULL DEFAULT false,              -- barge-in cut the AI utterance
  excluded     boolean NOT NULL DEFAULT false,              -- not scored (injection attempt)
  flags        text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, turn_index)
);

-- Turn evaluator output (off the latency path): evidence and a provisional level per question.
CREATE TABLE interview_turn_evaluations (
  tenant_id          uuid NOT NULL,
  session_id         uuid NOT NULL REFERENCES interview_sessions (session_id) ON DELETE CASCADE,
  qid                text NOT NULL,
  evidence           jsonb NOT NULL,
  provisional_level  smallint CHECK (provisional_level BETWEEN 1 AND 5),
  model              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, qid)
);

CREATE TABLE interview_evaluations (
  tenant_id          uuid NOT NULL,
  session_id         uuid PRIMARY KEY REFERENCES interview_sessions (session_id) ON DELETE CASCADE,
  revision           int NOT NULL DEFAULT 1,
  competencies       jsonb NOT NULL,     -- [{skill_id, name, weight, score|null, rationale, evidence, status}]
  weighted_score     numeric(4,3),       -- 1–5 over evidenced competencies; NULL when none
  recommendation     text CHECK (recommendation IN ('advance', 'hold', 'do_not_advance')),
  requires_approval  boolean NOT NULL DEFAULT false,
  approved_by        text,
  approved_at        timestamptz,
  flags              text[] NOT NULL DEFAULT '{}',
  model              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_interview_evaluations_updated BEFORE UPDATE ON interview_evaluations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Human overrides, with a reason (audit, and calibration data). Append-only for the app.
CREATE TABLE evaluation_overrides (
  tenant_id    uuid NOT NULL,
  override_id  uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES interview_sessions (session_id) ON DELETE CASCADE,
  by_user      text NOT NULL,
  reason       text NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  before       jsonb NOT NULL,
  after        jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_evaluation_overrides_session ON evaluation_overrides (tenant_id, session_id, created_at);

-- RLS: tenant isolation everywhere. Interview tokens and the worker's lease claims run in system
-- transactions (app.system = 'on'), then the work runs in the tenant's transaction.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['interviews', 'interview_plans', 'interview_sessions', 'interview_checkpoints',
                           'interview_demand',
                           'interview_turns', 'interview_turn_evaluations', 'interview_evaluations',
                           'evaluation_overrides']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
  END LOOP;
END $$;
CREATE POLICY system_read ON interview_sessions FOR SELECT
  USING (current_setting('app.system', true) = 'on');
CREATE POLICY system_lease ON interview_sessions FOR UPDATE
  USING (current_setting('app.system', true) = 'on')
  WITH CHECK (current_setting('app.system', true) = 'on');
-- Expiry runs in a system transaction; DELETE ... WHERE also needs the rows to be visible.
CREATE POLICY system_read ON interview_demand FOR SELECT
  USING (current_setting('app.system', true) = 'on');
CREATE POLICY system_expire ON interview_demand FOR DELETE
  USING (current_setting('app.system', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON interviews, interview_plans, interview_sessions,
  interview_checkpoints, interview_turns, interview_turn_evaluations, interview_evaluations,
  interview_demand TO atlas_app;
GRANT SELECT, INSERT, DELETE ON evaluation_overrides TO atlas_app;   -- DELETE: erasure cascade only
REVOKE UPDATE, TRUNCATE ON evaluation_overrides FROM atlas_app;

-- Autoscaling (KEDA PostgreSQL scaler, infra/k8s/interview): voice sessions waiting for an agent,
-- plus expected demand (pre-scaling; each started assessment session counts as one).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atlas_metrics') THEN
    CREATE ROLE atlas_metrics NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE FUNCTION interview_pending_sessions() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*) FROM interview_sessions
          WHERE wants_worker AND status IN ('created', 'active', 'paused', 'scoring')
            AND (lease_expires_at IS NULL OR lease_expires_at < now()))
       + (SELECT count(*) FROM interview_demand WHERE expires_at > now())
$$;
REVOKE ALL ON FUNCTION interview_pending_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION interview_pending_sessions() TO atlas_metrics;

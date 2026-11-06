-- Brick 12: intelligence-svc + intelligence-ml (docs/prompts/12-intelligence-svc.md, PRD Module 5).
-- ADR-0009. No foreign keys to other services' tables. Employees are profile-svc candidates with
-- source 'employee'; their HR record is synced from the HRIS into intel_employees.

-- --- Read models and the HR roster ---------------------------------------------------------

CREATE TABLE intel_employees (
  tenant_id              uuid NOT NULL,
  employee_id            uuid NOT NULL,                        -- profile-svc candidate_id
  user_id                text,                                 -- the login (for "me" and managers)
  manager_user_id        text,
  department             text CHECK (length(department) <= 200),
  location               text CHECK (length(location) <= 200),
  job_profile_id         uuid,
  hired_at               date,
  role_started_at        date,
  last_promotion_at      date,
  manager_changed_at     date,
  compa_ratio            numeric(4,3) CHECK (compa_ratio BETWEEN 0 AND 3),
  engagement_delta       numeric(5,3),
  overtime_hours_4w      numeric(6,1) CHECK (overtime_hours_4w >= 0),
  marketplace_opt_in     boolean NOT NULL DEFAULT false,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
  terminated_at          date,
  termination_voluntary  boolean,
  source_synced_at       timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id),
  CHECK (status = 'active' OR terminated_at IS NOT NULL)
);
CREATE UNIQUE INDEX ux_intel_employees_user ON intel_employees (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ix_intel_employees_manager ON intel_employees (tenant_id, manager_user_id);
CREATE INDEX ix_intel_employees_profile ON intel_employees (tenant_id, job_profile_id);
CREATE TRIGGER trg_intel_employees_updated BEFORE UPDATE ON intel_employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Protected attributes supplied for fairness audits only (never features; HRBP policy below).
CREATE TABLE intel_employee_protected (
  tenant_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  attributes   jsonb NOT NULL,                                -- {"gender": "...", "age_band": "..."}
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id)
);

-- Fused proficiencies from profile.candidate.skills_updated.v1.
CREATE TABLE intel_employee_skills (
  tenant_id     uuid NOT NULL,
  employee_id   uuid NOT NULL,
  skill_id      uuid NOT NULL,
  proficiency   numeric(3,2) NOT NULL CHECK (proficiency BETWEEN 0 AND 5),
  is_validated  boolean NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id, skill_id)
);

-- Job profiles from taxonomy.job_profile.updated.v1 (requirements snapshot per version).
CREATE TABLE intel_job_profiles (
  tenant_id       uuid NOT NULL,
  job_profile_id  uuid NOT NULL,
  version         int NOT NULL,
  status          text NOT NULL,
  title           text NOT NULL,
  skills          jsonb NOT NULL,                            -- [{skill_id, weight, target_proficiency, must_have}]
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_profile_id)
);

-- matching-svc's scores of employees against open requisitions (matching.candidate.rescored.v1).
CREATE TABLE intel_requisition_scores (
  tenant_id       uuid NOT NULL,
  employee_id     uuid NOT NULL,
  requisition_id  uuid NOT NULL,
  score           numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  band            text NOT NULL,
  computed_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, employee_id, requisition_id)
);

-- Per-tenant marketplace and attrition policy (defaults apply when no row exists).
CREATE TABLE intel_tenant_policies (
  tenant_id                       uuid PRIMARY KEY,
  applications_visible_to_manager boolean NOT NULL DEFAULT false,   -- PRD §2.5d: hidden by default
  learning_hours_per_day          numeric(4,2) NOT NULL DEFAULT 1.0 CHECK (learning_hours_per_day > 0 AND learning_hours_per_day <= 8),
  attrition_threshold             numeric(4,3) NOT NULL DEFAULT 0.35 CHECK (attrition_threshold > 0 AND attrition_threshold < 1),
  updated_by                      text NOT NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- --- Career paths and learning ---------------------------------------------------------------

CREATE TABLE job_profile_transitions (
  tenant_id        uuid NOT NULL,
  from_profile_id  uuid NOT NULL,
  to_profile_id    uuid NOT NULL,
  transition_type  text NOT NULL CHECK (transition_type IN ('vertical', 'horizontal', 'diagonal')),
  typical_months   int CHECK (typical_months BETWEEN 0 AND 240),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, from_profile_id, to_profile_id),
  CHECK (from_profile_id <> to_profile_id)
);

CREATE TABLE learning_items (
  tenant_id       uuid NOT NULL,
  item_id         uuid NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  provider        text CHECK (length(provider) <= 200),
  url             text CHECK (length(url) <= 2000),
  skill_ids       uuid[] NOT NULL CHECK (cardinality(skill_ids) BETWEEN 1 AND 20),
  duration_hours  numeric(6,1) NOT NULL CHECK (duration_hours > 0 AND duration_hours <= 2000),
  external_ref    text CHECK (length(external_ref) <= 200),           -- LMS id (integration only)
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id)
);
CREATE UNIQUE INDEX ux_learning_items_ref ON learning_items (tenant_id, external_ref) WHERE external_ref IS NOT NULL;

-- Per employee and their role: gaps (PRD §2.5(iii)), recomputed when skills or profiles change.
CREATE TABLE employee_role_gaps (
  tenant_id       uuid NOT NULL,
  employee_id     uuid NOT NULL,
  job_profile_id  uuid NOT NULL,
  role_gap_pct    numeric(6,4) NOT NULL CHECK (role_gap_pct BETWEEN 0 AND 1),
  readiness       numeric(6,4) NOT NULL CHECK (readiness BETWEEN 0 AND 1),
  gaps            jsonb NOT NULL,                       -- [{skill_id, weight, required, proficiency, gap}]
  department      text,
  location        text,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id)
);

-- Heat-map cells, one row per month, dimension, group and skill (history gives the trend).
CREATE TABLE skill_gap_aggregates (
  tenant_id     uuid NOT NULL,
  period_month  date NOT NULL CHECK (extract(day FROM period_month) = 1),
  dimension     text NOT NULL CHECK (dimension IN ('department', 'job_profile', 'location')),
  group_key     text NOT NULL,
  skill_id      uuid NOT NULL,
  employees     int NOT NULL,
  gap_sum       numeric(12,4) NOT NULL,                 -- Σ w_s · gap_s
  req_sum       numeric(12,4) NOT NULL,                 -- Σ w_s · p_req(s)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_month, dimension, group_key, skill_id)
);

-- Recomputes the current month's cells for some groups (incremental) or all (nightly).
-- SECURITY INVOKER: runs under the caller's RLS context (one tenant).
CREATE FUNCTION intel_refresh_skill_gaps(p_dimension text, p_groups text[]) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_month date := date_trunc('month', now())::date;
  v_tenant uuid := current_tenant_id();
  v_rows int;
BEGIN
  DELETE FROM skill_gap_aggregates
  WHERE tenant_id = v_tenant AND period_month = v_month AND dimension = p_dimension
    AND (p_groups IS NULL OR group_key = ANY (p_groups));
  INSERT INTO skill_gap_aggregates (tenant_id, period_month, dimension, group_key, skill_id, employees, gap_sum, req_sum)
  SELECT g.tenant_id, v_month, p_dimension, k.group_key, (s->>'skill_id')::uuid,
         count(DISTINCT g.employee_id),
         sum((s->>'weight')::numeric * (s->>'gap')::numeric),
         sum((s->>'weight')::numeric * (s->>'required')::numeric)
  FROM employee_role_gaps g
  CROSS JOIN LATERAL (SELECT CASE p_dimension WHEN 'department' THEN g.department
                                              WHEN 'location' THEN g.location
                                              ELSE g.job_profile_id::text END AS group_key) k
  CROSS JOIN LATERAL jsonb_array_elements(g.gaps) s
  WHERE g.tenant_id = v_tenant AND k.group_key IS NOT NULL
    AND (p_groups IS NULL OR k.group_key = ANY (p_groups))
  GROUP BY g.tenant_id, k.group_key, (s->>'skill_id')::uuid;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- --- Marketplace ------------------------------------------------------------------------------

CREATE TABLE projects (
  tenant_id    uuid NOT NULL,
  project_id   uuid NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  account_id   text CHECK (length(account_id) <= 100),          -- the client account (fulfilment)
  start_date   date NOT NULL,
  end_date     date,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE opportunities (
  tenant_id          uuid NOT NULL,
  opportunity_id     uuid NOT NULL,
  type               text NOT NULL CHECK (type IN ('role', 'project', 'gig')),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description        text NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
  job_profile_id     uuid,
  requisition_id     uuid,                                           -- matching-svc JR (role type)
  project_id         uuid,
  skills             jsonb NOT NULL,                                 -- requirements snapshot
  allocation_pct     smallint NOT NULL CHECK (allocation_pct BETWEEN 1 AND 100),
  start_date         date NOT NULL,
  end_date           date,
  location           text CHECK (length(location) <= 200),
  min_tenure_months  int NOT NULL DEFAULT 12 CHECK (min_tenure_months BETWEEN 0 AND 120),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'filled', 'closed')),
  owner_user_id      text NOT NULL,
  embedding          jsonb,                                          -- requirement vector (SEM)
  embedding_model    text,
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX ix_opportunities_open ON opportunities (tenant_id, status, start_date);
CREATE TRIGGER trg_opportunities_updated BEFORE UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE opportunity_matches (
  tenant_id       uuid NOT NULL,
  opportunity_id  uuid NOT NULL,
  employee_id     uuid NOT NULL,
  score           numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),         -- Score(e, o)
  availability    numeric(5,4) NOT NULL CHECK (availability BETWEEN 0 AND 1),  -- A(e, o)
  score_internal  numeric(5,4) NOT NULL CHECK (score_internal BETWEEN 0 AND 1),
  readiness       numeric(5,4) NOT NULL CHECK (readiness BETWEEN 0 AND 1),
  explanation     jsonb NOT NULL,
  low_confidence  boolean NOT NULL DEFAULT false,                              -- cold start
  stale           boolean NOT NULL DEFAULT false,                              -- HR record > 24 h old
  computed_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, opportunity_id, employee_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id) ON DELETE CASCADE
);
CREATE INDEX ix_opportunity_matches_rank ON opportunity_matches (tenant_id, opportunity_id, score_internal DESC);
CREATE INDEX ix_opportunity_matches_employee ON opportunity_matches (tenant_id, employee_id, score_internal DESC);

CREATE TABLE opportunity_applications (
  tenant_id             uuid NOT NULL,
  application_id        uuid NOT NULL,
  opportunity_id        uuid NOT NULL,
  employee_id           uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('application', 'invitation')),
  status                text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  note                  text CHECK (length(note) <= 2000),
  disclosed_to_manager  boolean NOT NULL DEFAULT false,                         -- PRD §2.5d privacy
  created_by            text NOT NULL,
  decided_by            text,
  decided_at            timestamptz,
  allocation_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id),
  UNIQUE (tenant_id, opportunity_id, employee_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id) ON DELETE CASCADE
);
CREATE INDEX ix_opportunity_applications_employee ON opportunity_applications (tenant_id, employee_id);

CREATE TABLE project_allocations (
  tenant_id       uuid NOT NULL,
  allocation_id   uuid NOT NULL,
  project_id      uuid NOT NULL,
  employee_id     uuid NOT NULL,
  percent         smallint NOT NULL CHECK (percent BETWEEN 1 AND 100),
  during          daterange NOT NULL CHECK (NOT isempty(during) AND NOT lower_inf(during)),
  source          text NOT NULL CHECK (source IN ('manual', 'opportunity', 'plan')),
  opportunity_id  uuid,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, allocation_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id)
);
CREATE INDEX ix_project_allocations_employee ON project_allocations (tenant_id, employee_id);

-- Allocation ≤ 100% at every point in time (ADR-0009 §3). An EXCLUDE constraint cannot sum, so
-- a trigger checks the load at each start date in the new range (the maximum of a step function
-- over half-open ranges), serialised per employee by an advisory lock.
CREATE FUNCTION project_allocations_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_load int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':' || NEW.employee_id::text, 0));
  SELECT max(load) INTO v_load FROM (
    SELECT pt.p, NEW.percent + coalesce((
      SELECT sum(a.percent) FROM project_allocations a
      WHERE a.tenant_id = NEW.tenant_id AND a.employee_id = NEW.employee_id
        AND a.allocation_id <> NEW.allocation_id AND a.during @> pt.p), 0) AS load
    FROM (SELECT lower(NEW.during) AS p
          UNION
          SELECT lower(a.during) FROM project_allocations a
          WHERE a.tenant_id = NEW.tenant_id AND a.employee_id = NEW.employee_id
            AND a.allocation_id <> NEW.allocation_id AND a.during && NEW.during
            AND NEW.during @> lower(a.during)) pt
  ) x;
  IF v_load > 100 THEN
    RAISE EXCEPTION 'allocation of employee % would reach % percent', NEW.employee_id, v_load
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_allocations_capacity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_project_allocations_capacity BEFORE INSERT OR UPDATE ON project_allocations
  FOR EACH ROW EXECUTE FUNCTION project_allocations_capacity();

-- --- Demand and fulfilment --------------------------------------------------------------------

CREATE TABLE demand_batches (
  tenant_id    uuid NOT NULL,
  batch_id     uuid NOT NULL,
  file_name    text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 300),
  status       text NOT NULL CHECK (status IN ('processed', 'failed')),
  rows_total   int NOT NULL DEFAULT 0,
  rows_loaded  int NOT NULL DEFAULT 0,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id)
);

CREATE TABLE demands (
  tenant_id       uuid NOT NULL,
  demand_id       uuid NOT NULL,
  batch_id        uuid,
  account_id      text CHECK (length(account_id) <= 100),
  external_ref    text CHECK (length(external_ref) <= 200),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  job_profile_id  uuid,
  skills          jsonb NOT NULL,
  headcount       int NOT NULL CHECK (headcount BETWEEN 1 AND 1000),
  allocation_pct  smallint NOT NULL DEFAULT 100 CHECK (allocation_pct BETWEEN 1 AND 100),
  start_date      date NOT NULL,
  end_date        date,
  location        text CHECK (length(location) <= 200),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, demand_id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX ux_demands_ref ON demands (tenant_id, account_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX ix_demands_open ON demands (tenant_id, status, start_date);

-- The plan is the job (as in sandbox-svc, ADR-0006): intelligence-ml workers claim queued plans.
CREATE TABLE fulfilment_plans (
  tenant_id      uuid NOT NULL,
  plan_id        uuid NOT NULL,
  account_id     text,
  horizon_days   int NOT NULL CHECK (horizon_days BETWEEN 1 AND 730),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  worker_id      text,
  lease_until    timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  solver_status  text,
  objective      numeric(14,4),
  summary        jsonb,
  error          text,
  requested_by   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  PRIMARY KEY (tenant_id, plan_id)
);
CREATE INDEX ix_fulfilment_plans_queue ON fulfilment_plans (created_at) WHERE status IN ('queued', 'running');

CREATE TABLE fulfilment_plan_lines (
  tenant_id         uuid NOT NULL,
  plan_id           uuid NOT NULL,
  demand_id         uuid NOT NULL,
  slot              int NOT NULL CHECK (slot >= 1),
  classification    text NOT NULL CHECK (classification IN ('redeploy', 'upskill', 'recruit')),
  employee_id       uuid,
  readiness         numeric(5,4),
  learning_hours    numeric(8,1),
  days_until_start  int,
  explanation       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, plan_id, demand_id, slot),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES fulfilment_plans (tenant_id, plan_id) ON DELETE CASCADE,
  CHECK (classification = 'recruit' OR employee_id IS NOT NULL)
);

-- --- Attrition (HRBP only, ADR-0009 §6) ------------------------------------------------------

CREATE TABLE attrition_feature_snapshots (
  tenant_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  as_of        date NOT NULL,
  features     jsonb NOT NULL,
  PRIMARY KEY (tenant_id, employee_id, as_of)
);

CREATE TABLE attrition_models (
  tenant_id       uuid NOT NULL,
  model_version   text NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('tenant', 'pooled')),
  trained_at      timestamptz NOT NULL,
  metrics         jsonb NOT NULL,                       -- {auc, precision_at_10, ece, parity}
  features        jsonb NOT NULL,                       -- used
  excluded        jsonb NOT NULL,                       -- dropped as protected proxies, with MI
  alerts_enabled  boolean NOT NULL,
  disabled_reason text,
  psi             jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold       numeric(4,3) NOT NULL DEFAULT 0.35,
  -- LightGBM's text model, the isotonic calibration points and the training feature bins (PSI);
  -- JSON on purpose: no pickled objects are ever loaded.
  artifact        jsonb NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, model_version)
);

CREATE TABLE attrition_scores (
  tenant_id      uuid NOT NULL,
  employee_id    uuid NOT NULL,
  scored_on      date NOT NULL,
  probability    numeric(5,4) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  model_version  text NOT NULL,
  drivers        jsonb NOT NULL,                          -- top-3 SHAP [{feature, phrase, shap}]
  PRIMARY KEY (tenant_id, employee_id, scored_on)
);

CREATE TABLE attrition_alerts (
  tenant_id          uuid NOT NULL,
  alert_id           uuid NOT NULL,
  employee_id        uuid NOT NULL,
  probability        numeric(5,4) NOT NULL,
  delta_30d          numeric(5,4),
  first_crossing     boolean NOT NULL,
  drivers            jsonb NOT NULL,
  suggested_actions  jsonb NOT NULL,
  manager_user_id    text,
  model_version      text NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed')),
  raised_on          date NOT NULL,
  acknowledged_by    text,
  acknowledged_at    timestamptz,
  PRIMARY KEY (tenant_id, alert_id)
);
CREATE INDEX ix_attrition_alerts_employee ON attrition_alerts (tenant_id, employee_id, raised_on DESC);

-- Who read attrition data, and what (append-only for the app role).
CREATE TABLE intel_audit_log (
  tenant_id   uuid NOT NULL,
  audit_id    bigint GENERATED ALWAYS AS IDENTITY,
  at          timestamptz NOT NULL DEFAULT now(),
  subject     text NOT NULL,
  action      text NOT NULL,
  target      text,
  PRIMARY KEY (tenant_id, audit_id)
);

-- --- Incremental work queue -------------------------------------------------------------------

CREATE TABLE intel_work (
  tenant_id     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('opportunity', 'employee')),
  subject_id    uuid NOT NULL,
  reason        text NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, subject_id)
);
CREATE INDEX ix_intel_work_available ON intel_work (available_at);

-- --- RLS --------------------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_employees', 'intel_employee_protected', 'intel_employee_skills',
    'intel_tenant_policies', 'intel_job_profiles', 'intel_requisition_scores', 'job_profile_transitions', 'learning_items',
    'employee_role_gaps', 'skill_gap_aggregates', 'projects', 'opportunities', 'opportunity_matches',
    'opportunity_applications', 'project_allocations', 'demand_batches', 'demands', 'fulfilment_plans',
    'fulfilment_plan_lines', 'attrition_feature_snapshots', 'attrition_models', 'attrition_scores',
    'attrition_alerts', 'intel_audit_log', 'intel_work']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  -- Tenant isolation everywhere ...
  FOREACH t IN ARRAY ARRAY['intel_employees', 'intel_employee_skills', 'intel_tenant_policies', 'intel_job_profiles',
    'intel_requisition_scores', 'job_profile_transitions', 'learning_items', 'employee_role_gaps',
    'skill_gap_aggregates', 'projects', 'opportunities', 'opportunity_matches',
    'opportunity_applications', 'project_allocations', 'demand_batches', 'demands', 'fulfilment_plans',
    'fulfilment_plan_lines', 'intel_audit_log', 'intel_work']
  LOOP
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
  END LOOP;
  -- ... and the attrition tables also need the HRBP context (set only for hrbp-scoped callers and
  -- the attrition pipeline): without it they look empty, even inside the tenant.
  FOREACH t IN ARRAY ARRAY['intel_employee_protected', 'attrition_feature_snapshots',
    'attrition_models', 'attrition_scores', 'attrition_alerts']
  LOOP
    EXECUTE format($p$CREATE POLICY tenant_hrbp ON %I
      USING (tenant_id = current_tenant_id() AND current_setting('app.hrbp', true) = 'on')
      WITH CHECK (tenant_id = current_tenant_id() AND current_setting('app.hrbp', true) = 'on')$p$, t);
  END LOOP;
END $$;
-- Queue scans across tenants run in system transactions (intelligence-ml workers, the TS worker).
CREATE POLICY system_queue ON fulfilment_plans FOR SELECT USING ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL));
CREATE POLICY system_claim ON fulfilment_plans FOR UPDATE
  USING ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL)) WITH CHECK ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL));
CREATE POLICY system_queue ON intel_work FOR SELECT USING ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL));
CREATE POLICY system_tenants ON intel_employees FOR SELECT USING ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL));

GRANT SELECT, INSERT, UPDATE, DELETE ON intel_employees, intel_employee_protected, intel_employee_skills,
  intel_tenant_policies,
  intel_job_profiles, intel_requisition_scores, job_profile_transitions, learning_items, employee_role_gaps,
  skill_gap_aggregates, projects, opportunities, opportunity_matches, opportunity_applications,
  project_allocations, demand_batches, demands, fulfilment_plans, fulfilment_plan_lines,
  attrition_feature_snapshots, attrition_models, attrition_scores, attrition_alerts, intel_work TO atlas_app;
GRANT SELECT, INSERT, DELETE ON intel_audit_log TO atlas_app;   -- DELETE: tenant purge only
REVOKE UPDATE, TRUNCATE ON intel_audit_log FROM atlas_app;
GRANT EXECUTE ON FUNCTION intel_refresh_skill_gaps(text, text[]) TO atlas_app;

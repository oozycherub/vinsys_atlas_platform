-- Brick 9: sandbox-svc (docs/prompts/09-sandbox-svc.md, PRD §2.2 and §3 "Coding sandbox").
-- The submission row is also the job: workers claim it with FOR UPDATE SKIP LOCKED under a lease
-- (ADR-0006), so enqueueing commits atomically with the submission and its idempotency key.
-- No foreign keys to other services' tables (sessions and questions belong to assessment-svc).

CREATE TYPE submission_mode AS ENUM ('run', 'submit', 'verify');
CREATE TYPE judge_verdict AS ENUM (
  'queued', 'running', 'accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded',
  'output_limit_exceeded', 'runtime_error', 'compilation_error', 'internal_error');
CREATE TYPE judge_lane AS ENUM ('interactive', 'submit', 'bulk');
CREATE TYPE bundle_status AS ENUM ('pending', 'verified', 'flaky', 'reference_failed');

-- Global language registry (no tenant data, no RLS). Commands use the paths of the language base
-- images in infra/sandbox-images/build.sh; they are plain argv (no shell). Images are pinned by digest; the release
-- pipeline writes the real digests, and a worker refuses languages whose digest is not its own.
CREATE TABLE sandbox_languages (
  language_id     smallint PRIMARY KEY,
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  name            text NOT NULL UNIQUE,
  image_digest    text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_file     text NOT NULL CHECK (source_file ~ '^[A-Za-z0-9_.]{1,64}$'),
  compile_cmd     text,
  run_cmd         text NOT NULL,
  cpu_multiplier  numeric(3,1) NOT NULL DEFAULT 1.0 CHECK (cpu_multiplier BETWEEN 0.5 AND 5),
  mem_multiplier  numeric(3,1) NOT NULL DEFAULT 1.0 CHECK (mem_multiplier BETWEEN 0.5 AND 5),
  is_enabled      boolean NOT NULL DEFAULT true
);

INSERT INTO sandbox_languages (language_id, slug, name, image_digest, source_file, compile_cmd, run_cmd, cpu_multiplier, mem_multiplier, is_enabled) VALUES
  (71, 'python', 'Python 3.12', 'sha256:' || repeat('0', 64), 'main.py', NULL, '/usr/local/bin/python3 -I -S main.py', 3.0, 1.5, true),
  (62, 'java', 'Java 21', 'sha256:' || repeat('0', 64), 'Main.java', '/opt/java/openjdk/bin/javac -J-Xmx512m -J-XX:+UseSerialGC -J-XX:ActiveProcessorCount=1 Main.java', '/opt/java/openjdk/bin/java -XX:+UseSerialGC -XX:ActiveProcessorCount=1 -XX:TieredStopAtLevel=1 -Xss64m -Xmx${MEM}m Main', 2.0, 2.0, true),
  (54, 'cpp', 'C++20 (GCC 13)', 'sha256:' || repeat('0', 64), 'main.cpp', '/usr/local/bin/g++ -O2 -std=c++20 -pipe -ftemplate-depth=900 main.cpp -o a.out', './a.out', 1.0, 1.0, true),
  (50, 'c', 'C17 (GCC 13)', 'sha256:' || repeat('0', 64), 'main.c', '/usr/local/bin/gcc -O2 -std=c17 -pipe main.c -o a.out -lm', './a.out', 1.0, 1.0, true),
  (63, 'node', 'Node.js 22', 'sha256:' || repeat('0', 64), 'main.js', NULL, '/usr/local/bin/node --max-old-space-size=${MEM} --stack-size=65500 main.js', 2.5, 2.0, true),
  (60, 'go', 'Go 1.23', 'sha256:' || repeat('0', 64), 'main.go', '/usr/local/go/bin/go build -o a.out main.go', './a.out', 1.2, 1.2, true),
  -- SQL needs a throw-away Postgres inside the box (PRD); registered but disabled until built.
  (82, 'sql', 'SQL (PostgreSQL 16)', 'sha256:' || repeat('0', 64), 'main.sql', NULL, '/usr/bin/psql -f main.sql', 1.0, 1.0, false);

GRANT SELECT ON sandbox_languages TO atlas_app;

-- Test cases and reference solution per question version. The cases themselves live in object
-- storage (t/{tenant}/sandbox/bundles/...), addressed by checksum and cached on worker nodes.
CREATE TABLE test_case_bundles (
  tenant_id          uuid NOT NULL,
  question_id        uuid NOT NULL,
  question_version   int  NOT NULL CHECK (question_version >= 1),
  object_key         text NOT NULL,
  checksum           bytea NOT NULL CHECK (octet_length(checksum) = 32),
  test_count         smallint NOT NULL CHECK (test_count BETWEEN 1 AND 200),
  sample_count       smallint NOT NULL DEFAULT 0,
  checker            jsonb NOT NULL DEFAULT '{"kind":"trim_ws"}'::jsonb,
  checker_language_id smallint REFERENCES sandbox_languages (language_id),
  checker_source     text CHECK (octet_length(checker_source) <= 65536),
  limits             jsonb NOT NULL DEFAULT '{}'::jsonb,
  languages          text[] NOT NULL CHECK (cardinality(languages) BETWEEN 1 AND 40),
  reference_language_id smallint NOT NULL REFERENCES sandbox_languages (language_id),
  reference_source   text NOT NULL CHECK (octet_length(reference_source) <= 65536),
  status             bundle_status NOT NULL DEFAULT 'pending',
  status_detail      text,
  verify_submission_id uuid,
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, question_id, question_version),
  CHECK ((checker->>'kind' = 'custom') = (checker_source IS NOT NULL AND checker_language_id IS NOT NULL))
);

CREATE TABLE coding_submissions (
  tenant_id          uuid NOT NULL,
  submission_id      uuid PRIMARY KEY,
  session_id         uuid,                             -- NULL only for reference verification
  assessment_id      uuid,
  candidate_id       uuid,                             -- for erasure; NULL for verification
  question_id        uuid NOT NULL,
  question_version   int  NOT NULL,
  language_id        smallint NOT NULL REFERENCES sandbox_languages (language_id),
  mode               submission_mode NOT NULL,
  lane               judge_lane NOT NULL,
  idempotency_key    text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  source_code        text NOT NULL CHECK (octet_length(source_code) <= 65536),
  source_sha256      bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
  stdin              text CHECK (octet_length(stdin) <= 65536),          -- runs only
  status             judge_verdict NOT NULL DEFAULT 'queued',
  status_detail      text,
  tests_passed       smallint,
  tests_total        smallint,
  score_ratio        numeric(5,4) CHECK (score_ratio BETWEEN 0 AND 1),
  max_cpu_time_ms    int,
  max_memory_kb      int,
  compile_output     text CHECK (octet_length(compile_output) <= 16384),
  run_stdout         text CHECK (octet_length(run_stdout) <= 65536),     -- runs only, purged after 24 h
  run_stderr         text CHECK (octet_length(run_stderr) <= 65536),
  worker_id          text,
  lease_until        timestamptz,
  attempt_count      smallint NOT NULL DEFAULT 0,
  similarity_max     numeric(4,3),
  similar_submission_id uuid,
  queued_at          timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  UNIQUE (tenant_id, submission_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((session_id IS NULL) = (mode = 'verify')),
  CHECK ((candidate_id IS NULL) = (mode = 'verify')),
  CHECK ((stdin IS NULL) OR mode = 'run')
);
CREATE INDEX ix_submissions_candidate ON coding_submissions (tenant_id, candidate_id);
CREATE INDEX ix_submissions_session_q ON coding_submissions (tenant_id, session_id, question_id, queued_at DESC);
-- Scheduler: head of each tenant's queue per lane and language.
CREATE INDEX ix_submissions_queue ON coding_submissions (lane, language_id, tenant_id, queued_at)
  WHERE status = 'queued';
CREATE INDEX ix_submissions_leases ON coding_submissions (lease_until) WHERE status = 'running';
CREATE INDEX ix_submissions_runs_age ON coding_submissions (queued_at) WHERE mode = 'run';

CREATE TABLE coding_test_results (
  tenant_id          uuid NOT NULL,
  submission_id      uuid NOT NULL,
  test_case_id       text NOT NULL,
  ordinal            smallint NOT NULL,
  is_hidden          boolean NOT NULL,
  verdict            judge_verdict NOT NULL,
  detail             text,
  cpu_time_ms        int,
  wall_time_ms       int,
  memory_kb          int,
  exit_code          int,
  signal             smallint,
  stdout_excerpt     text CHECK (octet_length(stdout_excerpt) <= 4096),   -- never returned for hidden tests
  weight             numeric(6,2) NOT NULL DEFAULT 1,
  PRIMARY KEY (submission_id, test_case_id),
  FOREIGN KEY (tenant_id, submission_id) REFERENCES coding_submissions (tenant_id, submission_id) ON DELETE CASCADE
);

-- Winnowing fingerprints of final submissions, compared within the same assessment question.
CREATE TABLE code_fingerprints (
  tenant_id          uuid NOT NULL,
  submission_id      uuid PRIMARY KEY,
  assessment_id      uuid NOT NULL,
  question_id        uuid NOT NULL,
  session_id         uuid NOT NULL,
  hashes             bigint[] NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, submission_id) REFERENCES coding_submissions (tenant_id, submission_id) ON DELETE CASCADE
);
CREATE INDEX ix_fingerprints_question ON code_fingerprints (tenant_id, assessment_id, question_id);

-- Languages in recent demand (from assessment.assessment.published.v1). KEDA keeps one warm
-- worker per language with demand in the last 7 days (infra/k8s/sandbox/keda.yaml).
CREATE TABLE sandbox_language_demand (
  language_id        smallint PRIMARY KEY REFERENCES sandbox_languages (language_id),
  last_published_at  timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON sandbox_language_demand TO atlas_app;

-- Tenant isolation. Workers claim, lease and reap jobs across tenants in a system transaction
-- (app.system = 'on'), then do each job's work in that tenant's transaction.
ALTER TABLE test_case_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_case_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON test_case_bundles
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE coding_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coding_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coding_submissions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY system_queue_read ON coding_submissions FOR SELECT
  USING (current_setting('app.system', true) = 'on');
CREATE POLICY system_queue_update ON coding_submissions FOR UPDATE
  USING (current_setting('app.system', true) = 'on')
  WITH CHECK (current_setting('app.system', true) = 'on');
CREATE POLICY system_queue_purge ON coding_submissions FOR DELETE
  USING (current_setting('app.system', true) = 'on' AND mode = 'run');

ALTER TABLE coding_test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE coding_test_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coding_test_results
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE code_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_fingerprints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON code_fingerprints
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON test_case_bundles, coding_submissions, coding_test_results,
  code_fingerprints TO atlas_app;
-- Judged submissions are immutable for the app role except the async plagiarism columns and the
-- queue bookkeeping, enforced by the trigger below.
CREATE OR REPLACE FUNCTION coding_submissions_final_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('queued', 'running') AND OLD.mode <> 'run' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.source_code IS DISTINCT FROM OLD.source_code
    OR NEW.score_ratio IS DISTINCT FROM OLD.score_ratio
    OR NEW.tests_passed IS DISTINCT FROM OLD.tests_passed) THEN
    RAISE EXCEPTION 'judged submission % is immutable', OLD.submission_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coding_submissions_final_immutable BEFORE UPDATE ON coding_submissions
  FOR EACH ROW EXECUTE FUNCTION coding_submissions_final_immutable();

-- Autoscaling (KEDA PostgreSQL scaler, infra/k8s/sandbox). The scaler's role reads only these two
-- numbers per language, never tenant rows: the functions run as the owner (SECURITY DEFINER)
-- with a fixed search_path.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atlas_metrics') THEN
    CREATE ROLE atlas_metrics NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE FUNCTION sandbox_queue_depth(p_language_id smallint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*) FROM coding_submissions WHERE status IN ('queued', 'running') AND language_id = p_language_id
$$;

-- 1 while the language was offered by an assessment published in the last 7 days (one warm worker).
CREATE FUNCTION sandbox_language_warm(p_language_id smallint) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM sandbox_language_demand
                           WHERE language_id = p_language_id AND last_published_at > now() - interval '7 days')
              THEN 1 ELSE 0 END
$$;

REVOKE ALL ON FUNCTION sandbox_queue_depth(smallint), sandbox_language_warm(smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox_queue_depth(smallint), sandbox_language_warm(smallint) TO atlas_metrics;

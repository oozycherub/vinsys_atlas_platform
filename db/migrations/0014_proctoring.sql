-- Brick 10: proctoring-svc (docs/prompts/10-proctoring-svc.md, PRD §2.3 and §3 "Proctoring logs").
-- ADR-0007. No foreign keys to other services' tables. Biometric data (reference embeddings) is
-- encrypted by the service and deleted at retention end or on erasure (PRD §4.2).

CREATE TYPE proctor_source AS ENUM ('client_event', 'frame_inference', 'audio_inference', 'rules', 'server', 'review');

CREATE TABLE proctoring_sessions (
  tenant_id            uuid NOT NULL,
  session_id           uuid PRIMARY KEY,                     -- the assessment session
  assessment_id        uuid NOT NULL,
  candidate_id         uuid NOT NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finalized')),
  proctor_token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(proctor_token_hash) = 32),
  -- HMAC keys by epoch, each AES-256-GCM encrypted: [{epoch, key, issued_at}] (rotated every 15 min).
  key_ring             jsonb NOT NULL,
  current_epoch        int NOT NULL DEFAULT 1,
  rules                jsonb NOT NULL,                       -- the assessment's rule config (snapshot)
  disabled_rules       text[] NOT NULL DEFAULT '{}',         -- accessibility accommodations
  consent              jsonb NOT NULL,                       -- {version, biometrics, granted_at}
  id_verification      boolean NOT NULL DEFAULT false,
  reference_embeddings bytea,                                -- encrypted; NULL once deleted
  reference_status     text NOT NULL DEFAULT 'pending'
                       CHECK (reference_status IN ('pending', 'verified', 'id_mismatch', 'no_face', 'deleted')),
  last_seq             bigint NOT NULL DEFAULT 0,            -- highest contiguous client seq
  last_client_hash     text,                                 -- hex sha256 of the last client event
  last_log_hash        bytea,                                -- server chain over proctoring_logs rows
  clock_offsets        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- recent offset samples (ms)
  clock_offset_ms      bigint NOT NULL DEFAULT 0,            -- median: occurred_at = client_ts + offset
  state                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- rules engine counters
  trust_score          smallint CHECK (trust_score BETWEEN 0 AND 100),
  band                 text CHECK (band IN ('green', 'yellow', 'red')),
  revision             int NOT NULL DEFAULT 0,
  started_at           timestamptz NOT NULL,
  last_event_at        timestamptz,
  submitted_at         timestamptz,
  finalized_at         timestamptz,
  frames_purged_at     timestamptz,
  lock_version         int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, session_id)
);
CREATE INDEX ix_proctoring_sessions_candidate ON proctoring_sessions (tenant_id, candidate_id);
CREATE INDEX ix_proctoring_sessions_retention ON proctoring_sessions (finalized_at)
  WHERE status = 'finalized' AND frames_purged_at IS NULL;
CREATE INDEX ix_proctoring_sessions_review ON proctoring_sessions (tenant_id, band) WHERE band = 'red';

-- De-duplication of client events on (session_id, seq). The log's own unique index must include
-- the partition key, and occurred_at is clock-corrected, so a retry could land differently.
CREATE TABLE proctoring_event_seqs (
  tenant_id   uuid NOT NULL,
  session_id  uuid NOT NULL,
  seq         bigint NOT NULL CHECK (seq >= 1),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE proctoring_frames (
  tenant_id    uuid NOT NULL,
  frame_id     uuid PRIMARY KEY,
  session_id   uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('frame', 'selfie', 'id_document', 'audio')),
  object_key   text NOT NULL,
  captured_at  timestamptz NOT NULL,
  triggered    boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'uploaded', 'analysed')),
  flagged      boolean NOT NULL DEFAULT false,
  evidence_key text,                                         -- copy kept with the assessment report
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_proctoring_frames_session ON proctoring_frames (tenant_id, session_id, captured_at);

-- The log: append-only for the app, monthly range partitions, hash-chained per session.
CREATE TABLE proctoring_logs (
  tenant_id     uuid NOT NULL,
  log_id        bigint GENERATED ALWAYS AS IDENTITY,
  session_id    uuid NOT NULL,
  source        proctor_source NOT NULL,
  seq           bigint,                                      -- client sequence; NULL for server rows
  event_type    text NOT NULL,                               -- 'tab_hidden', 'violation:multiple_faces', ...
  severity      smallint NOT NULL DEFAULT 0 CHECK (severity BETWEEN 0 AND 3),
  occurred_at   timestamptz NOT NULL,                        -- client time corrected by the server offset
  received_at   timestamptz NOT NULL DEFAULT now(),
  frame_id      uuid,
  model_version text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     bytea,
  event_hash    bytea NOT NULL,                              -- sha256(prev_hash || canonical row)
  PRIMARY KEY (occurred_at, log_id)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ix_proctoring_session_time ON proctoring_logs (tenant_id, session_id, occurred_at);
CREATE INDEX ix_proctoring_violations ON proctoring_logs (tenant_id, session_id) WHERE severity >= 2;
CREATE INDEX brin_proctoring_received ON proctoring_logs USING brin (received_at);
CREATE TABLE proctoring_logs_default PARTITION OF proctoring_logs DEFAULT; -- safety net; alert if non-empty

-- Human decisions on flags (violation rows of the log). Labels feed the active-learning dataset.
CREATE TABLE proctoring_reviews (
  tenant_id   uuid NOT NULL,
  log_id      bigint PRIMARY KEY,
  session_id  uuid NOT NULL,
  rule        text NOT NULL,
  decision    text NOT NULL CHECK (decision IN ('confirmed', 'dismissed')),
  reviewer    text NOT NULL,
  comment     text CHECK (length(comment) <= 2000),
  decided_at  timestamptz NOT NULL
);
CREATE INDEX ix_proctoring_reviews_session ON proctoring_reviews (tenant_id, session_id);

-- Accessibility accommodations granted before (or during) a session; audited in the log too.
CREATE TABLE proctoring_accommodations (
  tenant_id      uuid NOT NULL,
  session_id     uuid PRIMARY KEY,
  disabled_rules text[] NOT NULL CHECK (cardinality(disabled_rules) BETWEEN 1 AND 10),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  granted_by     text NOT NULL,
  granted_at     timestamptz NOT NULL
);

-- RLS: tenant isolation everywhere; proctor tokens and maintenance are looked up in system
-- transactions (app.system = 'on').
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['proctoring_sessions', 'proctoring_event_seqs', 'proctoring_frames',
                           'proctoring_logs', 'proctoring_reviews', 'proctoring_accommodations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
  END LOOP;
END $$;
CREATE POLICY system_read ON proctoring_sessions FOR SELECT
  USING (current_setting('app.system', true) = 'on');
CREATE POLICY system_read ON proctoring_frames FOR SELECT
  USING (current_setting('app.system', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON proctoring_sessions, proctoring_event_seqs, proctoring_frames,
  proctoring_reviews, proctoring_accommodations TO atlas_app;
GRANT SELECT, INSERT ON proctoring_logs TO atlas_app;
REVOKE UPDATE, DELETE, TRUNCATE ON proctoring_logs FROM atlas_app;   -- append-only for the app role
GRANT SELECT, INSERT ON proctoring_logs_default TO atlas_app;
REVOKE UPDATE, DELETE, TRUNCATE ON proctoring_logs_default FROM atlas_app;

-- Partition upkeep (pg_partman's job in the PRD, done by proctoring-svc's maintenance loop through
-- these owner functions): monthly partitions ahead of time, retention by DETACH + DROP.
CREATE FUNCTION proctoring_ensure_partitions(p_months_ahead int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m date := date_trunc('month', now())::date;
  created int := 0;
  name text;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'months ahead must be 0-24';
  END IF;
  FOR i IN 0..p_months_ahead LOOP
    name := format('proctoring_logs_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF proctoring_logs FOR VALUES FROM (%L) TO (%L)',
                     name, m, (m + interval '1 month')::date);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM atlas_app', name);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END $$;

-- Drops whole monthly partitions that end on or before p_before (the maximum tenant retention).
CREATE FUNCTION proctoring_drop_partitions(p_before date) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  dropped text[] := '{}';
  upper_bound date;
BEGIN
  IF current_setting('app.system', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'partition retention runs in a system transaction only';
  END IF;
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'proctoring_logs'::regclass AND c.relname ~ '^proctoring_logs_\d{4}_\d{2}$'
  LOOP
    upper_bound := (to_date(substr(r.relname, 17), 'YYYY_MM') + interval '1 month')::date;
    IF upper_bound <= p_before THEN
      EXECUTE format('ALTER TABLE proctoring_logs DETACH PARTITION %I', r.relname);
      EXECUTE format('DROP TABLE %I', r.relname);
      dropped := dropped || r.relname::text;
    END IF;
  END LOOP;
  RETURN dropped;
END $$;

-- Erasure (data-subject requests, tenant purge): the only way log rows are deleted by the app.
CREATE FUNCTION proctoring_erase_sessions(p_session_ids uuid[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tenant uuid := current_tenant_id();
  n bigint;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'erasure needs a tenant context';
  END IF;
  DELETE FROM proctoring_logs WHERE tenant_id = tenant AND session_id = ANY(p_session_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

SELECT proctoring_ensure_partitions(3);
REVOKE ALL ON FUNCTION proctoring_ensure_partitions(int), proctoring_drop_partitions(date),
  proctoring_erase_sessions(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proctoring_ensure_partitions(int), proctoring_drop_partitions(date),
  proctoring_erase_sessions(uuid[]) TO atlas_app;

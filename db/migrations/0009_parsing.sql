-- 0009_parsing: owned by parsing-svc (docs/prompts/06-parsing-svc.md §3).
-- No foreign keys to profile-svc's tables (0007 rule): candidates are referenced by id, and
-- erasure / tenant purge remove this service's rows through events.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE parse_job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'failed_retryable',
                                      'quarantined');
CREATE TYPE embedding_chunk_type AS ENUM ('profile_summary', 'experience', 'projects', 'skills',
                                          'education', 'certifications');

-- Bulk imports (zip of ≤ 500 files). Entry names are not stored: file names often carry names.
CREATE TABLE parse_batches (
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('accepted', 'importing', 'imported', 'failed')),
  total         int NOT NULL CHECK (total BETWEEN 0 AND 500),
  created_by    text NOT NULL,
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id),
  UNIQUE (tenant_id, batch_id)
);

CREATE TABLE parse_batch_items (
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  item_index    int NOT NULL CHECK (item_index BETWEEN 0 AND 499),
  extension     text NOT NULL,
  byte_size     int NOT NULL CHECK (byte_size >= 0),
  status        text NOT NULL CHECK (status IN ('pending', 'submitted', 'skipped', 'failed')),
  candidate_id  uuid,                 -- placeholder candidate created for this file
  document_id   uuid,
  error_code    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, item_index),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES parse_batches (tenant_id, batch_id) ON DELETE CASCADE
);
CREATE INDEX ix_batch_items_candidate ON parse_batch_items (tenant_id, candidate_id);

-- One row per parse attempt of a document (a re-parse is a new job).
CREATE TABLE parse_jobs (
  tenant_id        uuid NOT NULL,
  job_id           uuid NOT NULL,
  document_id      uuid NOT NULL,
  candidate_id     uuid NOT NULL,
  storage_key      text NOT NULL,
  mime_type        text NOT NULL,
  byte_size        int NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  origin           text NOT NULL CHECK (origin IN ('event', 'api', 'bulk')),
  batch_id         uuid,
  idempotency_key  text CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status           parse_job_status NOT NULL DEFAULT 'queued',
  stage            text,
  progress         smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts         int NOT NULL DEFAULT 0,
  parser_version   text NOT NULL,
  error_code       text,
  flags            text[] NOT NULL DEFAULT '{}',
  result           jsonb,              -- metrics only (counts, dropped fields); never content
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES parse_batches (tenant_id, batch_id) ON DELETE SET NULL (batch_id)
);
-- At most one live job per document; retries and duplicate events reuse it.
CREATE UNIQUE INDEX ux_parse_jobs_live ON parse_jobs (tenant_id, document_id)
  WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX ux_parse_jobs_idem ON parse_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_parse_jobs_queue ON parse_jobs (created_at) WHERE status = 'queued';
CREATE INDEX ix_parse_jobs_candidate ON parse_jobs (tenant_id, candidate_id);

-- Résumé chunk embeddings (PRD §3). The exact text embedded is stored, PII-free, so a model
-- upgrade re-embeds without re-parsing. Never mix model_id values in one query.
CREATE TABLE resume_embeddings (
  tenant_id          uuid NOT NULL,
  embedding_id       bigint GENERATED ALWAYS AS IDENTITY,
  candidate_id       uuid NOT NULL,
  document_id        uuid,
  chunk_type         embedding_chunk_type NOT NULL,
  chunk_index        smallint NOT NULL DEFAULT 0,
  content_redacted   text NOT NULL CHECK (length(content_redacted) <= 8000),
  token_count        int NOT NULL,
  model_id           text NOT NULL,
  embedding          vector(1024) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (embedding_id),
  UNIQUE (tenant_id, candidate_id, model_id, chunk_type, chunk_index)
);
-- m=16 / ef_construction=64: ~0.97 recall@10 at ef_search=100 on 1024-d bge-m3 vectors.
CREATE INDEX ix_resume_emb_hnsw ON resume_embeddings
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX ix_resume_emb_candidate ON resume_embeddings (tenant_id, candidate_id, model_id);

-- Which embedding model serves queries ('active') and which one is being back-filled
-- ('shadow'). Platform-level; changed only by platform staff (blue/green swap).
CREATE TABLE embedding_model_slots (
  slot        text PRIMARY KEY CHECK (slot IN ('active', 'shadow')),
  model_id    text CHECK (slot = 'shadow' OR model_id IS NOT NULL),
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parse_batches', 'parse_batch_items', 'resume_embeddings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The fair-share dispatcher reads the queue across tenants inside a system transaction;
-- everything else is tenant-scoped.
ALTER TABLE parse_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE parse_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parse_jobs
  USING (tenant_id = current_tenant_id() OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id = current_tenant_id() OR current_setting('app.system', true) = 'on');

-- Chunks are replaced (delete + insert), never edited.
REVOKE UPDATE ON resume_embeddings FROM atlas_app;
INSERT INTO embedding_model_slots (slot, model_id, updated_by)
VALUES ('active', 'bge-m3', 'migration'), ('shadow', NULL, 'migration');
REVOKE INSERT, DELETE ON embedding_model_slots FROM atlas_app;

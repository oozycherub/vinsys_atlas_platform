-- 0006_taxonomy: owned by taxonomy-svc (docs/prompts/03-taxonomy-svc.md §3).
--
-- Global and tenant rows share tables: tenant_id IS NULL marks the global taxonomy.
-- Mixed-scope RLS: a tenant reads global rows plus its own and writes only its own; global rows
-- are written only in a system transaction (the super_admin curator path, app.system = 'on').
-- No foreign key to tenants: that table belongs to tenant-svc; purge arrives as an event.

CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE skill_node_type      AS ENUM ('domain', 'subdomain', 'cluster', 'skill');
CREATE TYPE skill_classification AS ENUM ('technical', 'functional', 'soft', 'tool', 'ai', 'emerging', 'unclassified');
CREATE TYPE skill_edge_type      AS ENUM ('RELATED_TO', 'PREREQUISITE_OF', 'REPLACES');

CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;

-- Read: global + own tenant. Write: own tenant, or global only in a system transaction.
CREATE OR REPLACE FUNCTION scope_readable(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT row_tenant IS NULL OR row_tenant = current_tenant_id() OR app_is_system() $$;
CREATE OR REPLACE FUNCTION scope_writable(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (row_tenant IS NOT NULL AND row_tenant = current_tenant_id()) OR (row_tenant IS NULL AND app_is_system())
$$;

CREATE TABLE skills (
  skill_id          uuid PRIMARY KEY,
  tenant_id         uuid,                                  -- NULL = global taxonomy
  node_type         skill_node_type NOT NULL,
  path              ltree NOT NULL,                        -- 'finance.corporate_banking.credit.cash_flow_analysis'
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description       text CHECK (length(description) <= 2000),
  classification    skill_classification NOT NULL DEFAULT 'unclassified',
  aliases           text[] NOT NULL DEFAULT '{}',
  search_keys       text[] NOT NULL,                       -- normalised name + aliases (alias lookup)
  external_id       text CHECK (length(external_id) <= 200),
  embedding         vector(1024),                          -- "name: description"
  embedding_model   text,
  taxonomy_version  int NOT NULL DEFAULT 1 CHECK (taxonomy_version >= 1),
  deprecated_at     timestamptz,
  replaced_by       uuid REFERENCES skills (skill_id),
  version           int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Domain → subdomain → cluster → skill: depth is fixed by node type.
  CHECK (nlevel(path) = CASE node_type WHEN 'domain' THEN 1 WHEN 'subdomain' THEN 2 WHEN 'cluster' THEN 3 ELSE 4 END),
  CHECK (replaced_by IS NULL OR deprecated_at IS NOT NULL),
  CHECK (replaced_by IS DISTINCT FROM skill_id),
  CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);
CREATE UNIQUE INDEX ux_skills_path ON skills (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), path);
CREATE INDEX ix_skills_path_gist ON skills USING gist (path);
CREATE INDEX ix_skills_search_keys ON skills USING gin (search_keys);
CREATE INDEX ix_skills_name_trgm ON skills USING gin (lower(name) gin_trgm_ops);
CREATE INDEX ix_skills_tenant ON skills (tenant_id) WHERE tenant_id IS NOT NULL;
-- ANN only over active leaf skills (PRD §3); the normalise query repeats this predicate.
CREATE INDEX ix_skills_embedding_hnsw ON skills USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE node_type = 'skill' AND deprecated_at IS NULL;
CREATE TRIGGER trg_skills_updated BEFORE UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE skill_edges (
  tenant_id   uuid,                                        -- NULL = global edge (between global skills)
  src         uuid NOT NULL REFERENCES skills (skill_id) ON DELETE CASCADE,
  dst         uuid NOT NULL REFERENCES skills (skill_id) ON DELETE CASCADE,
  edge_type   skill_edge_type NOT NULL,
  weight      numeric(4,3) NOT NULL CHECK (weight > 0 AND weight <= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (src, dst, edge_type),
  CHECK (src <> dst),
  CHECK (edge_type <> 'RELATED_TO' OR src < dst)           -- symmetric edge stored once
);
CREATE INDEX ix_skill_edges_dst ON skill_edges (dst, edge_type);

-- Tenant overlay on a GLOBAL skill: hide it, adopt it, rename it, add aliases.
CREATE TABLE tenant_skill_overrides (
  tenant_id     uuid NOT NULL,
  skill_id      uuid NOT NULL REFERENCES skills (skill_id) ON DELETE CASCADE,
  hidden        boolean NOT NULL DEFAULT false,
  adopted       boolean NOT NULL DEFAULT false,
  display_name  text CHECK (length(display_name) BETWEEN 1 AND 200),
  aliases       text[] NOT NULL DEFAULT '{}',
  search_keys   text[] NOT NULL DEFAULT '{}',
  version       int NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, skill_id),
  CHECK (NOT (hidden AND adopted))
);
CREATE INDEX ix_overrides_search_keys ON tenant_skill_overrides USING gin (search_keys);
CREATE TRIGGER trg_overrides_updated BEFORE UPDATE ON tenant_skill_overrides FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Raw terms that matched a skill only weakly (cosine 0.70–0.82), for taxonomy admins.
CREATE TABLE unmapped_skill_suggestions (
  tenant_id         uuid NOT NULL,
  term              text NOT NULL CHECK (length(term) BETWEEN 1 AND 200),
  best_skill_id     uuid REFERENCES skills (skill_id) ON DELETE SET NULL,
  best_score        numeric(4,3),
  occurrences       int NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, term)
);

-- Published taxonomy version per scope (global uses the zero UUID as its key).
CREATE TABLE taxonomy_versions (
  scope_key          uuid PRIMARY KEY,
  tenant_id          uuid GENERATED ALWAYS AS (NULLIF(scope_key, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  published_version  int NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  published_at       timestamptz,
  published_by       text
);

CREATE TABLE taxonomy_import_batches (
  batch_id          uuid PRIMARY KEY,
  tenant_id         uuid,                                  -- NULL = global import (curator)
  status            text NOT NULL CHECK (status IN ('dry_run', 'committed', 'failed')),
  file_name         text NOT NULL CHECK (length(file_name) <= 255),
  row_count         int NOT NULL CHECK (row_count >= 0),
  summary           jsonb NOT NULL,                        -- {create, update, unchanged, error}
  plan              jsonb NOT NULL,                        -- per-row action + resolved values
  base_fingerprint  text NOT NULL,                         -- taxonomy state the dry run saw
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  committed_at      timestamptz
);

CREATE TABLE job_families (
  tenant_id      uuid NOT NULL,
  job_family_id  uuid NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_family_id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE job_roles (
  tenant_id      uuid NOT NULL,
  job_role_id    uuid NOT NULL,
  job_family_id  uuid NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  level          text CHECK (length(level) <= 50),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_role_id),
  UNIQUE (tenant_id, job_family_id, name),
  FOREIGN KEY (tenant_id, job_family_id) REFERENCES job_families (tenant_id, job_family_id)
);

CREATE TABLE job_profiles (
  tenant_id       uuid NOT NULL,
  job_profile_id  uuid NOT NULL,
  job_role_id     uuid,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description     text CHECK (length(description) <= 10000),
  status          text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  version         int NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_profile_id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, job_role_id)
);
CREATE INDEX ix_job_profiles_created ON job_profiles (tenant_id, created_at DESC, job_profile_id DESC);
CREATE TRIGGER trg_job_profiles_updated BEFORE UPDATE ON job_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE job_profile_skills (
  tenant_id           uuid NOT NULL,
  job_profile_id      uuid NOT NULL,
  skill_id            uuid NOT NULL REFERENCES skills (skill_id),
  weight              numeric(5,4) NOT NULL CHECK (weight > 0 AND weight <= 1),
  target_proficiency  numeric(2,1) NOT NULL CHECK (target_proficiency BETWEEN 0 AND 5 AND target_proficiency * 2 = trunc(target_proficiency * 2)),
  must_have           boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, job_profile_id, skill_id),
  FOREIGN KEY (tenant_id, job_profile_id) REFERENCES job_profiles (tenant_id, job_profile_id) ON DELETE CASCADE
);
CREATE INDEX ix_job_profile_skills_skill ON job_profile_skills (skill_id);

-- Mixed-scope tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skills', 'skill_edges', 'taxonomy_versions', 'taxonomy_import_batches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope_read ON %I FOR SELECT USING (scope_readable(tenant_id))', t);
    EXECUTE format('CREATE POLICY scope_insert ON %I FOR INSERT WITH CHECK (scope_writable(tenant_id))', t);
    EXECUTE format('CREATE POLICY scope_update ON %I FOR UPDATE USING (scope_writable(tenant_id)) WITH CHECK (scope_writable(tenant_id))', t);
    EXECUTE format('CREATE POLICY scope_delete ON %I FOR DELETE USING (scope_writable(tenant_id))', t);
  END LOOP;
  -- Tenant-only tables.
  FOREACH t IN ARRAY ARRAY['tenant_skill_overrides', 'unmapped_skill_suggestions', 'job_families', 'job_roles', 'job_profiles', 'job_profile_skills'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

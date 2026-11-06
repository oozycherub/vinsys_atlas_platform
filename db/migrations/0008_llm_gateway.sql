-- 0008_llm_gateway: owned by llm-gateway (docs/prompts/05-llm-gateway.md §3).
-- prompt_templates is platform-level (prompts belong to the calling services, not to tenants);
-- calls and budgets are tenant-owned with strict RLS.

-- Versioned prompt registry: a (prompt_id, version) is immutable once registered.
CREATE TABLE prompt_templates (
  prompt_id                text NOT NULL CHECK (prompt_id ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  version                  int NOT NULL CHECK (version >= 1),
  purpose                  text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{2,60}$'),
  route                    text NOT NULL CHECK (route IN ('primary', 'fast', 'eval')),
  system_template          text NOT NULL CHECK (length(system_template) <= 50000),
  user_template            text NOT NULL CHECK (length(user_template) <= 50000),
  variables                jsonb NOT NULL,      -- {name: {"untrusted": bool, "required": bool}}
  output_schema            jsonb,               -- JSON Schema for structured output, or NULL for text
  contains_candidate_text  boolean NOT NULL,    -- redaction mandatory (fail closed)
  reidentify_fields        text[] NOT NULL DEFAULT '{}',  -- JSON Pointers allowed back in clear
  effort                   text NOT NULL DEFAULT 'medium' CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  max_tokens               int NOT NULL CHECK (max_tokens BETWEEN 1 AND 64000),
  deterministic            boolean NOT NULL DEFAULT false, -- eligible for the response cache
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  registered_by            text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (prompt_id, version)
);
-- Immutable content: the app may only retire a version.
REVOKE UPDATE, DELETE ON prompt_templates FROM atlas_app;
GRANT UPDATE (status) ON prompt_templates TO atlas_app;

-- Monthly limits per tenant (set by platform staff), and the running usage per month.
CREATE TABLE tenant_ai_budget_settings (
  tenant_id            uuid PRIMARY KEY,
  monthly_tokens       bigint NOT NULL CHECK (monthly_tokens >= 0),
  monthly_gpu_seconds  numeric(12,3) NOT NULL CHECK (monthly_gpu_seconds >= 0),
  soft_ratio           numeric(4,3) NOT NULL DEFAULT 0.8 CHECK (soft_ratio > 0 AND soft_ratio < 1),
  updated_by           text NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_ai_budgets (
  tenant_id          uuid NOT NULL,
  period             char(7) NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),   -- 'YYYY-MM' (UTC)
  tokens_used        bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  gpu_seconds_used   numeric(14,3) NOT NULL DEFAULT 0 CHECK (gpu_seconds_used >= 0),
  soft_alerted_at    timestamptz,                -- threshold_crossed emitted once per level and month
  hard_alerted_at    timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

-- Evaluation log: redacted input and output, model, attempts (with failover), tokens, latency.
-- Never raw PII. Partitioned by month; the app role reaches partitions only through the parent.
CREATE TABLE llm_calls (
  tenant_id         uuid NOT NULL,
  call_id           uuid NOT NULL,
  created_at        timestamptz NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('messages', 'stream', 'embeddings')),
  purpose           text NOT NULL,
  prompt_id         text,
  prompt_version    int,
  route             text,
  model             text,
  provider          text,
  status            text NOT NULL CHECK (status IN ('ok', 'cache_hit', 'refused', 'schema_violation',
                                                    'provider_unavailable', 'budget_exceeded', 'redaction_failed')),
  error_code        text,
  attempts          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{provider, model, outcome, latency_ms}]
  input_redacted    jsonb,
  output_redacted   jsonb,
  input_tokens      int NOT NULL DEFAULT 0,
  output_tokens     int NOT NULL DEFAULT 0,
  latency_ms        int NOT NULL DEFAULT 0,
  overhead_ms       int NOT NULL DEFAULT 0,
  injection_scores  jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, created_at, call_id)
) PARTITION BY RANGE (created_at);

CREATE TABLE llm_calls_default PARTITION OF llm_calls DEFAULT;

-- Monthly partitions from 2026-01 through 2028-12. Later months land in the default partition
-- until the partition-maintenance job (run as the owner) adds them; see the service README.
DO $$
DECLARE
  m date := date '2026-01-01';
  name text;
BEGIN
  WHILE m < date '2029-01-01' LOOP
    name := format('llm_calls_%s', to_char(m, 'YYYY_MM'));
    EXECUTE format('CREATE TABLE %I PARTITION OF llm_calls FOR VALUES FROM (%L) TO (%L)',
                   name, m, (m + interval '1 month')::date);
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

CREATE INDEX ix_llm_calls_tenant_purpose ON llm_calls (tenant_id, purpose, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_ai_budget_settings', 'tenant_ai_budgets', 'llm_calls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
  -- Partitions: no direct access for the app role (policies apply through the parent only).
  FOR t IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'llm_calls'::regclass LOOP
    EXECUTE format('REVOKE ALL ON %I FROM atlas_app', t);
  END LOOP;
END $$;

-- The log is append-only for the app (DELETE stays: tenant purge removes a tenant's rows).
REVOKE UPDATE ON llm_calls FROM atlas_app;

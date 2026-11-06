-- Brick 13: notification-svc and report-svc (docs/prompts/13-notification-report.md, ADR-0010).
-- 0016 was taken; both services' tables are here. Queues are claimed across tenants by the
-- workers (system context, FOR UPDATE SKIP LOCKED) and processed inside each tenant's context.

-- =============================================================================================
-- notification-svc
-- =============================================================================================

-- Who can be notified: users (from identity events and the internal endpoint), never candidates.
CREATE TABLE notification_recipients (
  tenant_id      uuid NOT NULL,
  user_id        text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  email          text CHECK (email IS NULL OR length(email) <= 320),
  display_name   text CHECK (display_name IS NULL OR length(display_name) <= 200),
  roles          text[] NOT NULL DEFAULT '{}',
  tags           text[] NOT NULL DEFAULT '{}',
  locale         text NOT NULL DEFAULT 'en' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  time_zone      text,
  active         boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX ix_notification_recipients_roles ON notification_recipients USING gin (roles);

-- Tenant-wide delivery settings: quiet hours (local minutes from midnight), daily cap, sender.
CREATE TABLE notification_settings (
  tenant_id          uuid PRIMARY KEY,
  quiet_start_min    int CHECK (quiet_start_min BETWEEN 0 AND 1439),
  quiet_end_min      int CHECK (quiet_end_min BETWEEN 0 AND 1439),
  time_zone          text NOT NULL DEFAULT 'UTC',
  max_per_day        int NOT NULL DEFAULT 5 CHECK (max_per_day BETWEEN 1 AND 100),
  from_name          text CHECK (from_name IS NULL OR length(from_name) <= 100),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((quiet_start_min IS NULL) = (quiet_end_min IS NULL))
);

CREATE TABLE notification_templates (
  tenant_id      uuid NOT NULL,
  template_id    uuid NOT NULL,
  type           text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email', 'in_app')),
  locale         text NOT NULL DEFAULT 'en',
  subject        text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  source         text NOT NULL CHECK (length(source) <= 100000),
  version        int NOT NULL DEFAULT 1,
  updated_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, template_id),
  UNIQUE (tenant_id, type, channel, locale)
);

-- Per-type toggles: user_id '*' is the tenant row; other rows are a user's own opt-outs.
CREATE TABLE notification_preferences (
  tenant_id      uuid NOT NULL,
  type           text NOT NULL,
  user_id        text NOT NULL DEFAULT '*',
  enabled        boolean NOT NULL DEFAULT true,
  email          boolean NOT NULL DEFAULT true,
  in_app         boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, type, user_id)
);

-- The outbox of sends. In-app rows are the inbox (`read_at`). `link_url` is a bearer secret,
-- kept only until the send finishes or the link expires.
CREATE TABLE notifications (
  tenant_id            uuid NOT NULL,
  notification_id      uuid NOT NULL,
  type                 text NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('email', 'in_app')),
  recipient_user_id    text,
  to_email             text,
  subject_id           uuid,          -- the candidate an internal message is about (erasure)
  data                 jsonb NOT NULL DEFAULT '{}',
  link_url             text,
  link_expires_at      timestamptz,
  transactional        boolean NOT NULL DEFAULT false,
  status               text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  attempts             int NOT NULL DEFAULT 0,
  available_at         timestamptz NOT NULL DEFAULT now(),
  dedupe_key           text NOT NULL,
  provider_message_id  text,
  last_error           text,
  sent_at              timestamptz,
  read_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, notification_id),
  UNIQUE (tenant_id, dedupe_key),
  CHECK (channel = 'email' OR (recipient_user_id IS NOT NULL AND link_url IS NULL)),
  CHECK (channel = 'in_app' OR to_email IS NOT NULL OR recipient_user_id IS NOT NULL)
);
CREATE INDEX ix_notifications_queue ON notifications (available_at) WHERE status = 'queued';
CREATE INDEX ix_notifications_inbox ON notifications (tenant_id, recipient_user_id, created_at DESC)
  WHERE channel = 'in_app';
CREATE INDEX ix_notifications_subject ON notifications (tenant_id, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX ix_notifications_cap ON notifications (tenant_id, recipient_user_id, sent_at)
  WHERE channel = 'email' AND NOT transactional;

CREATE TABLE notification_reminders (
  tenant_id          uuid NOT NULL,
  reminder_id        uuid NOT NULL,
  type               text NOT NULL CHECK (type IN ('self_rating_reminder', 'manager_rating_reminder')),
  recipient_user_id  text NOT NULL,
  due_at             timestamptz NOT NULL,
  data               jsonb NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled')),
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reminder_id)
);
CREATE INDEX ix_notification_reminders_due ON notification_reminders (due_at) WHERE status = 'scheduled';

CREATE TABLE sending_domains (
  tenant_id            uuid NOT NULL,
  domain_id            uuid NOT NULL,
  domain               text NOT NULL CHECK (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  verification_token   text NOT NULL,
  dkim_selector        text NOT NULL,
  spf_verified         boolean NOT NULL DEFAULT false,
  dkim_verified        boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  checked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain_id),
  UNIQUE (tenant_id, domain)
);

CREATE TABLE webhook_endpoints (
  tenant_id              uuid NOT NULL,
  endpoint_id            uuid NOT NULL,
  url                    text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2000),
  description            text CHECK (description IS NULL OR length(description) <= 500),
  event_types            text[] NOT NULL CHECK (cardinality(event_types) >= 1),
  secret_sealed          bytea NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  consecutive_failures   int NOT NULL DEFAULT 0,
  disabled_at            timestamptz,
  disabled_reason        text,
  created_by             text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, endpoint_id)
);

CREATE TABLE webhook_deliveries (
  tenant_id       uuid NOT NULL,
  delivery_id     uuid NOT NULL,
  endpoint_id     uuid NOT NULL,
  event_type      text NOT NULL,
  event_id        uuid NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts        int NOT NULL DEFAULT 0,
  available_at    timestamptz NOT NULL DEFAULT now(),
  last_status     int,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delivery_id),
  UNIQUE (tenant_id, endpoint_id, event_id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, endpoint_id) ON DELETE CASCADE
);
CREATE INDEX ix_webhook_deliveries_queue ON webhook_deliveries (available_at) WHERE status = 'pending';

-- =============================================================================================
-- report-svc
-- =============================================================================================

CREATE TABLE report_settings (
  tenant_id    uuid PRIMARY KEY,
  sections     jsonb NOT NULL,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Read model of one assessment session, from the owners' events (ADR-0010 §6). No PII.
CREATE TABLE report_session_facts (
  tenant_id           uuid NOT NULL,
  session_id          uuid NOT NULL,
  assessment_id       uuid,
  assessment_version  int,
  candidate_id        uuid,
  attempt_no          int,
  started_at          timestamptz,
  deadline_at         timestamptz,
  submitted_at        timestamptz,
  outcome             text,
  terminated_reason   text,
  skills              jsonb,
  evaluated_at        timestamptz,
  trust_score         int,
  trust_band          text,
  trust_breakdown     jsonb,
  trust_revision      int,
  trust_review        boolean,
  interview           jsonb,
  interview_revision  int,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX ix_report_session_facts_assessment ON report_session_facts (tenant_id, assessment_id, session_id);
CREATE INDEX ix_report_session_facts_candidate ON report_session_facts (tenant_id, candidate_id);

CREATE TABLE report_jobs (
  tenant_id      uuid NOT NULL,
  report_id      uuid NOT NULL,
  type           text NOT NULL CHECK (type IN ('candidate_assessment_pdf', 'assessment_results_xlsx', 'gallery_xlsx')),
  params         jsonb NOT NULL,
  subject_id     uuid,
  requested_by   text NOT NULL,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  attempts       int NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  error          text,
  artifact_id    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  PRIMARY KEY (tenant_id, report_id)
);
CREATE INDEX ix_report_jobs_queue ON report_jobs (available_at) WHERE status IN ('queued', 'running');

CREATE TABLE report_artifacts (
  tenant_id      uuid NOT NULL,
  artifact_id    uuid NOT NULL,
  report_id      uuid NOT NULL,
  storage_key    text NOT NULL,
  content_type   text NOT NULL,
  file_name      text NOT NULL,
  size_bytes     bigint NOT NULL,
  sha256         text NOT NULL,
  subject_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, report_id) REFERENCES report_jobs (tenant_id, report_id) ON DELETE CASCADE
);

-- =============================================================================================
-- RLS
-- =============================================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_recipients', 'notification_settings', 'notification_templates',
    'notification_preferences', 'notifications', 'notification_reminders', 'sending_domains',
    'webhook_endpoints', 'webhook_deliveries', 'report_settings', 'report_session_facts', 'report_jobs',
    'report_artifacts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
  END LOOP;
  -- The workers find due work across tenants (and lease it) in the system context, then process
  -- each item in its tenant's context. The system policies apply only while NO tenant is set:
  -- event handlers run in a system transaction with a tenant context and must see that tenant only.
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_reminders', 'webhook_deliveries', 'report_jobs']
  LOOP
    EXECUTE format($p$CREATE POLICY system_queue ON %I FOR SELECT
      USING ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL))$p$, t);
    EXECUTE format($p$CREATE POLICY system_lease ON %I FOR UPDATE
      USING ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL)) WITH CHECK ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL))$p$, t);
  END LOOP;
  -- The delivery claim skips disabled endpoints.
  CREATE POLICY system_queue ON webhook_endpoints FOR SELECT USING ((current_setting('app.system', true) = 'on' AND current_tenant_id() IS NULL));
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_recipients, notification_settings, notification_templates,
  notification_preferences, notifications, notification_reminders, sending_domains, webhook_endpoints,
  webhook_deliveries, report_settings, report_session_facts, report_jobs, report_artifacts TO atlas_app;

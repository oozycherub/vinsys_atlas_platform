# Component Prompt 13: notification-svc & report-svc

## Status

**Built:** `services/notification-svc` and `services/report-svc` (TypeScript), contracts `notification.delivery.failed.v1` and `report.artifact.ready.v1`, and migration `0019_notifications_reports.sql` (0016 was taken). The decisions are in ADR-0010:

- a recipient directory fed by identity events and an internal endpoint, since events carry no addresses;
- `POST /v1/internal/messages` for people who are not users (candidates);
- per-type toggles stored in notification-svc, not read from tenant-svc;
- report-svc builds a read model from the owners' events, and fetches only names and evidence images at render time;
- signed links are report-svc's own HMAC links, the same on S3, disk and in tests.

**Verified on this machine:**

- Template injection (`{{constructor}}`, `<script>`, handlers, `javascript:`) is rejected; values are escaped.
- A webhook signature verifies with the documented algorithm (an independent HMAC in the test); old timestamps are refused.
- Retries with exponential backoff, the DLQ, redelivery, and disabling after 50 consecutive failures (admins notified).
- A disabled notification type is not sent; transactional types cannot be disabled; user opt-outs; quiet hours and the daily cap.
- Report sections follow the config: mandatory always present, proctoring images only when enabled.
- Signed links expire after 15 minutes and are bound to tenant and artifact.
- Exports stream page by page (1,203 rows).
- A real headless-Chromium render.
- Leak tests on notifications, webhooks, templates and reports.

**Not verified here:**

- email p95 < 60 s and PDF p95 < 10 s under load;
- real SES and SendGrid, and bounce handling;
- Trino against real lakehouse tables;
- proctoring-svc accepting report-svc's service token for evidence frames.

**Found while building:**

- The `system_*` RLS policies in 0017 (brick 12) applied inside event handlers too: those run in a system transaction with a tenant context, so they could read other tenants' queue rows. 0017 and 0019 now require `current_tenant_id() IS NULL` for the system policies.
- The same pattern exists in the committed migrations 0009–0015 and is not changed here.

## 1. Context

- PRD §1.3 (consumers of most topics), §4.2 (audit, retention).
- Feature inventory: notification settings, email templates with placeholders, PDF report configuration, report gallery.
- Brick 13 (TypeScript). Depends on assessment and proctoring; consumes from everything.

## 2. Scope

**notification-svc**

- Channels: email (SES/SendGrid adapter), in-app (SSE feed), webhooks (HMAC-signed, retries with exponential backoff, DLQ).
- Tenant templates with placeholders such as `{Employee_Name}` and `{URL}`, sanitised and rendered from the MJML source.
- Per-event toggles from tenant settings.
- Scheduled reminders (self-rating, manager rating), with quiet hours and a per-recipient rate limit.
- Custom sending domain (DKIM/SPF verification state).

**report-svc**

- Candidate assessment PDF with configurable sections (PRD feature inventory §3.2 Report Settings). Rendered with a headless Chromium worker pool from HTML templates.
- Signed short-lived links.
- Excel exports.
- Skills-intelligence report gallery backed by the lakehouse (Trino).

## 3. Owned data

Migration `0019_notifications_reports.sql` (0016 was taken): `notification_templates`, `notification_preferences`, `notifications` (outbox of sends with status), `webhook_endpoints`, `webhook_deliveries`, `report_jobs`, `report_artifacts`.

## 4. API contract

- `/v1/notification-templates` (CRUD and preview)
- `/v1/webhook-endpoints` (CRUD, plus a `:test` call)
- `GET /v1/me/notifications`
- `POST /v1/reports {type, params}` returns 202 with a job
- `GET /v1/reports/{id}` returns a signed URL valid for 15 min

**Internal endpoint used by identity-svc (already called by its `NotificationLinkDelivery`):**

`POST /v1/internal/link-messages`. Role `service` with scope `notifications:send`; requires `Idempotency-Key` (identity reuses one key across retries). Body:

```json
{
  "kind": "invitation | magic_link",
  "tenant_id": "uuid",
  "email": "ada@corp.test",
  "url": "https://…",
  "expires_at": "ISO-8601"
}
```

Returns 202. The `url` is a bearer secret: never log it or put it in events. Use the tenant's template for `kind`.

## 5. Events

- **Consumed:** identity invitations, assessment session lifecycle, proctoring finalised, interview completed, intel alerts.
- **Produced:** `notification.delivery.failed.v1`, `report.artifact.ready.v1`.

## 6. Domain rules

- **Templates:** an allowlist of placeholders per template type. Unknown placeholders fail validation. Autoescape is on.
- **Webhooks:** signature `t=<ts>,v1=<HMAC-SHA256>`; receivers must reject requests more than 5 min old. Disable after 50 consecutive failures, and notify the tenant admin.
- **Reports** never embed proctoring images unless that section is enabled. Mandatory sections are always present.

## 7. Non-functional

- Email enqueue-to-send p95 < 60 s.
- PDF generation p95 < 10 s.
- Exports stream (no full in-memory build).

## 8. Acceptance tests

- Template injection (`{{constructor}}`, `<script>`) is escaped or rejected.
- A webhook signature is verifiable with the documented algorithm.
- Retry and DLQ.
- A disabled notification type is not sent.
- Report sections follow config.
- Leak test on notifications.

## 9. Deliverables

Two services per the master layout, plus HTML report templates and contracts.

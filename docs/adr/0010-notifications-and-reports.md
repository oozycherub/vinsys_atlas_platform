# ADR-0010: Notifications and reports: recipient directory, queues in Postgres, signed artifact links

- Status: Accepted
- Date: 2026-11-06

## Context

Component Prompt 13 adds two consumers of nearly every topic: notification-svc (email, in-app, webhooks, reminders) and report-svc (candidate PDFs, Excel exports, a lakehouse gallery). Several things are not settled by the prompt:

- **Recipients.** Events carry ids, never PII (profile-events, identity-events). Only `identity.user.invited.v1` carries an email; candidates' emails are on no event at all.
- **Per-event toggles "from tenant settings".** tenant-svc's `settings_updated` event carries only the changed keys, not values.
- **Report data.** A candidate report joins assessment results, skill scores, the Trust Score and the AI-interview summary, owned by four services.
- **Signed links.** Artifacts must be downloadable through a link valid for 15 minutes, whatever the object store.

## Decision

1. **notification-svc keeps a recipient directory** (`notification_recipients`), keyed by user id:
   - fed by `identity.user.invited.v1` (email, roles), `identity.user.roles_changed.v1` and `identity.user.deactivated.v1`;
   - and by `PUT /v1/internal/recipients/{user_id}` (scope `notifications:send`) for anything else, such as an HRBP tag, a locale or a time zone.
     Event-driven notifications go to users only. Messages to people who are not users (a candidate's assessment invitation) are sent by their owning service through `POST /v1/internal/messages`, which carries the address, as identity-svc already does through `POST /v1/internal/link-messages`.
2. **Toggles live in notification-svc** (`notification_preferences`): a tenant row per type (enabled, email, in-app) and optional per-user opt-outs. Transactional types (invitation, magic link, report ready, webhook disabled) cannot be turned off. This is the "notification settings" screen of the admin portal; it is not read from tenant-svc.
3. **One outbox table of sends** (`notifications`), worked by a leased queue (`FOR UPDATE SKIP LOCKED`, lease 2 min, exponential backoff, 6 attempts, then `failed` and `notification.delivery.failed.v1`). In-app notifications are rows in the same table with `channel = 'in_app'`; the SSE feed reads them.
   - A link's URL is a bearer secret: it is stored only until the send succeeds or the link expires, then nulled. It is never logged and never put on an event.
   - Reminders (`notification_reminders`) become notifications when due. Quiet hours (the recipient's time zone, else the tenant's) and the per-recipient daily cap defer non-transactional email; they never drop it.
4. **Templates are MJML with an allowlist of `{Placeholder}` names per type.** Unknown names, double braces and `<script>`, event-handler attributes or `javascript:` URLs are rejected at save time. Values are HTML-escaped when substituted, and the rendered HTML is sanitised again before sending. `{URL}` accepts only `https:` values and only inside `href`.
5. **Webhooks.** Each tenant endpoint has a secret (sealed with the service's key-encryption key, shown once). Deliveries are signed `Atlas-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`; receivers reject timestamps older than 5 minutes. Failures retry with exponential backoff (1 min doubling, 8 attempts) and then stay as `dead` (the DLQ, redeliverable). After 50 consecutive failed attempts the endpoint is disabled and the tenant admins are notified. Only `https:` URLs to public addresses are accepted (DNS is checked at delivery too, against rebinding).
6. **report-svc builds a read model from events** (`report_session_facts`): session lifecycle, skill scores, the latest Trust Score revision and the latest interview revision. Rendering never calls the four owners. The candidate's display name and flagged proctoring frames are fetched at render time (ports), because they are PII and stay with their owners.
7. **Signed links are report-svc's own.** `GET /v1/reports/{id}` returns `…/report-artifacts/{id}:download?exp=…&sig=…`, an HMAC over tenant, artifact and expiry (15 min), served by report-svc streaming from the object store. This works the same on S3, on disk and in tests; the link carries no token.
8. **Exports stream.** Excel files are written with ExcelJS's streaming writer, fed by keyset-paginated queries (or Trino result pages for the gallery) and piped into the object store; the service never holds a whole workbook.
9. **PDFs** are rendered from HTML templates by headless Chromium (`playwright-core`), a small browser pool with one page per job. The HTML has no scripts, and images are inlined as data URLs.
10. **Migration `0019_notifications_reports.sql`** (0016 was taken), both services' tables.

## Consequences

- Users invited before notification-svc existed have no email in the directory until identity re-sends or the internal endpoint is called; event-driven email to them is skipped (in-app still works).
- The Trino gallery queries are fixed definitions with bound parameters; a tenant cannot run free SQL.
- Quiet hours delay reminders, so a reminder's "due" time is a lower bound.

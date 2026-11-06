# notification-svc (brick 13)

Email, in-app and webhook notifications for every other service: tenant templates, per-type toggles, reminders with quiet hours, verified sending domains, and signed webhooks with retries and a dead-letter queue.

Spec: [`docs/prompts/13-notification-report.md`](../../docs/prompts/13-notification-report.md) · Decisions: [ADR-0010](../../docs/adr/0010-notifications-and-reports.md) · API: [`openapi.yaml`](openapi.yaml) · Port 8093

## How a notification travels

1. **In.** An event (assessment submitted, Trust Score needing review, AI interview needing review, attrition alert, report ready) or an internal call:
   - identity-svc's `POST /v1/internal/link-messages`;
   - `POST /v1/internal/messages` for people who are not users.
2. **Who.** Recipients come from a directory fed by identity events (`identity.user.invited.v1` carries the email) and by `PUT /v1/internal/recipients/{user_id}` (HRBP tags, time zone, display name). Event-driven messages go to users only; candidates are reached through their owning service.
3. **Whether.** The tenant's toggles, then the user's own opt-outs. Transactional types (invitation, magic link, report ready, webhook disabled) cannot be switched off.
4. **The outbox.**
   - In-app rows are complete on insert and wake the user's SSE streams.
   - Email rows wait for the worker, which:
     - applies quiet hours (the recipient's time zone, else the tenant's) and the daily cap: non-transactional email is deferred, never dropped;
     - renders the template;
     - sends through SES or SendGrid;
     - retries transient errors (1 min doubling, 6 attempts). After that, or on a permanent refusal, it emits `notification.delivery.failed.v1`.
5. **Secrets.** A link's URL is a bearer secret. It is kept only until the send finishes or the link expires, and it is never logged, put on an event or stored in the idempotency record.

## Templates

- **Format.** MJML for email, plain text for in-app, with `{Placeholder}` names from the type's allowlist (`GET /v1/notification-types`).
- **Rejected at save time:**
  - unknown names and `{{…}}`;
  - `<script>`, frames, forms, `on…=` attributes and `javascript:` URLs;
  - `{URL}` anywhere but a whole `href`;
  - invalid MJML.
- **Rendering.** Values are HTML-escaped in one pass, and the rendered HTML is checked again before sending.

## Webhooks

```
Atlas-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

- **Verifying.** Receivers recompute the signature over the raw body, compare in constant time and reject timestamps more than 5 minutes off.
- **Retries and the DLQ.** Deliveries retry at 1 min, doubling, for 8 attempts, then become `dead`: the DLQ, listable and redeliverable.
- **Disabling.** After 50 consecutive failed attempts the endpoint is disabled and the tenant admins are notified. `:enable` resumes it.
- **Addresses.** Only `https:` URLs on public addresses are accepted, checked again at each delivery.

## Running

```bash
npm run build && node services/notification-svc/dist/main.js
```

Environment:

- `ATLAS_DATABASE_URL`, `ATLAS_AUTH_*`;
- `ATLAS_EMAIL_PROVIDER` (`ses` | `sendgrid` | `log`), `ATLAS_SES_REGION` or `ATLAS_SENDGRID_API_KEY`, `ATLAS_EMAIL_DEFAULT_FROM`;
- `ATLAS_NOTIFICATION_SECRET_KEY` (32 bytes, base64: seals webhook secrets);
- `ATLAS_NOTIFICATION_EVENT_SOURCE=kafka`, `ATLAS_KAFKA_BROKERS`.

## Tests

81 tests (30 acceptance, 51 unit), about 98% line coverage. All 21 seeded mutations are caught (32 across brick 13).

**Acceptance** (real HTTP, real consumer, Postgres as the RLS-bound role):

- the identity link contract: scope, idempotent retries, the URL forgotten after sending, link expiry;
- template injection;
- the signature verified with the documented algorithm;
- retry, the DLQ and redelivery; disabling at 50 failures;
- disabled types not sent; opt-outs; quiet hours and the cap across time zones;
- SSE;
- sending domains;
- leak tests;
- erasure and purge.

**Unit:** the SSRF guard, the SES and SendGrid adapters, config.

## Gaps

- Not measured: email enqueue-to-send p95 < 60 s.
- SES and SendGrid were exercised against mocks, not the real providers. Bounce and complaint feedback (SNS, event webhooks) is not consumed yet.
- The DNS re-check at delivery narrows, but does not close, a DNS-rebinding window between lookup and connect.

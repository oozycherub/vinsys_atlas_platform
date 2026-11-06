# report-svc (brick 13)

Candidate assessment PDFs, streaming Excel exports, and the skills-intelligence report gallery over the lakehouse.

Spec: [`docs/prompts/13-notification-report.md`](../../docs/prompts/13-notification-report.md) · Decisions: [ADR-0010](../../docs/adr/0010-notifications-and-reports.md) · API: [`openapi.yaml`](openapi.yaml) · Port 8094

## How it works

- **Read model.** `report_session_facts` is built from the owners' events:
  - session started, submitted and terminated;
  - `assessment.session.evaluated.v1` skill scores;
  - the newest Trust Score revision;
  - the AI-interview summary.
    Rendering never calls the four owners. Names (candidate, skills) and flagged proctoring frames are PII and are fetched at render time from profile-svc, taxonomy-svc and proctoring-svc.
- **Jobs.** `POST /v1/reports` queues a job (202). A worker leases jobs across tenants, renders outside any transaction, stores the file and emits `report.artifact.ready.v1` (notification-svc tells the requester). Failures retry 3 times.
- **PDFs.** HTML templates (`src/templates/`) are printed by headless Chromium (`playwright-core`): a browser pool, one page per job, JavaScript off, every network request refused, images inlined.
- **Sections.**
  - Summary and skill scores are mandatory.
  - Integrity, AI interview and proctoring evidence are tenant settings; evidence is off by default.
  - A request can narrow the optional sections, never add one the tenant switched off.
  - Evidence frames are fetched only when their section is on.
- **Excel.** ExcelJS's streaming writer is fed by keyset pages of 500 (exports) or Trino result pages (gallery) and piped into S3 multipart or disk. No whole workbook is held in memory.
- **Gallery.** Fixed queries (`src/domain/gallery.ts`) bound through Trino's `EXECUTE IMMEDIATE … USING`. The tenant comes from the token, and only declared date parameters are accepted.
- **Signed links.** `GET /v1/reports/{id}` returns `…/report-artifacts/{id}:download?tenant_id&exp&sig`: an HMAC over tenant, artifact and expiry, valid for 15 minutes. The link is the credential.

## Running

```bash
npm run build && node services/report-svc/dist/main.js
```

Environment:

- `ATLAS_REPORT_PUBLIC_URL`, `ATLAS_REPORT_LINK_KEY` (32 bytes, base64);
- storage: `ATLAS_REPORT_STORAGE` (`s3` | `fs`), `ATLAS_REPORT_S3_*`;
- `ATLAS_CHROMIUM_PATH` (optional), `ATLAS_TRINO_URL`;
- service credentials and the profile, taxonomy and proctoring URLs;
- `ATLAS_REPORT_EVENT_SOURCE=kafka`.

Chromium for development: `npx playwright@1.65.0 install chromium-headless-shell`.

## Tests

32 tests (13 acceptance, 19 unit). All 11 seeded mutations are caught (32 across brick 13).

**Acceptance:**

- sections follow the config (mandatory sections stay, evidence only when enabled, request narrowing);
- signed links: tampering, another tenant, over-long expiry, expiry;
- a 1,203-row export streamed and parsed back;
- gallery parameter binding;
- renderer retries and failure;
- leak tests;
- erasure (files deleted) and purge.

**Unit:** a real headless-Chromium render (three in parallel, in about 0.3 s here), the S3 and disk stores, the Trino protocol, the directory and evidence clients, config.

## Gaps

- Not measured at load: PDF p95 < 10 s.
- **proctoring-svc access.** Its timeline accepts staff roles only. The evidence section needs proctoring-svc to accept report-svc's service token (scope `proctoring:evidence:read`), which is not built.
- **Retention.** Artifacts are unreachable after retention (30 days by default) but are deleted by a bucket lifecycle rule, not by the service.
- The lakehouse tables named in the gallery queries are assumed; the data pipelines that fill Trino are not built.

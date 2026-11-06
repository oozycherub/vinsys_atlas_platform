# Atlas web app (brick 14)

One Next.js 16 app (React 19, TanStack Query, Tailwind 4):

- **Admin portal:** users, skills and job profiles, the skill-gap heat map, notification and report settings.
- **Recruiter portal:** a coding-assessment builder, publish and candidate links, results with PDF reports, requisitions, the review queue.
- **Employee portal:** role fit, career paths, opportunities.
- **Candidate test runner.**

Spec: [`docs/prompts/14-gateway-and-web.md`](../../docs/prompts/14-gateway-and-web.md) · Decisions: [ADR-0011](../../docs/adr/0011-gateway-edge-and-web-app.md)

## Rules it follows

- **Only the gateway.** The app calls only the gateway, through the generated clients in [`@atlas/api-clients`](../../packages/api-clients). Locally, `/v1/*` is rewritten to `ATLAS_GATEWAY_URL`.
- **Authorisation.** The UI never authorises: token claims only choose which links to show, and every call is checked by the services.
- **CSP.** `proxy.ts` sets a nonce per request (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`). Every page renders dynamically, so the nonce applies, and no inline script runs without it. Monaco is served from `/monaco` (copied at build).
- **No PII in client logs:** the app has no client-side logging or analytics.
- **Program output** is rendered as text (`<pre>`), never as HTML.
- **Languages.** English and Arabic: `atlas_locale` sets `lang` and `dir`; layouts use logical properties (`ms-`, `ps-`, `text-start`).
- **Accessibility (WCAG 2.2 AA):**
  - a skip link, landmarks and labelled controls;
  - visible focus;
  - the timer is `role="timer"` with polite announcements at 10, 5 and 1 minutes and 30 seconds;
  - heat-map cells show values, not only colour.

## The candidate runner

1. Redeem the invite link (name and email), then the camera and microphone pre-check with consent.
2. Proctoring starts through `@atlas/proctor-sdk` when the assessment uses it.
3. **Answers** go to IndexedDB first, then to `PUT …/responses/{question}` in order, with `client_rev`.
   - **Offline:** they wait.
   - **Conflict:** the revision is refreshed and the save retried.
   - **Submit while offline:** it waits for the reconnect.
4. **Timer.** The server's remaining time, aged locally only as elapsed time; it re-syncs on every save and heartbeat.
5. **Coding** uses Monaco with a Run button.
6. **AI interview questions** open a LiveKit room (audio only, captions as text).

## Running

```bash
npm run build --workspace=@atlas/web
ATLAS_GATEWAY_URL=http://localhost:8080 npx --workspace=@atlas/web next start
```

## Tests

- **Unit** (`test/unit`, run by Vitest): the offline queue, timer, session and i18n.
- **End to end:** [`e2e/`](../../e2e).

## Gaps

- Core Web Vitals (LCP < 2.5 s, INP < 200 ms on mid-tier hardware) are not measured.
- Some portal screens are read-only views of their APIs, for example taxonomy editing and requisition matching.
- The question builder covers a single-question coding test.

# ADR-0011: The gateway as a typed edge behind Envoy; one Next.js app; e2e against a stub gateway

- Status: Accepted
- Date: 2026-11-06

## Context

Component Prompt 14 asks for an API gateway (Envoy or Kong, declarative config in `infra/gateway/`), a Next.js web app with four audiences, generated API clients, and a Playwright suite. Several details are open:

- **Gateway logic.** Tenant resolution with positive and negative caching, suspended-tenant pages, cell routing, JWT pre-validation and per-tenant limits are logic. Expressed as Envoy Lua or Kong plugins, they are hard to test without the proxy binary, which this repository's CI does not have.
- **Candidate tokens.** Candidates do not hold JWTs. assessment-svc issues `Session ast_…`, proctoring-svc `Proctor apt_…`, and interview-svc `Interview …`.
- **End-to-end runs.** The end-to-end flow crosses identity, assessment, sandbox, report and notification, and needs Kafka, Postgres, the judge and Chromium.

## Decision

1. **Envoy at the edge, a small TypeScript gateway behind it.**
   - `infra/gateway/envoy/envoy.yaml` terminates TLS. It normalises paths, rejects escaped slashes and underscore headers, strips the internal `x-atlas-*` headers, adds HSTS, and runs the OWASP CRS through the Coraza WASM filter.
   - The gateway (`@atlas/gateway`, `src/edge.ts`) makes the decisions in this order:
     - path hygiene;
     - the deny list (internal APIs never leave the cell);
     - host to slug to directory entry: cached 60 s, misses 10 s, one lookup in flight, and a stale entry served for up to 5 min while the directory is down;
     - branded 404, 403 and 503 pages, or problem documents for API calls;
     - route;
     - CORS (same workspace only);
     - JWT pre-validation: the token's tenant must be the host's tenant, and service tokens are refused at the edge;
     - a per-tenant limit by isolation tier (Redis);
     - upstream `{service}.{cell}`, streamed both ways (SSE and downloads included).
   - The services still authenticate and authorise every call.
2. **`routes.yaml` is the versioned route map**: services and ports, platform-only paths, the deny list, and routes with `public` and `session` flags. A unit test checks it against every service's `openapi.yaml`: each public path reaches its owner, and internal ones are denied. Overlaps are resolved by specificity, for example `/v1/candidates/*/matches` to matching-svc and `/v1/candidates` to profile-svc.
3. **Candidate credentials** (`Session ast_…`, `Proctor apt_…`, `Interview …`) are accepted only on routes marked `session: true` and are passed through unverified; the owning service checks them on every call.
4. **One Next.js 16 app** (`apps/web`) for the admin, recruiter and employee portals and the candidate runner.
   - It is rendered per request, so the CSP nonce from `proxy.ts` applies. No script runs without the nonce; styles may be inline, which Monaco needs.
   - The UI calls only the gateway (same origin; `/v1/*` is rewritten in development).
   - Claims are read from the token to hide affordances, never to authorise.
   - Monaco is served from our own origin.
5. **The runner is offline-first.**
   - Every answer goes to IndexedDB first, keyed by session and question, and is flushed in order.
   - A network failure stops the flush and keeps the rest. A revision conflict refreshes the revision and retries; a closed session drops the answer.
   - Submitting while offline waits for the reconnect.
   - The timer is the server's remaining time, aged by the local clock only as elapsed time.
6. **Clients are generated** (`packages/api-clients`, openapi-typescript and openapi-fetch) for the 11 public services. A drift test fails when a spec changes without regenerating.
7. **The Playwright suite runs the production build against an in-memory stub gateway** (`e2e/stub/server.mjs`) that follows the services' contracts.
   - It covers the full flow, axe-core on 13 pages, right-to-left Arabic, and the CSP nonce.
   - The real services have their own acceptance tests. A full-stack run (docker compose, Kafka, Chromium, the judge) is a separate, heavier job.

## Consequences

- Gateway behaviour is tested in-process with stubbed cells (the Prompt's contract test). The Envoy config is reviewed, not executed, here.
- intelligence-svc gained `GET /v1/employees/me` (the employee portal needs the caller's own record).
- Core Web Vitals (LCP < 2.5 s, INP < 200 ms) are not measured by this suite.

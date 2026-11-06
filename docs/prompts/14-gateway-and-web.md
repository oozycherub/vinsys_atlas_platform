# Component Prompt 14: API Gateway & Web Applications

## Status

**Built:**

- `infra/gateway`: Envoy front plus the TypeScript edge, with `routes.yaml`;
- `packages/api-clients`: generated clients for 11 services;
- `apps/web`: Next.js 16 portals and the candidate runner;
- `e2e/`: the Playwright suite against an in-memory stub gateway.

Decisions are in ADR-0011. intelligence-svc gained `GET /v1/employees/me` for the employee portal.

**Verified on this machine:**

- **Gateway, contract test with stubbed cells:**
  - unknown subdomain → 404 page; suspended → 403 page; cross-cell routing;
  - JWT tenant match; candidate tokens only on runner routes;
  - CORS, rate limits, SSE pass-through, spoofed headers dropped.
- **Gateway, route map against every service's OpenAPI:** public paths reach their owners, internal paths are denied.
- **End to end:** invite → login → create assessment → candidate completes a coding test with a network drop → recruiter sees the result and the PDF report.
- axe-core: zero serious or critical violations on 13 pages; Arabic RTL.
- A CSP nonce on every request, with no unsigned inline scripts.

**Not verified here:**

- Core Web Vitals;
- the Envoy and WAF config running;
- a full-stack end-to-end run (the API in the suite is a stub);
- LiveKit and proctoring in the browser (the stub assessment is not proctored).

## 1. Context

- PRD §1.2.2 (gateway tenant resolution), §1.3 (topology), §4.3 (accessibility, browser support).
- Feature inventory §1 (admin portal), §2 (employee portal), §3 (recruiter and test runner).
- Brick 14; consumes every API.

## 2. Scope

**Gateway (Envoy or Kong, declarative config in `infra/gateway/`)**

- TLS termination and WAF rules.
- Tenant resolution: subdomain → `tenant-directory:resolve` (cached 60 s, negative cache 10 s).
- Routing to the tenant's cell.
- JWT pre-validation with JWKS.
- Per-tenant rate limits (Redis) from tenant settings.
- Request IDs and CORS.
- Blocking requests for suspended tenants with a branded page.

**Web (Next.js, React 19, TanStack Query, Tailwind)** as an `apps/web` workspace:

- **Admin portal:** tenant settings, users, taxonomy, job profiles, analytics dashboards, notification settings.
- **Recruiter portal:** requisitions and matches, assessments builder, reports, review queues.
- **Employee portal:** skill profile, validation, career paths, marketplace, my assessments.
- **Candidate test runner:**
  - Monaco editor with IndexedDB autosave.
  - Proctoring SDK integration and pre-check.
  - Interview room with the LiveKit client.
  - Accessible timers.

**Generated typed API clients** from each service's `openapi.yaml` (`openapi-typescript`).

## 3. Owned data

None server-side. The gateway caches only.

## 4. Contract

- The UI only calls the gateway.
- Route map: `/v1/tenants*` → tenant-svc and so on, versioned in `infra/gateway/routes.yaml`.

## 5. Events

None.

## 6. Rules

- The UI never decides authorisation; it hides affordances, and the APIs enforce.
- No PII in client logs or analytics.
- CSP: no inline scripts; stdout from code runs is rendered as text.
- RTL support (Arabic).
- WCAG 2.2 AA.

## 7. Non-functional

- Core Web Vitals: LCP < 2.5 s and INP < 200 ms on mid-tier hardware.
- The test runner works on flaky networks (offline queue; server-authoritative timer).

## 8. Acceptance tests

- **Gateway:** unknown subdomain → 404 page; suspended tenant → 403 page; a cross-cell request is routed correctly (contract test with stubbed cells).
- **End-to-end:** Playwright: invite → login → create assessment → candidate completes a coding test with a network drop → recruiter sees the report.
- **Accessibility:** axe-core with zero serious violations on core flows.

## 9. Deliverables

`apps/web/`, `infra/gateway/`, `packages/api-clients/` (generated), Playwright suite in `e2e/`.

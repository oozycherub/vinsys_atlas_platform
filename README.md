# Atlas Platform

Enterprise AI-powered talent management: skills intelligence, assessments, proctoring, AI interviews and an internal talent marketplace. The platform is built **brick by brick**, one microservice at a time, under the rules in [`docs/MASTER_ORCHESTRATION_PROMPT.md`](docs/MASTER_ORCHESTRATION_PROMPT.md).

| Doc                                                                          | Purpose                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`docs/PRD.md`](docs/PRD.md)                                                 | What the product does (behaviour source of truth)                           |
| [`docs/MASTER_ORCHESTRATION_PROMPT.md`](docs/MASTER_ORCHESTRATION_PROMPT.md) | Repo layout, toolchain, architecture rules, Definition of Done, build order |
| [`docs/prompts/`](docs/prompts)                                              | One Component Prompt per brick, in build order                              |
| [`docs/adr/`](docs/adr)                                                      | Architecture decision records                                               |

## Build status

| #   | Brick                                                                          | Status                                      |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| 0   | Foundation: monorepo, infra, migrations, `@atlas/platform`, `@atlas/contracts` | ✅ done                                     |
| 1   | tenant-svc                                                                     | ✅ done                                     |
| 2   | identity-svc                                                                   | ✅ done (2a + 2b)                           |
| 3   | taxonomy-svc                                                                   | ✅ done                                     |
| 4   | profile-svc                                                                    | ✅ done                                     |
| 5   | llm-gateway (Python)                                                           | ✅ done                                     |
| 6   | parsing-svc (Python, Temporal)                                                 | ✅ done                                     |
| 7   | matching-svc + packages/scoring                                                | ✅ done                                     |
| 8   | assessment-svc                                                                 | ✅ done                                     |
| 9   | sandbox-svc (Go) + judge images, Helm chart, Falco rules                       | ✅ built; attack corpus needs Linux/Docker  |
| 10  | proctoring-svc (Go) + cv-inference (Python/Triton) + @atlas/proctor-sdk        | ✅ built; real-model evaluations need GPU   |
| 11  | interview-svc (Python, LangGraph, LiveKit agents)                              | ✅ built; real voice models need GPU        |
| 12  | intelligence-svc (TS) + intelligence-ml (Python: CP-SAT, LightGBM, Dagster)    | ✅ built; real-data model quality unproven  |
| 13  | notification-svc + report-svc (TS: MJML, signed webhooks, Chromium PDFs)       | ✅ built; providers mocked, load untested   |
| 14  | gateway (Envoy + TS edge), web apps (Next.js), api-clients, Playwright e2e     | ✅ built; e2e uses a stub API, CWV untested |

## Quick start

```bash
nvm use               # Node 24
npm ci
make py-bootstrap     # Python services (needs uv; Python 3.12 from .python-version)
make verify           # TS: typecheck → lint → tests → build; Python: ruff → mypy → pytest (no Docker needed)
make infra-up         # optional: real Postgres/Redis/Redpanda/MinIO via Docker
make migrate
```

## Layout

```
packages/contracts   event schemas (zod) and shared enums
packages/platform    config, errors (RFC 9457), logging, tenancy-aware DB access, outbox, idempotency, JWT auth
packages/scoring     the candidate ↔ job scoring formula as pure functions (matching, marketplace)
services/<name>-svc  one deployable per brick (hexagonal: domain → application → infrastructure/http)
services/llm-gateway, services/parsing-svc  Python bricks (FastAPI, uv); same hexagonal layout
services/sandbox-svc, services/proctoring-svc  Go bricks (cmd/, internal/{domain,app,adapters}); make go-verify
services/cv-inference  Python inference worker (Triton model repository in models/, evaluations in eval/)
services/interview-svc  Python AI interviews: LangGraph graph in graph/, voice agent in voice/, calibration in eval/
services/intelligence-ml  Python workforce ML: CP-SAT fulfilment plans, the attrition pipeline (Dagster), model card in docs/
services/notification-svc  Email (MJML templates), in-app SSE, signed webhooks with a DLQ, reminders, sending domains
services/report-svc  Candidate PDFs (headless Chromium), streaming Excel exports, the Trino report gallery
infra/gateway        Envoy front + TS edge: tenant from host, cell routing, JWT pre-validation, limits (routes.yaml)
apps/web             Next.js portals (admin, recruiter, employee) and the offline-first candidate runner
packages/api-clients Typed clients generated from every public openapi.yaml
e2e                  Playwright: full flow with a network drop, axe-core, RTL, CSP
packages/go-platform shared Go runtime (auth, problem documents, tenant transactions, outbox, Kafka)
packages/proctor-sdk browser proctoring SDK (signed event chain, sampling, offline queue)
infra/sandbox-images, infra/k8s/sandbox, infra/falco  judge images, Helm chart (gVisor, KEDA, NetworkPolicy), runtime rules
packages/py-platform shared Python runtime (the counterpart of @atlas/platform)
db/migrations        forward-only SQL, applied in order
infra/               docker-compose reference environment
```

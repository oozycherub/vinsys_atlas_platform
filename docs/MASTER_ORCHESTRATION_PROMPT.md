# Master Orchestration Prompt: Atlas Talent Platform

> **Use:** This is the system-level brief given to every engineer (human or AI agent) before they build any part of Atlas. It fixes the repository layout, the toolchain, the engineering rules and the build order. Component Prompts (`docs/prompts/NN-*.md`) build one microservice each and **must not contradict this document**. If a component needs to deviate, it first adds an ADR in `docs/adr/` and updates this file in the same change.
>
> Source of truth for behaviour: [`docs/PRD.md`](PRD.md). Section numbers like "PRD §2.3" refer to it.

---

## 1. Role and mission

You are the Atlas product development team: a principal architect, backend engineers, an ML engineer, a QA engineer and an SRE working as one. Build the platform **brick by brick**:

- One service per iteration.
- Each brick is releasable on its own, with tests, contracts and documentation.
- Never start the next brick until the current one passes the Definition of Done (§8).

## 2. Repository layout (monorepo)

```
atlas-platform/
├── package.json                 # npm workspaces root; scripts fan out to workspaces
├── tsconfig.base.json           # strict TS settings shared by every TS workspace
├── eslint.config.mjs            # flat config, typescript-eslint strict
├── .prettierrc.json  .editorconfig  .nvmrc  .gitignore
├── Makefile                     # human entry points: make bootstrap|infra-up|migrate|test|lint|build
├── docs/
│   ├── MASTER_ORCHESTRATION_PROMPT.md   # this file
│   ├── PRD.md                            # product requirements (behaviour source of truth)
│   ├── adr/NNNN-title.md                 # architecture decision records (Nygard format)
│   └── prompts/NN-<service>.md           # component prompts, one per brick, in build order
├── db/
│   └── migrations/NNNN_<name>.sql        # forward-only SQL migrations, applied in order
├── infra/
│   ├── docker-compose.yml                # local Postgres+pgvector, Redis, Redpanda, MinIO
│   └── postgres/init/                    # roles (atlas_owner, atlas_app), extensions
├── packages/                    # shared libraries (no business logic of a single service)
│   ├── platform/                # @atlas/platform: config, logging, errors, db, auth, outbox, ids
│   └── contracts/               # @atlas/contracts: event schemas (zod) + shared DTO types
├── services/                    # deployable units, one folder per microservice
│   └── <name>-svc/
│       ├── openapi.yaml         # HTTP contract (written FIRST)
│       ├── README.md            # purpose, run, env vars, events in/out
│       ├── src/
│       │   ├── domain/          # pure TS: entities, value objects, state machines, rules (no I/O)
│       │   ├── application/     # use cases; depend on ports (interfaces), not adapters
│       │   ├── infrastructure/  # adapters: Postgres repositories, KMS, Kafka, HTTP clients
│       │   ├── http/            # NestJS controllers, DTO validation (zod), guards
│       │   ├── app.module.ts  main.ts  config.ts
│       └── test/
│           ├── unit/            # domain + application, no I/O, fast
│           └── integration/     # real Postgres (PGlite in-process) + HTTP via supertest
└── .github/workflows/ci.yml     # typecheck → lint → test → build per workspace
```

Python services (ML: parsing workers, CV inference, interview agent) live under `services/<name>/` with `pyproject.toml` (uv, ruff, mypy --strict, pytest) and keep the same `domain/application/infrastructure/http` split. Go services (sandbox judge, media) use `cmd/`, `internal/domain`, `internal/app` and `internal/adapters`.

## 3. Toolchain (pinned)

| Concern                 | Choice                                             | Version rule                                                                      |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Runtime                 | Node.js                                            | `24.x` (`.nvmrc`)                                                                 |
| Package manager         | npm workspaces                                     | `npm@11`; the lockfile is committed                                               |
| Language                | TypeScript                                         | `5.9.x`, `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| HTTP framework          | NestJS **11.x** on Express (CommonJS build)        | Nest 12 is ESM-only; we stay on 11 until ADR-0003 is revisited                    |
| Validation              | zod 3                                              | Every external input (HTTP body, query, env, event) is parsed by a zod schema     |
| DB driver               | `pg` (node-postgres)                               | Raw parameterised SQL in repositories. No ORM (ADR-0004).                         |
| Test runner             | Vitest with `unplugin-swc`                         | SWC emits decorator metadata for Nest DI                                          |
| In-process DB for tests | `@electric-sql/pglite` with the `vector` extension | ADR-0005                                                                          |
| Logging                 | pino (JSON)                                        | Fields: `ts, level, msg, service, request_id, tenant_id, trace_id`                |
| Lint / format           | ESLint 9 flat config + typescript-eslint; Prettier | CI fails on warnings                                                              |
| Python                  | 3.12, uv, ruff, mypy, pytest                       | when the first Python brick starts                                                |
| Go                      | 1.23, golangci-lint                                | when the first Go brick starts                                                    |

Exact versions are pinned in `package.json` (no `^` or `~` for runtime dependencies) and upgraded deliberately by Renovate PRs.

## 4. Architecture rules (non-negotiable)

1. **Hexagonal per service.**
   - `domain` imports nothing outside the standard library and `@atlas/contracts` types.
   - `application` depends on `domain` and on _ports_ (interfaces).
   - `infrastructure` and `http` implement ports.
   - Dependency direction is enforced by ESLint `no-restricted-imports`.
2. **Database per service, logically.** Each service owns its tables (listed in its README) and never reads another service's tables. Cross-service data arrives through events or APIs.
3. **Multi-tenancy (PRD §1.2).**
   - Every tenant-owned table has `tenant_id` and RLS.
   - Services touch tenant data only through `withTenantTx(tenantId, fn)` from `@atlas/platform`. Calling `pool.query` directly on tenant tables is a lint error.
   - Tenant identity comes **only** from the verified JWT (`tid` claim) or, for system jobs, from an event header. Never from a request body or query string.
4. **Transactional outbox.** A state change and its event are written in the same transaction via `appendOutbox(tx, event)`. Services never publish to Kafka directly from request handlers.
5. **Contracts first.** `openapi.yaml` and any new event schema in `@atlas/contracts` are written and reviewed before handlers. Breaking changes need a new version (`/v2`, `*.v2`).
6. **Errors.**
   - HTTP errors are RFC 9457 `application/problem+json` with `type, title, status, detail, instance, code, request_id`.
   - Domain errors are typed classes with a stable `code` (`TENANT_SLUG_TAKEN`).
   - No stack traces cross the wire.
7. **Idempotency.** Every non-idempotent `POST` accepts an `Idempotency-Key` header. Event consumers de-duplicate on `event_id`.
8. **IDs.** UUIDv7 generated in the application (`newId()` from `@atlas/platform`).
9. **Time.** UTC everywhere (`timestamptz`). The clock is injected (`Clock` port) so domain logic is testable.
10. **Configuration.** 12-factor. Each service has a `config.ts` with a zod schema over `process.env`. The process exits on invalid config at boot.
11. **Security baseline.**
    - Deny by default: every route needs `@Roles(...)` or an explicit `@Public()`.
    - Request bodies are capped at 1 MB unless the contract says otherwise.
    - Secrets come from the environment or a secrets manager, never from code.
    - PII is never written to logs; pino redaction paths are configured centrally.
12. **Observability.**
    - Every service exposes `GET /healthz` (liveness) and `GET /readyz` (dependencies).
    - Every request carries `x-request-id`, generated if absent and echoed back.

## 5. Naming conventions

Follow PRD §1.2.5 exactly: plural `snake_case` tables, `<noun>_id` keys, `/v1/<plural>/{id}` and `:verb` custom methods, topic names `<domain>.<entity>.<event>.v<N>`, services `<domain>-svc`, env vars `ATLAS_<SERVICE>_<NAME>` for service-specific settings and `ATLAS_<NAME>` for shared ones.

## 6. Build order (bricks)

| #   | Brick                                                                         | Depends on | Language    | Component prompt             |
| --- | ----------------------------------------------------------------------------- | ---------- | ----------- | ---------------------------- |
| 0   | Repo foundation, infra, migrations, `@atlas/platform`, `@atlas/contracts`     | —          | TS / SQL    | this file + `00-platform.md` |
| 1   | **tenant-svc**: tenant directory, lifecycle, settings, data keys              | 0          | TS          | `01-tenant-svc.md`           |
| 2   | identity-svc: users, roles, JWT issuance (dev IdP), SSO federation            | 1          | TS          | `02-identity-svc.md`         |
| 3   | taxonomy-svc: skill graph, aliases, normalisation API                         | 1, 2       | TS          | `03-taxonomy-svc.md`         |
| 4   | profile-svc: candidates, PII encryption, documents, skill evidence and fusion | 1–3        | TS          | `04-profile-svc.md`          |
| 5   | llm-gateway: model routing, PII redaction, quotas, prompt registry            | 1          | Python      | `05-llm-gateway.md`          |
| 6   | parsing-svc: résumé pipeline and embeddings                                   | 4, 5       | Python      | `06-parsing-svc.md`          |
| 7   | matching-svc: hybrid scoring and explanations                                 | 3, 4, 6    | TS          | `07-matching-svc.md`         |
| 8   | assessment-svc: tests, sessions, timers, scoring                              | 2–4        | TS          | `08-assessment-svc.md`       |
| 9   | sandbox-svc: judge API and workers                                            | 8          | Go          | `09-sandbox-svc.md`          |
| 10  | proctoring-svc and cv-inference                                               | 8          | Go + Python | `10-proctoring-svc.md`       |
| 11  | interview-svc: voice/text AI interviewer                                      | 5, 8       | Python      | `11-interview-svc.md`        |
| 12  | intelligence-svc: marketplace, career paths, fulfilment, attrition            | 3, 4, 7    | TS + Python | `12-intelligence-svc.md`     |
| 13  | notification-svc, report-svc                                                  | 8          | TS          | `13-notification-report.md`  |
| 14  | api-gateway configuration and web apps (admin, employee, test runner)         | all        | TS          | `14-gateway-and-web.md`      |

## 7. Workflow per brick (strict)

1. **Read** this file, the brick's component prompt and the PRD sections it cites.
2. **Design note.** Update the service README with responsibilities, owned tables, ports, events in and out, and failure modes.
3. **Contracts.** Write `openapi.yaml` and the event schemas in `@atlas/contracts`.
4. **Migration.** Add the next numbered SQL file under `db/migrations/`, forward-only and idempotent where possible.
5. **Domain first, test first.** Write unit tests for state machines and rules, then implement them.
6. **Application use cases** against ports, with in-memory fakes in unit tests.
7. **Adapters.** Postgres repositories using `withTenantTx` / `withSystemTx`; HTTP controllers with zod DTOs.
8. **Integration tests** on PGlite with the full migration set applied, running as the `atlas_app` role so RLS is real. They must include a **cross-tenant leak test** for every read endpoint of tenant data.
9. **Quality gates:** `npm run typecheck && npm run lint && npm test && npm run build` must all pass at the repo root.
10. **Docs.** README run instructions; a new ADR for any decision not already covered.
11. **Review checklist (§8).** Then open a PR using Conventional Commits (`feat(tenant-svc): …`).

## 8. Definition of Done (every brick)

- [ ] The OpenAPI contract matches the implementation; every route has a role guard or `@Public()`.
- [ ] All inputs are validated by zod; errors use problem+json with stable codes.
- [ ] Domain logic has unit tests, with ≥ 90% line coverage of `src/domain`.
- [ ] Integration tests cover the happy path, validation errors, authz failures, idempotency and the cross-tenant leak test.
- [ ] State changes emit outbox events whose schemas are registered in `@atlas/contracts`.
- [ ] No PII in logs (redaction test or reviewed log statements).
- [ ] `/healthz` and `/readyz` are implemented; config is validated at boot.
- [ ] README lists env vars, owned tables, events, and how to run and test.
- [ ] Typecheck, lint, tests and build are all green at the repo root.

## 9. What a Component Prompt must contain

Each `docs/prompts/NN-*.md` has the same headings:

1. **Context**: PRD references and position in the build order.
2. **Scope**: in and out of scope for this brick.
3. **Owned data**: tables (by migration) and object storage prefixes.
4. **API contract**: endpoints, roles, request and response shapes, error codes.
5. **Events**: produced and consumed, with payload fields.
6. **Domain rules**: state machines, invariants and formulas.
7. **Non-functional**: SLAs, limits and security notes specific to the brick.
8. **Acceptance tests**: Given/When/Then list that maps one-to-one to integration tests.
9. **Deliverables checklist**: files that must exist at the end.

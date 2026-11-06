# Component Prompt 00: Foundation (`@atlas/platform`, `@atlas/contracts`, migrations, infra)

> Status: **built**. Keep this prompt current when the shared packages change, because every later brick depends on them.

## 1. Context

Brick 0 (MASTER_ORCHESTRATION_PROMPT §6). Implements the cross-cutting rules of §4: tenancy (PRD §1.2.2), outbox (PRD §1.3), errors, idempotency, auth and config.

## 2. Scope

**In:** monorepo tooling; `db/migrations/0001_foundation.sql`; Docker Compose reference infra; the shared libraries below.
**Out:** any business tables. Those belong to the brick that owns them.

## 3. Owned data

`0001_foundation.sql` creates:

- The `atlas_app` role, with default privileges so the role can use tables created later.
- `current_tenant_id()` and `set_updated_at()`.
- `outbox_events`, with RLS: a tenant's own events, or platform events inside a system transaction.
- `processed_events` (consumer de-duplication).
- `idempotency_keys`.

## 4. Library contract (`@atlas/platform`)

| Export                                                                               | Contract                                                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `withTenantTx(db, tenantId, fn)`                                                     | Opens a transaction and sets `app.tenant_id` with `is_local=true`. Rejects a non-UUID before any I/O.           |
| `withSystemTx(db, fn)` / `setTenantContext(tx, id)`                                  | Platform-level transactions; switching the tenant context mid-transaction for outbox writes                     |
| `appendOutbox(tx, event)`                                                            | Inserts in the caller's transaction. Headers carry `event_id` and `request_id`.                                 |
| `runIdempotent(db, {scope,key,requestHash}, work)`                                   | One transaction for the key, the change and the stored response. Replays on retry; 422 on key reuse.            |
| `JwtVerifier`, `AuthGuard`, `@Public`, `@Roles`, `@Scopes`, `@CurrentPrincipal`      | Deny by default: a route without a policy returns 403                                                           |
| `ProblemDetailsFilter`, `configureHttpApp`, `parseInput`                             | RFC 9457 errors, request IDs, access logs, 1 MB body limit, zod parsing to 400                                  |
| `AppError` subclasses                                                                | Stable `code` plus status: 400, 401, 403, 404, 409, 412, 422, 428, 503                                          |
| `loadConfig`, `createLogger` (PII redaction), `newId` (UUIDv7), `Clock`/`FixedClock` |                                                                                                                 |
| `@atlas/platform/testing`                                                            | `createTestDatabase()` (PGlite, all migrations, `SET LOCAL ROLE atlas_app`), `signTestToken`, `MemoryLogStream` |

`@atlas/contracts`: `defineEvent(topic, aggregateType, zodSchema)` validates topic names and payloads, with a registry for consumers. It also holds shared enums (roles, tenant statuses).

## 5. Events

None of its own. It provides the outbox mechanics.

## 6. Rules

- Migrations are forward-only, contiguous and checksummed. Editing an applied file is an error.
- RLS must fail closed when no tenant is set.

## 7. Non-functional

`withTenantTx` adds a single `set_config` round trip. The logger never emits authorization headers, emails, phone numbers or tokens.

## 8. Acceptance tests (implemented in `packages/platform/test`)

Migrations apply and are recorded; app transactions run as `atlas_app`; tenant A cannot read or write tenant B's outbox rows; no tenant context returns zero rows; platform events require a system transaction; a SQL-injection-shaped tenant ID is rejected; idempotency replays, rejects key reuse and frees the key on failure; JWT accepts valid tokens and rejects wrong key, expired or unknown role; problem documents hide internals; logs are redacted.

## 9. Deliverables

All present in the repository.

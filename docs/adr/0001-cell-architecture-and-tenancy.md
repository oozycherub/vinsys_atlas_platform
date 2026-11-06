# ADR-0001: Cell architecture with pooled tenancy and Postgres RLS

- Status: Accepted
- Date: 2026-11-04

## Context

Atlas serves both mid-market and regulated enterprises (PRD §1.2). Some customers require physical data isolation and in-region residency. Most need cost-efficient pooling.

## Decision

- Deploy the platform as **cells**. A cell is a full stack in one region.
- Pooled cells share one Postgres cluster: every tenant-owned row carries `tenant_id`, enforced by `FORCE ROW LEVEL SECURITY` policies keyed on the transaction setting `app.tenant_id`.
- Dedicated cells run the same code and schema for a single tenant.
- `tenant-svc` owns the global **tenant directory** (`tenant_id → cell_id, region, isolation_tier`).
- Applications connect as `atlas_app`, which has no `BYPASSRLS`. Migrations run as `atlas_owner`.

## Consequences

- One schema and one code path; tenant isolation is enforced by the database even if application code has a bug.
- Every tenant-data access must go through `withTenantTx`. The integration suite runs as `atlas_app` to prove RLS.
- Cross-tenant analytics must go through the lakehouse, not live queries.

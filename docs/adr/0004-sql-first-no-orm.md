# ADR-0004: SQL-first persistence, no ORM

- Status: Accepted
- Date: 2026-11-04

## Context

The data layer relies on Postgres-specific features an ORM hides or fights: row-level security driven by `set_config`, composite tenant foreign keys, `ltree`, pgvector HNSW queries, partitioned tables, and generated columns.

## Decision

- Schema changes are hand-written, forward-only SQL migrations in `db/migrations/`, applied in order by `@atlas/platform`'s migrator and recorded in `schema_migrations`.
- Repositories use parameterised SQL through the `Db`/`Tx` interfaces from `@atlas/platform`. Each repository maps rows to domain entities explicitly.

## Consequences

- Full control over queries and indexes; SQL is reviewed like code.
- A little more mapping code per repository. Integration tests on real Postgres semantics (ADR-0005) catch drift between SQL and domain types.

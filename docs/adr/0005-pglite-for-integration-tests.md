# ADR-0005: PGlite (in-process Postgres) for integration tests

- Status: Accepted
- Date: 2026-11-04

## Context

Integration tests must exercise real Postgres behaviour: RLS, constraints, `ltree`, pgvector. They should also run on any laptop or CI runner, including machines without Docker.

## Decision

- Integration tests use `@electric-sql/pglite`, Postgres compiled to WASM and run in-process, with the `vector`, `ltree` and `citext` extensions.
- The test harness applies all migrations, creates the `atlas_app` role and runs queries under `SET ROLE atlas_app`, so RLS is enforced exactly as in production.
- `infra/docker-compose.yml` (Postgres 16 + pgvector) remains the reference environment for local runs and for a nightly CI job that repeats the integration suite against the real server.

## Consequences

- Fast, hermetic tests with no external services.
- PGlite is single-connection, so concurrency behaviour (locks, `SKIP LOCKED`) must be tested in the nightly real-Postgres job.

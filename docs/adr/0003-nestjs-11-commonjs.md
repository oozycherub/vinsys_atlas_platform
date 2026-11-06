# ADR-0003: NestJS 11 (CommonJS) for TypeScript services

- Status: Accepted
- Date: 2026-11-04

## Context

NestJS gives the team modules, dependency injection, guards and interceptors, which suit tenant and auth middleware (PRD §1.4). NestJS 12 is ESM-only, and parts of the tooling ecosystem (test runners, decorator metadata, some libraries) still behave inconsistently under ESM.

## Decision

- Use **NestJS 11.x**, compiled by `tsc` to CommonJS with `emitDecoratorMetadata`.
- Tests run under Vitest with SWC, which emits the decorator metadata Nest's DI needs.
- Revisit when NestJS 11 leaves support or when a needed feature requires 12.

## Consequences

- ESM-only dependencies cannot be `require`d from production code. Such libraries are confined to tests (e.g. PGlite) or loaded with dynamic `import()`.

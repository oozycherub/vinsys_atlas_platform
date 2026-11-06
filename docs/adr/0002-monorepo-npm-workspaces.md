# ADR-0002: Monorepo with npm workspaces

- Status: Accepted
- Date: 2026-11-04

## Context

There will be 14+ services sharing platform code (tenancy, auth, errors, outbox) and event contracts. Separate repositories would duplicate that code and let versions drift.

## Decision

- One repository. TypeScript workspaces are managed by **npm workspaces**, which ship with Node, so contributors need no extra tooling. Shared code lives in `packages/*` and deployables in `services/*`.
- Python and Go services sit in the same tree with their native tooling.
- Turborepo or Nx may be added when CI time justifies task caching. That change needs a new ADR.

## Consequences

- Atomic changes across contracts and their consumers in one PR.
- CI must scope jobs by changed paths once the service count grows.

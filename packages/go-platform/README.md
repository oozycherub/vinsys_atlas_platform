# go-platform

Shared code for the Go services (sandbox-svc, proctoring-svc): the counterpart of `@atlas/platform` (TypeScript) and `atlas_platform` (Python). It contains no business logic.

| Package   | What                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `auth`    | JWT verification (JWKS RS256/ES256; HS256 only with a shared secret outside production), `Principal`, client-credentials tokens      |
| `httpx`   | RFC 9457 problem documents, request ids, strict JSON bodies, bearer authentication, tenant resolution                                |
| `pgtx`    | Transactions with the tenant context (`app.tenant_id`) or system context (`app.system`), outbox writes, event de-duplication, UUIDv7 |
| `events`  | Consumed and outgoing event types, poison errors, payload decoding                                                                   |
| `kafka`   | Debezium outbox record parsing and the consume loop: commit after the handler, dead-letter poison records, retry failures            |
| `logging` | JSON logs with the platform's field names                                                                                            |
| `testkit` | A fresh Postgres database per test package (chosen migrations, connected as `atlas_app`), signed test tokens                         |

Services import it through `replace atlas.dev/go-platform => ../../packages/go-platform` in their `go.mod`.

`make go-verify` runs its own gate (vet, golangci-lint, race tests, coverage of at least 85%; currently 90.7%). The consume loop is tested against `kfake`, an in-memory Kafka.

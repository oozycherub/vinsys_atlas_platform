# atlas-platform (Python)

The Python counterpart of `@atlas/platform`, shared by llm-gateway and parsing-svc. Services depend on it as an editable path dependency (`[tool.uv.sources]`).

| Module     | What                                                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors`   | `AppError(kind, code, message, **extensions)` and the kind → HTTP status map (RFC 9457). `retry_after` becomes the Retry-After header.                                                                                                   |
| `db`       | `PgDatabase` / `PgTx` (psycopg 3 pool). `tenant_tx` sets `app.tenant_id` for RLS, `system_tx` sets `app.system`, and an optional `SET LOCAL ROLE` applies RLS when the pool logs in as the owner. Start-up never blocks on the database. |
| `auth`     | `JwtVerifier` (JWKS or HS256; claims `sub`, `tid`, `roles`, `scopes`), `Principal`, `ClientCredentialsTokenProvider`.                                                                                                                    |
| `web`      | `install(app, verifier)`: request ids, a path-only access log and problem+json for every failure. Also the `authenticate` dependency and `require_service`.                                                                              |
| `events`   | `PgOutbox`, `PgProcessedEvents`, and `parse_outbox_record`, which mirrors the TypeScript parser.                                                                                                                                         |
| `ids`      | `uuid7()`, `is_uuid()`.                                                                                                                                                                                                                  |
| `logs`     | JSON logs with `extra` fields.                                                                                                                                                                                                           |
| `pii`      | Deterministic detectors (known values, email and phone patterns) and span merging.                                                                                                                                                       |
| `presidio` | Presidio + spaCy detector. This is the optional extra `atlas-platform[pii]`.                                                                                                                                                             |
| `testing`  | `start_postgres` (pgserver + pgvector with the chosen migrations) and `make_token`.                                                                                                                                                      |

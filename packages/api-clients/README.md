# @atlas/api-clients

Typed clients for the 11 public services, generated with openapi-typescript from each `services/*/openapi.yaml` and called through openapi-fetch against the gateway.

```bash
npm run generate -w @atlas/api-clients          # regenerate src/generated/
node packages/api-clients/scripts/generate.mjs --check   # fails if a spec changed without regenerating
```

`createAtlasClients({ baseUrl, token, onProblem })` returns one client per service, sharing one middleware: it adds the bearer token and reports RFC 9457 problems. A drift test runs `--check`.

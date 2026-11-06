# API gateway (brick 14)

Envoy terminates TLS and runs the WAF ([`envoy/envoy.yaml`](envoy/envoy.yaml)). Behind it, this TypeScript edge decides every request from the route map ([`routes.yaml`](routes.yaml)).

Spec: [`docs/prompts/14-gateway-and-web.md`](../../docs/prompts/14-gateway-and-web.md) · Decisions: [ADR-0011](../../docs/adr/0011-gateway-edge-and-web-app.md) · Port 8080

## What it does, in order

| Step               | Behaviour                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path hygiene       | Encoded separators, `..`, and empty segments: 400                                                                                                         |
| Deny list          | `/v1/internal`, `/v1/tenant-directory`, signing keys, service clients, health: 404 at the edge                                                            |
| Tenant             | `<slug>.<base domain>` → tenant-svc directory: cached 60 s, misses 10 s, one lookup in flight, stale ≤ 5 min if down                                      |
| Status             | Unknown or purged: 404 page; suspended or offboarding: 403 page; provisioning: 503 (API calls get problem documents)                                      |
| Route              | Most specific pattern in `routes.yaml`; platform hosts serve only platform paths                                                                          |
| CORS               | The workspace's own https origin only                                                                                                                     |
| JWT pre-validation | JWKS. The token's tenant must be the host's; service tokens are refused; candidate tokens pass only on `session` routes                                   |
| Rate limit         | Per tenant per minute by isolation tier (Redis); anonymous calls per IP                                                                                   |
| Proxy              | `http://{service}.{cell}.svc.cluster.local:{port}`, streamed both ways (SSE and downloads); trusted `x-atlas-*` headers set here, clients' copies dropped |

Every response carries `x-request-id`.

## Running

```bash
npm run build && node infra/gateway/dist/main.js
```

Environment:

- `ATLAS_GATEWAY_BASE_DOMAIN`, `ATLAS_TENANT_SVC_URL`;
- service credentials with scope `tenant-directory:read`;
- `ATLAS_AUTH_JWKS_URL`, `ATLAS_REDIS_URL` (required in production);
- `ATLAS_GATEWAY_RPM_POOLED`, `…_DEDICATED`, `…_ANONYMOUS`.

## Tests

31 tests. All 18 seeded mutations across brick 14 are caught.

- **Route map against the service contracts:** every public path in every `openapi.yaml` reaches its owner; internal paths are denied; internal services are unreachable.
- **Contract test with stubbed cells** (a real proxy):
  - unknown subdomain → 404 page; suspended → 403 page;
  - tenants routed to their own cells;
  - spoofed identity headers dropped;
  - token checks;
  - CORS, rate limits, SSE pass-through;
  - directory outage; upstream outage.

## Gaps

- The Envoy and Coraza config is reviewed, not executed, here (no Envoy binary in CI).
- WAF rule tuning is per deployment.

# Component Prompt 02: identity-svc (Users, Roles, Tokens, SSO)

## 1. Context

- PRD §1.2.6 (authentication and authorisation) and §4.2 (access control, audit).
- Brick 2; depends on tenant-svc. Replaces the test-only HS256 tokens with the platform's real token issuer and JWKS.
- **Also wires the outbox relay:** Debezium connector config plus a consumer library in `@atlas/platform`, used here first. identity-svc consumes `tenant.tenant.*` events.

## Status

**Built (2a + 2b).** Every item in §2 and acceptance tests 1–7, plus OIDC and SAML federation, authorization code + PKCE, platform-staff accounts, Redis limiter, Kafka source, notification-svc delivery and AWS KMS. Migrations `0004_identity.sql` and `0005_identity_federation.sql`. Remaining work is verification against real infrastructure (see `services/identity-svc/README.md`).

## 2. Scope

**In**

- Tenant users CRUD, role assignment and business-unit scoping.
- Invitations: single-use magic link, 72 h TTL.
- Password-less login for candidates: magic link bound to a session, 30 min TTL.
- OIDC authorization-code + PKCE for platform users.
- Per-tenant SAML/OIDC SSO federation config.
- Issuing access tokens (ES256, 10 min) and refresh tokens (rotating, 14 days, reuse detection).
- JWKS endpoint with key rotation.
- Service-principal client credentials (scopes).
- Consuming tenant lifecycle events: suspended tenant means tokens are refused; purged tenant means users are deleted.

**Out:** HR data (profile-svc); MFA UI (delegated to the IdP for SSO tenants; TOTP for local accounts is a later increment).

## 3. Owned data

Migration `0004_identity.sql`:

- `users` (PRD §3: tenant_id, email unique per tenant (stored lower-cased, CHECK instead of citext), roles[], business_unit_ids[], status, last_login_at).
- `magic_links` (token_hash, binding_hash, expires_at, consumed_at) and `tenant_access` (projection of tenant status from events).
- `user_invitations` (token_hash, expires_at, consumed_at).
- `refresh_tokens` (family_id, token_hash, rotated_from, revoked_at).
- `signing_keys` (kid, alg, public_jwk, private key encrypted with a platform KEK, not_before, retired_at).
- `sso_connections` (tenant_id, protocol, metadata, domain hints).
- `service_clients` (client_id, secret_hash argon2id, scopes[]).

RLS on every tenant-owned table. `signing_keys` and `service_clients` are platform-level.

## 4. API contract

| Endpoint                                                                                               | Roles                                  |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `POST /v1/users:invite`, `GET /v1/users`, `GET/PATCH /v1/users/{id}`, `POST /v1/users/{id}:deactivate` | tenant_admin (own tenant), super_admin |
| `POST /v1/auth/magic-links` (rate-limited 5/h per email)                                               | public                                 |
| `POST /v1/auth/magic-links:redeem`                                                                     | public                                 |
| `POST /v1/oauth/token` (grant types `authorization_code`, `refresh_token`, `client_credentials`)       | public / client                        |
| `GET /.well-known/jwks.json`, `GET /.well-known/openid-configuration`                                  | public                                 |
| `PUT /v1/sso-connections/{tenantId}`                                                                   | tenant_admin, super_admin              |
| `GET /v1/sso/{tenantSlug}/start` and `/callback`                                                       | public                                 |

Errors: `USER_EMAIL_TAKEN`, `INVITATION_EXPIRED`, `TOKEN_REUSE_DETECTED` (revokes the whole family), `TENANT_SUSPENDED`, `SSO_REQUIRED` (when the tenant enforces SSO).

## 5. Events

- **Produced:** `identity.user.invited.v1`, `.activated.v1`, `.deactivated.v1`, `.roles_changed.v1`, `identity.session.refresh_reuse_detected.v1` (security alert).
- **Consumed:** `tenant.tenant.suspended.v1` and `.reactivated.v1` (flag tenant), `.purged.v1` (hard-delete users), `.provisioned.v1` (create the first tenant_admin invitation if `bootstrap_admin_email` is supplied).

## 6. Domain rules

- **Token claims:** `sub`, `tid`, `roles[]`, `bu[]`, `scopes[]`, `iat`, `exp`, `jti`, `amr`.
- **Refresh rotation:** a reused refresh token revokes the whole family.
- **Signing keys** rotate every 30 days; both old and new keys are published in JWKS until the old key's last token expires.
- **Role grants:** a tenant_admin cannot grant `super_admin` or `service`. Users cannot change their own roles.
- **Secrets at rest:** magic-link and invitation tokens are stored only as SHA-256 hashes; client secrets as argon2id.

## 7. Non-functional

`/oauth/token` p95 < 150 ms. Brute-force protection via a Redis token bucket per IP and email. Every auth event goes to the audit log.

## 8. Acceptance tests

1. Invite, redeem, token exchange: a JWT validates against the published JWKS.
2. Refresh-token reuse: the family is revoked and an event emitted.
3. A suspended tenant gets 401 `TENANT_SUSPENDED` on token exchange.
4. A tenant_admin cannot grant super_admin (403); a cross-tenant user read returns 404 (leak test).
5. Key rotation: tokens signed by the previous key still verify until expiry.
6. SSO-enforced tenant: magic-link login is refused with `SSO_REQUIRED`.
7. Rate limit returns 429 with `Retry-After`.

## 9. Deliverables

- Migration, service skeleton per the master layout, `openapi.yaml`, README.
- Contracts in `@atlas/contracts/identity-events.ts`.
- Outbox relay (Debezium connector JSON in `infra/debezium/`) and `@atlas/platform` `createConsumer()` with `processed_events` de-duplication.

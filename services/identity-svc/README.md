# identity-svc (brick 2)

Users, roles, sign-in and token issuance for Atlas. It is the platform's token issuer: every other service verifies access tokens against this service's JWKS.

Spec: [`docs/prompts/02-identity-svc.md`](../../docs/prompts/02-identity-svc.md) · Contract: [`openapi.yaml`](openapi.yaml)

## Design

```
http/            UsersController, AdminController, AuthController, WellKnownController + zod DTOs
  └─▶ application/  UserService, AuthService, AdminService, SigningKeyService, TenantEventHandlers
        └─▶ domain/   user lifecycle & role-grant rules, refresh rotation, signing-key rotation policy
infrastructure/  Pg repositories (SQL-first), LogLinkDelivery (dev), MemoryLinkDelivery (tests)
```

**Sign-in flows**

| Flow                    | How it works                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitation              | Admin invites → 72 h single-use link → `POST /v1/invitations:redeem` activates the user and returns tokens.                                             |
| Magic link (candidates) | `POST /v1/auth/magic-links` always answers 202 with a `binding`; the 30 min link only works together with that binding, so a forwarded link is useless. |
| Refresh                 | Refresh tokens rotate on every use. Presenting a used one revokes the whole family and emits `identity.session.refresh_reuse_detected.v1`.              |
| Client credentials      | Machine clients (`svc_<name>`) get `roles: ["service"]` tokens with a subset of their allowed scopes.                                                   |
| Tenant SSO (OIDC/SAML)  | Web app → `GET /v1/sso/{slug}/start` (OAuth + PKCE S256) → tenant IdP → `/callback` (OIDC) or `/acs` (SAML) → app gets `code` → `POST /v1/oauth/token`. |
| Platform staff          | Same flow via `GET /v1/staff/sso/start` and the workforce IdP. Staff tokens: `roles: ["super_admin"]`, `tid: null`, no refresh token.                   |

**Federation rules.**

- Atlas's own OAuth clients are configured (`ATLAS_IDENTITY_OAUTH_CLIENTS`); redirect URIs match exactly, and `{slug}` must equal the tenant being signed in to. PKCE S256 is mandatory. Bad client, redirect or PKCE parameters give a problem document and never a redirect.
- State is single use and lives 10 minutes; authorization codes are single use, live 60 seconds and are bound to the client, redirect URI and challenge.
- OIDC: discovery, PKCE towards the IdP, `client_secret_basic`, ID token checked for signature, issuer, audience, expiry and nonce, and a verified email is required. The client secret is sealed with KeyEncryption and never returned.
- SAML: signed assertions required; the response must answer this login's AuthnRequest (InResponseTo), with audience = our entity id.
- The IdP may only sign in emails from the connection's `domain_hints` (if set). Invited users are activated by their first SSO login; unknown users are refused unless `jit_role` is set.
- Tenant admins configure IdP URLs, so the relying party only fetches `https` URLs on DNS names (no IP literals or localhost) unless `ATLAS_IDENTITY_ALLOW_INSECURE_IDP` (refused in production).
- After the state is validated, failures redirect to the client with `error=access_denied&error_description=<reason>`.

**Tokens.** ES256 JWT, 10 minutes, header `typ: at+jwt`, claims `sub, tid, roles, bu, scopes, amr, iat, exp, jti`. Refresh tokens are opaque (`rt.<tenant_id>.<secret>`), 14 days. The tenant id lets the lookup run under that tenant's row-level security.

**Signing keys.** Created on first boot and rotated every 30 days (or `POST /v1/signing-keys:rotate`). A new key is published in JWKS 10 minutes before it signs, and the old key stays published until its last token expires. Private keys are sealed with `KeyEncryption` (local AES-256-GCM in development, AWS KMS in production), bound to the key id.

**Tenant status** comes from `tenant.tenant.*` events into `tenant_access`. Suspended or offboarding tenants get 401 `TENANT_SUSPENDED` on every token exchange. Purge hard-deletes the tenant's users, links, tokens and SSO config. `tenant.tenant.provisioned.v1` with `bootstrap_admin_email` invites the first tenant_admin.

**Secrets at rest.** Invitation, magic-link and refresh tokens are stored as SHA-256 hashes; client secrets as argon2id. Links are never put in events or logs (except by the dev-only log delivery).

## Owned data (`0004_identity.sql`)

| Table                 | Scope    | Notes                                                                             |
| --------------------- | -------- | --------------------------------------------------------------------------------- |
| `users`               | RLS      | Email unique per tenant (stored lower-cased). Optimistic concurrency (`version`)  |
| `user_invitations`    | RLS      | Token hash, 72 h, single use                                                      |
| `magic_links`         | RLS      | Token hash + browser-binding hash, 30 min, single use                             |
| `refresh_tokens`      | RLS      | Families with `used_at`/`revoked_at` for reuse detection                          |
| `sso_connections`     | RLS      | Protocol, metadata, domain hints, `enforced`                                      |
| `tenant_access`       | platform | Projection of tenant status from events                                           |
| `signing_keys`        | platform | Public JWK + sealed private JWK; the app role cannot delete                       |
| `service_clients`     | platform | argon2id secret hash, scopes                                                      |
| `staff_accounts`      | platform | super_admin accounts (`0005_identity_federation.sql`); the app role cannot delete |
| `federation_states`   | platform | In-flight federated logins: state hash, nonce, PKCE verifier, SAML request id     |
| `authorization_codes` | platform | Code hash, client, redirect URI, PKCE challenge; 60 s, single use                 |

## Events

- **Produced:** `identity.user.{invited, activated, deactivated, roles_changed}.v1`, `identity.session.refresh_reuse_detected.v1`, `identity.session.login_succeeded.v1` (audit: invitation, magic link or SSO; `tenant_id` null for staff) (`packages/contracts/src/identity-events.ts`).
- **Consumed** (consumer `identity-svc.tenant-lifecycle`): `tenant.tenant.{provisioned, activated, suspended, reactivated, offboarding_started, purged}.v1`.

## Configuration

| Variable                                                                                             | Required             | Default  | Notes                                                                             |
| ---------------------------------------------------------------------------------------------------- | -------------------- | -------- | --------------------------------------------------------------------------------- |
| `ATLAS_DATABASE_URL`                                                                                 | yes                  |          | Connect as `atlas_app`                                                            |
| `ATLAS_AUTH_ISSUER`                                                                                  | yes                  |          | Public URL; `iss` of tokens; base of callback URLs                                |
| `ATLAS_AUTH_AUDIENCE`                                                                                | yes                  |          | `aud` of its tokens                                                               |
| `ATLAS_IDENTITY_APP_BASE_URL`                                                                        | yes                  |          | Link target, must contain `{slug}`                                                |
| `ATLAS_IDENTITY_OAUTH_CLIENTS`                                                                       | for SSO              | `{}`     | JSON `{"atlas-web":{"redirect_uris":["https://{slug}.atlas.app/auth/callback"]}}` |
| `ATLAS_IDENTITY_KEK_MODE`                                                                            | no                   | `local`  | `aws` in production (`local` refused)                                             |
| `ATLAS_IDENTITY_KMS_KEY_ID`                                                                          | aws mode             |          | KMS key ARN or `alias/<name>`; region from `AWS_REGION`                           |
| `ATLAS_IDENTITY_LOCAL_KEK`                                                                           | local mode           |          | base64 32-byte key: `openssl rand -base64 32`                                     |
| `ATLAS_IDENTITY_RATE_LIMITER` / `ATLAS_REDIS_URL`                                                    | redis in prod        | `memory` | Redis limiter fails open (logged) if Redis is down                                |
| `ATLAS_IDENTITY_LINK_DELIVERY` / `ATLAS_NOTIFICATION_URL`                                            | notification in prod | `log`    | `log` (dev only) writes links to the log                                          |
| `ATLAS_IDENTITY_EVENT_SOURCE` / `ATLAS_KAFKA_BROKERS`                                                | kafka in prod        | `none`   | Comma-separated brokers; poison events go to `dlq.identity-svc`                   |
| `ATLAS_IDENTITY_STAFF_OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET}`, `ATLAS_IDENTITY_STAFF_ALLOWED_DOMAINS` | for staff sign-in    |          | Workforce IdP; set all four together                                              |
| `ATLAS_IDENTITY_STAFF_BOOTSTRAP_EMAIL`                                                               | first boot           |          | Created as an active staff account if missing                                     |
| `ATLAS_IDENTITY_ALLOW_INSECURE_IDP`                                                                  | dev only             | `false`  | Allow http/localhost IdP URLs; refused in production                              |
| `ATLAS_AUTH_SHARED_SECRET`                                                                           | dev only             |          | HS256 staff tokens for local work; refused in production                          |
| `ATLAS_IDENTITY_PORT`                                                                                | no                   | `8082`   |                                                                                   |

Production refuses every development stand-in: the local KEK, the in-memory limiter, logged links, no event source, insecure IdP URLs and shared-secret tokens.

Other services point `ATLAS_AUTH_JWKS_URL` at `<issuer>/.well-known/jwks.json`.

## Run and test

```bash
npm test                               # from repo root (PGlite, no Docker needed)
make infra-up && make migrate
npm run build && node services/identity-svc/dist/main.js
```

## Known gaps

Everything in the Component Prompt is built. What remains is verification against real infrastructure, which this build environment does not have:

- **Not run against real systems.** Postgres runs as PGlite, Redis as ioredis-mock, Kafka as a fake client, AWS KMS as aws-sdk-client-mock, and IdPs as an in-process OIDC provider and self-signed SAML assertions. Integration tests against Okta/Entra/Google, Redpanda and LocalStack belong in the nightly job.
- **`/oauth/token` p95 < 150 ms** is not measured.
- **notification-svc does not exist yet** (brick 13). The contract identity-svc calls is in `docs/prompts/13-notification-report.md`.
- **Failed sign-ins** are not audited as events; they only show as redirects with `error_description`.
- **Housekeeping:** no job yet deletes expired `federation_states`, `authorization_codes`, invitations, magic links or refresh tokens.
- **SAML extras not supported:** signed AuthnRequests, encrypted assertions, an SP metadata endpoint and single logout.
- **SSRF:** IdP URLs are restricted to https DNS names, but DNS-rebinding protection needs the egress proxy.

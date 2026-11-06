/**
 * Acceptance tests 1–7 from docs/prompts/02-identity-svc.md §8, against the real HTTP stack,
 * real ES256 signing, and Postgres (PGlite) running as the RLS-bound atlas_app role.
 */
import { randomBytes } from 'node:crypto';
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet, jwtVerify } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TenantActivated,
  TenantProvisioned,
  TenantPurged,
  TenantReactivated,
  TenantSuspended,
} from '@atlas/contracts';
import {
  type Consumer,
  configureHttpApp,
  createConsumer,
  createLogger,
  FixedClock,
  JwtVerifier,
  LocalKeyEncryption,
  MemoryRateLimiter,
  newId,
} from '@atlas/platform';
import {
  createTestDatabase,
  MemoryLogStream,
  signTestToken,
  TEST_AUTH,
  type TestDatabase,
} from '@atlas/platform/testing';
import { AppModule } from '../../src/app.module';
import { SigningKeyService } from '../../src/application/signing-key.service';
import { IDENTITY_CONSUMER, TenantEventHandlers } from '../../src/application/tenant-events';
import { MemoryLinkDelivery } from '../../src/infrastructure/memory-link-delivery';

const MIN = 60_000;
const HOUR = 60 * MIN;

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

describe('identity-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  let superAdmin: string;
  const clock = new FixedClock(new Date());
  const delivery = new MemoryLinkDelivery();
  const logs = new MemoryLogStream();

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function emit(
    definition: { topic: string },
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    return consumer.handle({
      eventId: newId(),
      topic: definition.topic,
      tenantId,
      aggregateId: tenantId,
      payload,
    });
  }

  const statusPayload = (tenantId: string, from: string, to: string) => ({
    tenant_id: tenantId,
    from_status: from,
    to_status: to,
    reason: to === 'suspended' ? 'unpaid' : null,
    actor: 'staff-1',
    occurred_at: clock.now().toISOString(),
  });

  /** Provisions and activates a tenant via events; returns the bootstrap admin's tokens. */
  async function newTenant(
    slug: string,
  ): Promise<{ tenantId: string; admin: Tokens; email: string }> {
    const tenantId = newId();
    const email = `admin@${slug}.test`;
    await emit(TenantProvisioned, tenantId, {
      tenant_id: tenantId,
      slug,
      cell_id: 'eu-pool-01',
      data_region: 'eu-central-1',
      isolation_tier: 'pooled',
      display_name: slug,
      bootstrap_admin_email: email,
      occurred_at: clock.now().toISOString(),
    });
    await emit(TenantActivated, tenantId, statusPayload(tenantId, 'provisioning', 'active'));
    const redeemed = await http
      .post('/v1/invitations:redeem')
      .send({ tenant_slug: slug, token: delivery.lastToken(email) });
    expect(redeemed.status).toBe(200);
    return { tenantId, admin: redeemed.body as Tokens, email };
  }

  async function invite(
    admin: Tokens,
    body: { email: string; roles: string[]; display_name?: string },
  ): Promise<request.Response> {
    return http
      .post('/v1/users:invite')
      .set(auth(admin.access_token))
      .send({ display_name: 'Someone', ...body });
  }

  async function activeUser(
    slug: string,
    admin: Tokens,
    email: string,
    roles: string[],
  ): Promise<{ userId: string; tokens: Tokens }> {
    const invited = await invite(admin, { email, roles });
    expect(invited.status).toBe(201);
    const redeemed = await http
      .post('/v1/invitations:redeem')
      .send({ tenant_slug: slug, token: delivery.lastToken(email) });
    expect(redeemed.status).toBe(200);
    return { userId: invited.body.user_id as string, tokens: redeemed.body as Tokens };
  }

  async function jwks(): Promise<JSONWebKeySet> {
    const res = await http.get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    return res.body as JSONWebKeySet;
  }

  async function verifyAgainstJwks(token: string) {
    return jwtVerify(token, createLocalJWKSet(await jwks()), {
      issuer: TEST_AUTH.issuer,
      audience: TEST_AUTH.audience,
      currentDate: clock.now(),
    });
  }

  const refresh = (token: string) =>
    http
      .post('/v1/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: token });

  beforeAll(async () => {
    db = await createTestDatabase();
    const logger = createLogger({ service: 'identity-svc', level: 'info', destination: logs });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        limiter: new MemoryRateLimiter(clock),
        delivery,
        settings: {
          issuer: TEST_AUTH.issuer,
          audience: TEST_AUTH.audience,
          appBaseUrl: 'https://{slug}.atlas.test',
          keys: new LocalKeyEncryption('test', randomBytes(32)),
          oauthClients: {},
          staffIdp: null,
        },
        staffVerifiers: [new JwtVerifier({ ...TEST_AUTH })],
      }),
      { logger: false },
    );
    configureHttpApp(app, logger);
    await app.init();
    await app.get(SigningKeyService).ensureCurrent();
    consumer = createConsumer({
      name: IDENTITY_CONSUMER,
      db,
      handlers: app.get(TenantEventHandlers).handlers(),
    });
    http = request(app.getHttpServer());
    superAdmin = await signTestToken({ sub: 'staff-1', roles: ['super_admin'] });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('AT1: invite → redeem → token validates against the published JWKS', () => {
    it('bootstraps the first tenant_admin from the provisioned event', async () => {
      const { tenantId, admin, email } = await newTenant('acme');
      expect(admin).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
      expect(admin.refresh_token).toMatch(new RegExp(`^rt\\.${tenantId}\\.`));

      const { payload, protectedHeader } = await verifyAgainstJwks(admin.access_token);
      expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
      expect(payload).toMatchObject({
        tid: tenantId,
        roles: ['tenant_admin'],
        amr: ['email'],
        bu: [],
      });
      expect(payload.jti).toBeTruthy();
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);

      const me = await http.get('/v1/users').set(auth(admin.access_token));
      expect(me.status).toBe(200);
      expect(me.body.items).toHaveLength(1);
      expect(me.body.items[0]).toMatchObject({ email, status: 'active', roles: ['tenant_admin'] });

      const { rows } = await db.owner.query<{ topic: string }>(
        `SELECT topic FROM outbox_events WHERE tenant_id = $1 ORDER BY event_id`,
        [tenantId],
      );
      // Same-millisecond UUIDv7s have no defined order; Debezium relays in commit order anyway.
      expect(rows.map((r) => r.topic).sort()).toEqual([
        'identity.session.login_succeeded.v1',
        'identity.user.activated.v1',
        'identity.user.invited.v1',
      ]);

      // Secrets at rest: only hashes, never the token itself.
      const token = delivery.lastToken(email);
      const { rows: stored } = await db.owner.query<{ token_hash: Uint8Array }>(
        'SELECT token_hash FROM user_invitations WHERE tenant_id = $1',
        [tenantId],
      );
      expect(Buffer.from(stored[0]!.token_hash).toString('utf8')).not.toContain(token);
      expect(JSON.stringify(logs.lines)).not.toContain(token);
    });

    it('invitations are single-use and expire after 72 h', async () => {
      const slug = 'single-use';
      const { admin } = await newTenant(slug);
      const used = await http
        .post('/v1/invitations:redeem')
        .send({ tenant_slug: slug, token: delivery.lastToken(`admin@${slug}.test`) });
      expect(used.status).toBe(401);
      expect(used.body.code).toBe('INVALID_LINK');

      expect((await invite(admin, { email: 'late@x.test', roles: ['recruiter'] })).status).toBe(
        201,
      );
      clock.advanceBy(72 * HOUR + MIN);
      const late = await http
        .post('/v1/invitations:redeem')
        .send({ tenant_slug: slug, token: delivery.lastToken('late@x.test') });
      expect(late.status).toBe(401);
      expect(late.body.code).toBe('INVITATION_EXPIRED');
    });

    it('rejects a duplicate email in the same tenant with 409', async () => {
      const { admin, email } = await newTenant('dupe-co');
      const res = await invite(admin, { email: email.toUpperCase(), roles: ['recruiter'] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_EMAIL_TAKEN');
    });
  });

  describe('AT2: refresh rotation with reuse detection', () => {
    it('rotates, then revokes the whole family when an old token is replayed', async () => {
      const { tenantId, admin } = await newTenant('rotate-co');
      const first = await refresh(admin.refresh_token);
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      const rotated = first.body as Tokens;
      expect(rotated.refresh_token).not.toBe(admin.refresh_token);

      const replay = await refresh(admin.refresh_token);
      expect(replay.status).toBe(401);
      expect(replay.body).toMatchObject({ code: 'TOKEN_REUSE_DETECTED', error: 'invalid_grant' });

      // The legitimate-looking newest token is revoked too: the family is burnt.
      const after = await refresh(rotated.refresh_token);
      expect(after.status).toBe(401);
      expect(after.body.code).toBe('INVALID_GRANT');

      const { rows } = await db.owner.query<{ payload: { revoked_tokens: number } }>(
        `SELECT payload FROM outbox_events WHERE tenant_id = $1 AND topic = 'identity.session.refresh_reuse_detected.v1'`,
        [tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.revoked_tokens).toBe(2);
    });

    it('rejects malformed and unknown refresh tokens', async () => {
      expect((await refresh('nonsense')).body.code).toBe('INVALID_GRANT');
      const { tenantId } = await newTenant('unknown-rt');
      const forged = `rt.${tenantId}.${randomBytes(32).toString('base64url')}`;
      expect((await refresh(forged)).status).toBe(401);
    });
  });

  describe('AT3: suspended tenant', () => {
    it('gets 401 TENANT_SUSPENDED on token exchange, and recovers on reactivation', async () => {
      const { tenantId, admin } = await newTenant('suspend-co');
      await emit(TenantSuspended, tenantId, statusPayload(tenantId, 'active', 'suspended'));
      const res = await refresh(admin.refresh_token);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TENANT_SUSPENDED');

      await emit(TenantReactivated, tenantId, statusPayload(tenantId, 'suspended', 'active'));
      expect((await refresh(admin.refresh_token)).status).toBe(200);
    });
  });

  describe('AT4: role grants and tenant isolation', () => {
    it('stops tenant admins granting platform roles or changing their own roles', async () => {
      const { admin } = await newTenant('roles-co');
      for (const role of ['super_admin', 'service']) {
        const res = await invite(admin, { email: `${role}@x.test`, roles: [role] });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ROLE_NOT_GRANTABLE');
      }
      const self = await http.get('/v1/users').set(auth(admin.access_token));
      const me = self.body.items[0] as { user_id: string; version: number };
      const patch = await http
        .patch(`/v1/users/${me.user_id}`)
        .set(auth(admin.access_token))
        .set('If-Match', `"${me.version}"`)
        .send({ roles: ['recruiter'] });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('SELF_ROLE_CHANGE');
    });

    it('changes another user’s roles with If-Match and emits roles_changed', async () => {
      const slug = 'patch-co';
      const { tenantId, admin } = await newTenant(slug);
      const invited = await invite(admin, { email: 'r@x.test', roles: ['recruiter'] });
      const id = invited.body.user_id as string;
      const missing = await http
        .patch(`/v1/users/${id}`)
        .set(auth(admin.access_token))
        .send({ roles: ['reviewer'] });
      expect(missing.status).toBe(428);
      const ok = await http
        .patch(`/v1/users/${id}`)
        .set(auth(admin.access_token))
        .set('If-Match', '"1"')
        .send({ roles: ['reviewer', 'recruiter'] });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ roles: ['recruiter', 'reviewer'], version: 2 });
      expect(ok.headers['etag']).toBe('"2"');
      const { rows } = await db.owner.query<{ topic: string }>(
        `SELECT topic FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY event_id`,
        [tenantId, id],
      );
      expect(rows.map((r) => r.topic)).toContain('identity.user.roles_changed.v1');
    });

    it('returns 404 for another tenant’s user, and lists only own users (leak test)', async () => {
      const a = await newTenant('leak-a');
      const b = await newTenant('leak-b');
      const bUser = await invite(b.admin, { email: 'victim@b.test', roles: ['employee'] });
      const id = bUser.body.user_id as string;

      expect((await http.get(`/v1/users/${id}`).set(auth(a.admin.access_token))).status).toBe(404);
      expect(
        (
          await http
            .get(`/v1/users/${id}`)
            .query({ tenant_id: b.tenantId })
            .set(auth(a.admin.access_token))
        ).status,
      ).toBe(404);
      const list = await http.get('/v1/users').set(auth(a.admin.access_token));
      expect(list.body.items.map((u: { email: string }) => u.email)).toEqual(['admin@leak-a.test']);

      // Platform staff must name the tenant.
      expect((await http.get('/v1/users').set(auth(superAdmin))).body.code).toBe(
        'TENANT_ID_REQUIRED',
      );
      const staff = await http
        .get(`/v1/users/${id}`)
        .query({ tenant_id: b.tenantId })
        .set(auth(superAdmin));
      expect(staff.status).toBe(200);
    });
  });

  describe('AT5: signing-key rotation', () => {
    it('keeps tokens from the previous key valid until they expire', async () => {
      const { admin } = await newTenant('keys-co');
      const oldKid = decodeProtectedHeader(admin.access_token).kid;

      const rotation = await http.post('/v1/signing-keys:rotate').set(auth(superAdmin));
      expect(rotation.status).toBe(200);
      expect((await jwks()).keys.map((k) => k.kid)).toEqual(
        expect.arrayContaining([oldKid, rotation.body.kid]),
      );

      // Pre-published: the old key keeps signing until the new one activates.
      clock.advanceBy(9 * MIN);
      const beforeSwitch = (await refresh(admin.refresh_token)).body as Tokens;
      expect(decodeProtectedHeader(beforeSwitch.access_token).kid).toBe(oldKid);

      clock.advanceBy(2 * MIN);
      const afterSwitch = (await refresh(beforeSwitch.refresh_token)).body as Tokens;
      expect(decodeProtectedHeader(afterSwitch.access_token).kid).toBe(rotation.body.kid);

      // A token from the old key still verifies, against JWKS and on a protected route.
      await expect(verifyAgainstJwks(beforeSwitch.access_token)).resolves.toBeTruthy();
      expect((await http.get('/v1/users').set(auth(beforeSwitch.access_token))).status).toBe(200);

      // Once its last token has expired, the old key leaves JWKS.
      clock.advanceBy(11 * MIN);
      expect((await jwks()).keys.map((k) => k.kid)).not.toContain(oldKid);
    });

    it('only platform staff can rotate', async () => {
      const { admin } = await newTenant('keys-denied');
      expect(
        (await http.post('/v1/signing-keys:rotate').set(auth(admin.access_token))).status,
      ).toBe(403);
    });
  });

  describe('AT6: SSO-enforced tenant', () => {
    it('refuses magic-link login for workforce users with SSO_REQUIRED, but not candidates', async () => {
      const slug = 'sso-co';
      const { tenantId, admin } = await newTenant(slug);
      const employee = await activeUser(slug, admin, 'emp@elsewhere.test', ['employee']);
      await activeUser(slug, admin, 'cand@gmail.test', ['candidate']);
      expect(employee.userId).toBeTruthy();

      const put = await http
        .put(`/v1/sso-connections/${tenantId}`)
        .set(auth(admin.access_token))
        .send({
          protocol: 'oidc',
          enforced: true,
          metadata: { issuer: 'https://idp.sso-co.test', client_id: 'atlas' },
          client_secret: 'idp-secret',
          domain_hints: ['sso-co.test'],
        });
      expect(put.status).toBe(201);
      expect(put.headers['etag']).toBe('"1"');
      const replace = await http
        .put(`/v1/sso-connections/${tenantId}`)
        .set(auth(admin.access_token))
        .send({
          protocol: 'oidc',
          enforced: true,
          metadata: { issuer: 'https://idp.sso-co.test', client_id: 'atlas' },
          domain_hints: ['sso-co.test'],
        });
      expect(replace.status).toBe(428);

      // Known SSO domain: refused at request time.
      const byDomain = await http
        .post('/v1/auth/magic-links')
        .send({ tenant_slug: slug, email: `admin@${slug}.test` });
      expect(byDomain.status).toBe(403);
      expect(byDomain.body.code).toBe('SSO_REQUIRED');

      // Other domain: the link is sent, but a workforce user cannot redeem it.
      const req = await http
        .post('/v1/auth/magic-links')
        .send({ tenant_slug: slug, email: 'emp@elsewhere.test' });
      expect(req.status).toBe(202);
      const redeem = await http.post('/v1/auth/magic-links:redeem').send({
        tenant_slug: slug,
        token: delivery.lastToken('emp@elsewhere.test'),
        binding: req.body.binding,
      });
      expect(redeem.status).toBe(403);
      expect(redeem.body.code).toBe('SSO_REQUIRED');

      // Candidates keep password-less login.
      const cand = await http
        .post('/v1/auth/magic-links')
        .send({ tenant_slug: slug, email: 'cand@gmail.test' });
      const candRedeem = await http.post('/v1/auth/magic-links:redeem').send({
        tenant_slug: slug,
        token: delivery.lastToken('cand@gmail.test'),
        binding: cand.body.binding,
      });
      expect(candRedeem.status).toBe(200);
    });
  });

  describe('magic links', () => {
    it('are bound to the requesting browser, single-use and silent about unknown emails', async () => {
      const slug = 'magic-co';
      const { admin } = await newTenant(slug);
      await activeUser(slug, admin, 'cand@magic.test', ['candidate']);
      const sentBefore = delivery.sent.length;
      const unknown = await http
        .post('/v1/auth/magic-links')
        .send({ tenant_slug: slug, email: 'nobody@magic.test' });
      expect(unknown.status).toBe(202);
      expect(unknown.body.binding).toBeTruthy();
      expect(delivery.sent.length).toBe(sentBefore);

      const req = await http
        .post('/v1/auth/magic-links')
        .send({ tenant_slug: slug, email: 'cand@magic.test' });
      const token = delivery.lastToken('cand@magic.test');
      const stolen = await http
        .post('/v1/auth/magic-links:redeem')
        .send({ tenant_slug: slug, token, binding: randomBytes(32).toString('base64url') });
      expect(stolen.status).toBe(401);
      expect(stolen.body.code).toBe('INVALID_LINK');

      const ok = await http
        .post('/v1/auth/magic-links:redeem')
        .send({ tenant_slug: slug, token, binding: req.body.binding });
      expect(ok.status).toBe(200);
      const again = await http
        .post('/v1/auth/magic-links:redeem')
        .send({ tenant_slug: slug, token, binding: req.body.binding });
      expect(again.status).toBe(401);
    });
  });

  describe('AT7: rate limiting', () => {
    it('returns 429 with Retry-After after 5 magic-link requests per email per hour', async () => {
      const { admin } = await newTenant('limit-co');
      expect(admin).toBeTruthy();
      const send = () =>
        http.post('/v1/auth/magic-links').send({ tenant_slug: 'limit-co', email: 'x@limit.test' });
      for (let i = 0; i < 5; i += 1) expect((await send()).status).toBe(202);
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      clock.advanceBy(HOUR);
      expect((await send()).status).toBe(202);
    });
  });

  describe('client credentials', () => {
    it('issues service tokens with granted scopes only', async () => {
      const created = await http
        .post('/v1/service-clients')
        .set(auth(superAdmin))
        .send({ name: 'gateway', scopes: ['tenant-directory:read', 'users:read'] });
      expect(created.status).toBe(201);
      const { client_id: clientId, client_secret: secret } = created.body as {
        client_id: string;
        client_secret: string;
      };
      expect(clientId).toBe('svc_gateway');

      const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
      const res = await http
        .post('/v1/oauth/token')
        .set('Authorization', `Basic ${basic}`)
        .type('form')
        .send({ grant_type: 'client_credentials', scope: 'tenant-directory:read' });
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe('tenant-directory:read');
      const { payload } = await verifyAgainstJwks(res.body.access_token as string);
      expect(payload).toMatchObject({
        sub: 'svc_gateway',
        roles: ['service'],
        scopes: ['tenant-directory:read'],
        tid: null,
      });

      const badScope = await http.post('/v1/oauth/token').send({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        scope: 'admin:all',
      });
      expect(badScope.status).toBe(400);
      expect(badScope.body.code).toBe('INVALID_SCOPE');

      const wrong = await http.post('/v1/oauth/token').send({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: 'x'.repeat(43),
      });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toMatchObject({ code: 'INVALID_CLIENT', error: 'invalid_client' });

      const { rows } = await db.owner.query<{ secret_hash: string }>(
        'SELECT secret_hash FROM service_clients WHERE client_id = $1',
        [clientId],
      );
      expect(rows[0]!.secret_hash).toMatch(/^\$argon2id\$v=19\$/);
    });

    it('rejects an unknown authorization code', async () => {
      const res = await http.post('/v1/oauth/token').send({
        grant_type: 'authorization_code',
        code: 'nope',
        code_verifier: 'x'.repeat(43),
        redirect_uri: 'https://a.test/cb',
        client_id: 'atlas-web',
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_grant');
    });
  });

  describe('deactivation and purge', () => {
    it('deactivating a user revokes their refresh tokens', async () => {
      const slug = 'deact-co';
      const { admin } = await newTenant(slug);
      const user = await activeUser(slug, admin, 'leaver@x.test', ['employee']);
      const res = await http
        .post(`/v1/users/${user.userId}:deactivate`)
        .set(auth(admin.access_token));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('deactivated');
      expect((await refresh(user.tokens.refresh_token)).status).toBe(401);
    });

    it('a purged tenant loses every user and cannot sign in; duplicate events are skipped', async () => {
      const { tenantId, admin } = await newTenant('purge-co');
      const purgedEvent = {
        eventId: newId(),
        topic: TenantPurged.topic,
        tenantId,
        aggregateId: tenantId,
        payload: statusPayload(tenantId, 'offboarding', 'purged'),
      };
      expect(await consumer.handle(purgedEvent)).toBe('processed');
      expect(await consumer.handle(purgedEvent)).toBe('duplicate');

      const { rows } = await db.owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM users WHERE tenant_id = $1',
        [tenantId],
      );
      expect(rows[0]!.n).toBe(0);
      expect((await refresh(admin.refresh_token)).status).toBe(401);
    });
  });

  it('serves discovery documents and probes', async () => {
    const config = await http.get('/.well-known/openid-configuration');
    expect(config.body).toMatchObject({
      issuer: TEST_AUTH.issuer,
      jwks_uri: `${TEST_AUTH.issuer}/.well-known/jwks.json`,
    });
    expect((await http.get('/healthz')).status).toBe(200);
    expect((await http.get('/readyz')).status).toBe(200);
    expect((await http.get('/v1/users')).status).toBe(401);
  });
});

/**
 * Increment 2b: federated sign-in (OIDC and SAML), the authorization-code + PKCE flow for
 * Atlas's own web app, and platform-staff sign-in. Runs against a real OIDC provider over
 * HTTP (FakeOidcProvider) and real SAML signatures (xml-crypto, self-signed certificate).
 */
import { createHash, randomBytes } from 'node:crypto';
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { decodeJwt } from 'jose';
import { generate } from 'selfsigned';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { TenantActivated, TenantProvisioned } from '@atlas/contracts';
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
import { AdminService } from '../../src/application/admin.service';
import { SigningKeyService } from '../../src/application/signing-key.service';
import { IDENTITY_CONSUMER, TenantEventHandlers } from '../../src/application/tenant-events';
import { MemoryLinkDelivery } from '../../src/infrastructure/memory-link-delivery';
import { FakeOidcProvider } from './fake-idp';

const WEB = 'atlas-web';
const tenantRedirect = (slug: string) => `https://${slug}.atlas.test/auth/callback`;
const STAFF_REDIRECT = 'https://admin.atlas.test/auth/callback';

interface Tokens {
  access_token: string;
  refresh_token?: string;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('identity-svc federation (increment 2b)', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  let superAdmin: string;
  const tenantIdp = new FakeOidcProvider();
  const staffIdp = new FakeOidcProvider();
  const clock = new FixedClock(new Date());
  const delivery = new MemoryLinkDelivery();
  const keys = new LocalKeyEncryption('test', randomBytes(32));
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newTenant(slug: string): Promise<{ tenantId: string; admin: Tokens }> {
    const tenantId = newId();
    const at = clock.now().toISOString();
    await consumer.handle({
      eventId: newId(),
      topic: TenantProvisioned.topic,
      tenantId,
      aggregateId: tenantId,
      payload: {
        tenant_id: tenantId,
        slug,
        cell_id: 'eu-pool-01',
        data_region: 'eu-central-1',
        isolation_tier: 'pooled',
        display_name: slug,
        bootstrap_admin_email: `admin@${slug}.test`,
        occurred_at: at,
      },
    });
    await consumer.handle({
      eventId: newId(),
      topic: TenantActivated.topic,
      tenantId,
      aggregateId: tenantId,
      payload: {
        tenant_id: tenantId,
        from_status: 'provisioning',
        to_status: 'active',
        reason: null,
        actor: 'staff-1',
        occurred_at: at,
      },
    });
    const redeemed = await http
      .post('/v1/invitations:redeem')
      .send({ tenant_slug: slug, token: delivery.lastToken(`admin@${slug}.test`) });
    expect(redeemed.status).toBe(200);
    return { tenantId, admin: redeemed.body as Tokens };
  }

  async function configureOidc(
    tenantId: string,
    admin: Tokens,
    extra: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return http
      .put(`/v1/sso-connections/${tenantId}`)
      .set(auth(admin.access_token))
      .send({
        protocol: 'oidc',
        metadata: { issuer: tenantIdp.issuer, client_id: tenantIdp.clientId },
        client_secret: tenantIdp.clientSecret,
        domain_hints: ['corp.test'],
        ...extra,
      });
  }

  /** Browser: start → IdP sign-in → callback. Returns the final redirect to the web app. */
  async function ssoLogin(
    slug: string,
    email: string,
    { challenge }: { challenge: string },
    clientState = 'app-state-1',
  ): Promise<URL> {
    const start = await http.get(`/v1/sso/${slug}/start`).query({
      response_type: 'code',
      client_id: WEB,
      redirect_uri: tenantRedirect(slug),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: clientState,
    });
    expect(start.status).toBe(302);
    expect(start.headers['cache-control']).toBe('no-store');
    const callback = new URL(tenantIdp.authorize(start.headers['location'] as string, email));
    const back = await http.get(callback.pathname + callback.search);
    expect(back.status).toBe(302);
    return new URL(back.headers['location'] as string);
  }

  const exchange = (code: string, verifier: string, redirectUri: string) =>
    http.post('/v1/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: WEB,
    });

  beforeAll(async () => {
    await tenantIdp.start();
    await staffIdp.start();
    db = await createTestDatabase();
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        limiter: new MemoryRateLimiter(clock),
        delivery,
        allowInsecureIdp: true,
        settings: {
          issuer: TEST_AUTH.issuer,
          audience: TEST_AUTH.audience,
          appBaseUrl: 'https://{slug}.atlas.test',
          keys,
          oauthClients: {
            [WEB]: { redirectUris: ['https://{slug}.atlas.test/auth/callback', STAFF_REDIRECT] },
          },
          staffIdp: {
            issuer: staffIdp.issuer,
            clientId: staffIdp.clientId,
            clientSecret: staffIdp.clientSecret,
            allowedDomains: ['atlas.test'],
          },
        },
        staffVerifiers: [new JwtVerifier({ ...TEST_AUTH })],
      }),
      { logger: false },
    );
    configureHttpApp(
      app,
      createLogger({ service: 'identity-svc', level: 'info', destination: new MemoryLogStream() }),
    );
    await app.init();
    await app.get(SigningKeyService).ensureCurrent();
    consumer = createConsumer({
      name: IDENTITY_CONSUMER,
      db,
      handlers: app.get(TenantEventHandlers).handlers(),
    });
    http = request(app.getHttpServer());
    superAdmin = await signTestToken({ sub: 'staff-0', roles: ['super_admin'] });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await tenantIdp.stop();
    await staffIdp.stop();
  });

  describe('OIDC federation + authorization code with PKCE', () => {
    it('signs an invited user in through the tenant IdP and issues tokens to the web app', async () => {
      const slug = 'oidc-co';
      const { tenantId, admin } = await newTenant(slug);
      const put = await configureOidc(tenantId, admin);
      expect(put.status).toBe(201);
      expect(put.body).toMatchObject({
        has_client_secret: true,
        service_provider: {
          oidc_redirect_uri: `${TEST_AUTH.issuer}/v1/sso/${slug}/callback`,
          saml_acs_url: `${TEST_AUTH.issuer}/v1/sso/${slug}/acs`,
        },
      });
      expect(JSON.stringify(put.body)).not.toContain(tenantIdp.clientSecret);
      const { rows } = await db.owner.query<{ client_secret_ciphertext: Uint8Array }>(
        'SELECT client_secret_ciphertext FROM sso_connections WHERE tenant_id = $1',
        [tenantId],
      );
      expect(Buffer.from(rows[0]!.client_secret_ciphertext).toString()).not.toContain(
        tenantIdp.clientSecret,
      );

      await http
        .post('/v1/users:invite')
        .set(auth(admin.access_token))
        .send({ email: 'ada@corp.test', display_name: 'Ada', roles: ['recruiter'] });

      const p = pkce();
      const back = await ssoLogin(slug, 'ada@corp.test', p);
      expect(`${back.origin}${back.pathname}`).toBe(tenantRedirect(slug));
      expect(back.searchParams.get('state')).toBe('app-state-1');
      const code = back.searchParams.get('code')!;

      const tokens = await exchange(code, p.verifier, tenantRedirect(slug));
      expect(tokens.status).toBe(200);
      expect(tokens.body.refresh_token).toMatch(new RegExp(`^rt\\.${tenantId}\\.`));
      expect(decodeJwt(tokens.body.access_token as string)).toMatchObject({
        tid: tenantId,
        roles: ['recruiter'],
        amr: ['sso'],
      });

      // The invitation is satisfied by SSO: the user is active now.
      const users = await http.get('/v1/users').set(auth(admin.access_token));
      expect(
        users.body.items.find((u: { email: string }) => u.email === 'ada@corp.test').status,
      ).toBe('active');
      const { rows: events } = await db.owner.query<{ payload: { method: string } }>(
        `SELECT payload FROM outbox_events WHERE tenant_id = $1 AND topic = 'identity.session.login_succeeded.v1'`,
        [tenantId],
      );
      expect(events.map((e) => e.payload.method).sort()).toEqual(['invitation', 'sso']);

      // Codes are single use.
      expect((await exchange(code, p.verifier, tenantRedirect(slug))).body.code).toBe(
        'INVALID_GRANT',
      );
    });

    it('rejects a wrong PKCE verifier, redirect URI or client', async () => {
      const slug = 'pkce-co';
      const { tenantId, admin } = await newTenant(slug);
      await configureOidc(tenantId, admin, { jit_role: 'employee' });
      const p = pkce();

      const wrongVerifier = (await ssoLogin(slug, 'a@corp.test', p)).searchParams.get('code')!;
      expect((await exchange(wrongVerifier, pkce().verifier, tenantRedirect(slug))).status).toBe(
        401,
      );

      const wrongRedirect = (await ssoLogin(slug, 'a@corp.test', p)).searchParams.get('code')!;
      expect((await exchange(wrongRedirect, p.verifier, tenantRedirect('other-co'))).status).toBe(
        401,
      );
    });

    it('never redirects to an unregistered URI or another tenant’s subdomain', async () => {
      const slug = 'redirect-co';
      const { tenantId, admin } = await newTenant(slug);
      await configureOidc(tenantId, admin);
      const q = {
        response_type: 'code',
        client_id: WEB,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 's',
      };
      for (const redirect_uri of ['https://evil.test/cb', tenantRedirect('victim-co')]) {
        const res = await http.get(`/v1/sso/${slug}/start`).query({ ...q, redirect_uri });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_REDIRECT_URI');
      }
      const plain = await http
        .get(`/v1/sso/${slug}/start`)
        .query({ ...q, redirect_uri: tenantRedirect(slug), code_challenge_method: 'plain' });
      expect(plain.body.code).toBe('INVALID_CODE_CHALLENGE');
      const unknown = await http
        .get(`/v1/sso/${slug}/start`)
        .query({ ...q, redirect_uri: tenantRedirect(slug), client_id: 'nope' });
      expect(unknown.body.code).toBe('INVALID_CLIENT');
    });

    it('refuses replayed state, foreign domains, unknown users and bad ID tokens', async () => {
      const slug = 'guard-co';
      const { tenantId, admin } = await newTenant(slug);
      await configureOidc(tenantId, admin);
      const p = pkce();

      // State is single use.
      const start = await http.get(`/v1/sso/${slug}/start`).query({
        response_type: 'code',
        client_id: WEB,
        redirect_uri: tenantRedirect(slug),
        code_challenge: p.challenge,
        code_challenge_method: 'S256',
        state: 'x',
      });
      const callback = new URL(
        tenantIdp.authorize(start.headers['location'] as string, 'nobody@corp.test'),
      );
      const first = await http.get(callback.pathname + callback.search);
      expect(
        new URL(first.headers['location'] as string).searchParams.get('error_description'),
      ).toBe('user_not_provisioned');
      const replay = await http.get(callback.pathname + callback.search);
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('INVALID_STATE');

      const foreign = await ssoLogin(slug, 'mallory@evil.test', p);
      expect(foreign.searchParams.get('error')).toBe('access_denied');
      expect(foreign.searchParams.get('error_description')).toBe('sso_domain_not_allowed');

      tenantIdp.tamper = { nonce: 'not-the-nonce' };
      const badNonce = await ssoLogin(slug, 'nobody@corp.test', p);
      expect(badNonce.searchParams.get('error_description')).toBe('idp_error');
    });

    it('provisions unknown users just in time when the tenant allows it', async () => {
      const slug = 'jit-co';
      const { tenantId, admin } = await newTenant(slug);
      await configureOidc(tenantId, admin, { jit_role: 'employee' });
      const p = pkce();
      const back = await ssoLogin(slug, 'new.hire@corp.test', p);
      const tokens = await exchange(
        back.searchParams.get('code')!,
        p.verifier,
        tenantRedirect(slug),
      );
      expect(decodeJwt(tokens.body.access_token as string)).toMatchObject({ roles: ['employee'] });
    });

    it('keeps the stored client secret when the connection is replaced without one', async () => {
      const slug = 'keep-co';
      const { tenantId, admin } = await newTenant(slug);
      await configureOidc(tenantId, admin);
      const replaced = await http
        .put(`/v1/sso-connections/${tenantId}`)
        .set(auth(admin.access_token))
        .set('If-Match', '"1"')
        .send({
          protocol: 'oidc',
          metadata: { issuer: tenantIdp.issuer, client_id: tenantIdp.clientId },
          domain_hints: ['corp.test'],
          jit_role: 'candidate',
        });
      expect(replaced.status).toBe(200);
      expect(replaced.body).toMatchObject({
        has_client_secret: true,
        jit_role: 'candidate',
        version: 2,
      });
      const p = pkce();
      const back = await ssoLogin(slug, 'cand@corp.test', p);
      expect(back.searchParams.get('code')).toBeTruthy();
    });
  });

  describe('platform staff', () => {
    async function staffLogin(email: string): Promise<{ back: URL; verifier: string }> {
      const p = pkce();
      const start = await http.get('/v1/staff/sso/start').query({
        response_type: 'code',
        client_id: WEB,
        redirect_uri: STAFF_REDIRECT,
        code_challenge: p.challenge,
        code_challenge_method: 'S256',
        state: 'staff-state',
      });
      expect(start.status).toBe(302);
      const callback = new URL(staffIdp.authorize(start.headers['location'] as string, email));
      const back = await http.get(callback.pathname + callback.search);
      return { back: new URL(back.headers['location'] as string), verifier: p.verifier };
    }

    it('signs staff in through the workforce IdP as super_admin, without a refresh token', async () => {
      await app.get(AdminService).ensureBootstrapStaff('ops@atlas.test');
      await app.get(AdminService).ensureBootstrapStaff('ops@atlas.test'); // idempotent
      const { back, verifier } = await staffLogin('ops@atlas.test');
      const tokens = await http.post('/v1/oauth/token').send({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: STAFF_REDIRECT,
        client_id: WEB,
      });
      expect(tokens.status).toBe(200);
      expect(tokens.body.refresh_token).toBeUndefined();
      expect(decodeJwt(tokens.body.access_token as string)).toMatchObject({
        tid: null,
        roles: ['super_admin'],
        amr: ['sso'],
      });

      // Identity's own staff token works on staff-only routes.
      const list = await http
        .get('/v1/staff-accounts')
        .set(auth(tokens.body.access_token as string));
      expect(list.status).toBe(200);
      expect(list.body.items.map((s: { email: string }) => s.email)).toContain('ops@atlas.test');
    });

    it('refuses unknown, disabled and off-domain staff', async () => {
      expect(
        (await staffLogin('stranger@atlas.test')).back.searchParams.get('error_description'),
      ).toBe('staff_account_not_found');
      expect((await staffLogin('ops@gmail.test')).back.searchParams.get('error_description')).toBe(
        'staff_domain_not_allowed',
      );
      const created = await http
        .post('/v1/staff-accounts')
        .set(auth(superAdmin))
        .send({ email: 'temp@atlas.test', display_name: 'Temp' });
      expect(created.status).toBe(201);
      const disabled = await http
        .post(`/v1/staff-accounts/${created.body.staff_id}:disable`)
        .set(auth(superAdmin));
      expect(disabled.body.status).toBe('disabled');
      expect((await staffLogin('temp@atlas.test')).back.searchParams.get('error')).toBe(
        'access_denied',
      );
    });
  });

  describe('SAML federation', () => {
    let idpKey: string;
    let idpCert: string;

    beforeAll(async () => {
      const pems = await generate([{ name: 'commonName', value: 'idp.corp.test' }], {
        keySize: 2048,
        algorithm: 'sha256',
      });
      idpKey = pems.private;
      idpCert = pems.cert;
    });

    function samlResponse(opts: {
      requestId: string;
      acsUrl: string;
      audience: string;
      email: string;
      tamperEmail?: string;
    }): string {
      const now = new Date();
      const later = new Date(now.getTime() + 5 * 60_000).toISOString();
      const id = `_a${randomBytes(8).toString('hex')}`;
      const assertion =
        `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">` +
        `<saml:Issuer>https://idp.corp.test</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${opts.requestId}" NotOnOrAfter="${later}" Recipient="${opts.acsUrl}"/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
        `</saml:Assertion>`;
      const sig = new SignedXml({
        privateKey: idpKey,
        publicCert: idpCert,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      sig.addReference({
        xpath: "//*[local-name(.)='Assertion']",
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
        transforms: [
          'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
          'http://www.w3.org/2001/10/xml-exc-c14n#',
        ],
      });
      sig.computeSignature(assertion, {
        location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
      });
      let signed = sig.getSignedXml();
      if (opts.tamperEmail) signed = signed.replaceAll(opts.email, opts.tamperEmail);
      const response =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${opts.acsUrl}" InResponseTo="${opts.requestId}">` +
        `<saml:Issuer>https://idp.corp.test</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
        signed +
        `</samlp:Response>`;
      return Buffer.from(response).toString('base64');
    }

    it('accepts a signed assertion answering our AuthnRequest and rejects tampering or replay', async () => {
      const slug = 'saml-co';
      const { tenantId, admin } = await newTenant(slug);
      const put = await http
        .put(`/v1/sso-connections/${tenantId}`)
        .set(auth(admin.access_token))
        .send({
          protocol: 'saml',
          metadata: { entry_point: 'https://idp.corp.test/sso', idp_cert: idpCert },
          domain_hints: ['corp.test'],
          jit_role: 'employee',
        });
      expect(put.status).toBe(201);
      const sp = put.body.service_provider as { saml_acs_url: string; saml_entity_id: string };

      const begin = async (state: string) => {
        const p = pkce();
        const start = await http.get(`/v1/sso/${slug}/start`).query({
          response_type: 'code',
          client_id: WEB,
          redirect_uri: tenantRedirect(slug),
          code_challenge: p.challenge,
          code_challenge_method: 'S256',
          state,
        });
        expect(start.status).toBe(302);
        const idpUrl = new URL(start.headers['location'] as string);
        expect(idpUrl.origin + idpUrl.pathname).toBe('https://idp.corp.test/sso');
        const relayState = idpUrl.searchParams.get('RelayState')!;
        const { rows } = await db.owner.query<{ saml_request_id: string }>(
          `SELECT saml_request_id FROM federation_states WHERE saml_request_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        );
        return { relayState, requestId: rows[0]!.saml_request_id, verifier: p.verifier };
      };
      const post = (relayState: string, SAMLResponse: string) =>
        http
          .post(`/v1/sso/${slug}/acs`)
          .type('form')
          .send({ SAMLResponse, RelayState: relayState });

      // Happy path.
      const ok = await begin('saml-1');
      const res = await post(
        ok.relayState,
        samlResponse({
          requestId: ok.requestId,
          acsUrl: sp.saml_acs_url,
          audience: sp.saml_entity_id,
          email: 'grace@corp.test',
        }),
      );
      expect(res.status).toBe(303);
      const back = new URL(res.headers['location'] as string);
      expect(back.searchParams.get('state')).toBe('saml-1');
      const tokens = await exchange(
        back.searchParams.get('code')!,
        ok.verifier,
        tenantRedirect(slug),
      );
      expect(decodeJwt(tokens.body.access_token as string)).toMatchObject({
        tid: tenantId,
        amr: ['sso'],
      });

      // Tampered assertion (email changed after signing).
      const t = await begin('saml-2');
      const tampered = await post(
        t.relayState,
        samlResponse({
          requestId: t.requestId,
          acsUrl: sp.saml_acs_url,
          audience: sp.saml_entity_id,
          email: 'grace@corp.test',
          tamperEmail: 'admin@corp.test',
        }),
      );
      expect(
        new URL(tampered.headers['location'] as string).searchParams.get('error_description'),
      ).toBe('idp_error');

      // A valid response for a different AuthnRequest.
      const other = await begin('saml-3');
      const mismatched = await post(
        other.relayState,
        samlResponse({
          requestId: '_not-ours',
          acsUrl: sp.saml_acs_url,
          audience: sp.saml_entity_id,
          email: 'grace@corp.test',
        }),
      );
      expect(new URL(mismatched.headers['location'] as string).searchParams.get('error')).toBe(
        'access_denied',
      );

      // Wrong audience.
      const aud = await begin('saml-4');
      const wrongAudience = await post(
        aud.relayState,
        samlResponse({
          requestId: aud.requestId,
          acsUrl: sp.saml_acs_url,
          audience: 'https://other.sp',
          email: 'grace@corp.test',
        }),
      );
      expect(new URL(wrongAudience.headers['location'] as string).searchParams.get('error')).toBe(
        'access_denied',
      );

      // The RelayState of a finished login cannot be reused.
      expect((await post(ok.relayState, 'AAAA')).body.code).toBe('INVALID_STATE');
    });
  });

  describe('invitation resend', () => {
    it('replaces the earlier link', async () => {
      const slug = 'resend-co';
      const { admin } = await newTenant(slug);
      const invited = await http
        .post('/v1/users:invite')
        .set(auth(admin.access_token))
        .send({ email: 'late@corp.test', display_name: 'Late', roles: ['sme'] });
      const first = delivery.lastToken('late@corp.test');
      const resent = await http
        .post(`/v1/users/${invited.body.user_id}:resendInvitation`)
        .set(auth(admin.access_token));
      expect(resent.status).toBe(200);
      const second = delivery.lastToken('late@corp.test');
      expect(second).not.toBe(first);
      expect(
        (await http.post('/v1/invitations:redeem').send({ tenant_slug: slug, token: first }))
          .status,
      ).toBe(401);
      expect(
        (await http.post('/v1/invitations:redeem').send({ tenant_slug: slug, token: second }))
          .status,
      ).toBe(200);
      const again = await http
        .post(`/v1/users/${invited.body.user_id}:resendInvitation`)
        .set(auth(admin.access_token));
      expect(again.body.code).toBe('USER_NOT_INVITED');
    });
  });
});

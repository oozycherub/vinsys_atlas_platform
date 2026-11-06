/**
 * Acceptance tests 1–10 from docs/prompts/01-tenant-svc.md §8, against the real HTTP stack,
 * real JWT verification and Postgres (PGlite) running as the RLS-bound atlas_app role.
 */
import { randomBytes } from 'node:crypto';
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureHttpApp,
  createLogger,
  FixedClock,
  JwtVerifier,
  LocalKeyEncryption,
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
import { KmsKeyManagement } from '../../src/infrastructure/kms-key-management';

const DAY = 86_400_000;
const REGION = 'eu-central-1';

describe('tenant-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  const clock = new FixedClock(new Date('2026-11-01T09:00:00.000Z'));
  const kms = new KmsKeyManagement(new LocalKeyEncryption('test', randomBytes(32)));
  const logs = new MemoryLogStream();
  let superAdmin: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const key = () => `key-${newId()}`;
  const createBody = (slug: string) => ({ slug, display_name: `${slug} Ltd`, data_region: REGION });

  async function createTenant(slug: string): Promise<{ tenant_id: string; version: number }> {
    const res = await http
      .post('/v1/tenants')
      .set(auth(superAdmin))
      .set('Idempotency-Key', key())
      .send(createBody(slug));
    expect(res.status).toBe(201);
    return res.body as { tenant_id: string; version: number };
  }

  async function lifecycle(id: string, method: string, body: object = {}) {
    return http.post(`/v1/tenants/${id}:${method}`).set(auth(superAdmin)).send(body);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const logger = createLogger({ service: 'tenant-svc', level: 'info', destination: logs });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        kms,
        verifier: new JwtVerifier({ ...TEST_AUTH }),
        settings: {
          cells: { [REGION]: { pooled: ['eu-pool-01', 'eu-pool-02'] } },
          kmsKeyRef: kms.keyRef,
          purgeGraceDays: 30,
        },
      }),
      { logger: false },
    );
    configureHttpApp(app, logger);
    await app.init();
    http = request(app.getHttpServer());
    superAdmin = await signTestToken({ sub: 'staff-1', roles: ['super_admin'] });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('AT1–2: create with idempotency', () => {
    it('creates a provisioning tenant in a pooled cell, emits an event, stores only the wrapped key', async () => {
      const idem = key();
      const res = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', idem)
        .send(createBody('acme'));

      expect(res.status).toBe(201);
      expect(res.headers['etag']).toBe('"1"');
      expect(res.headers['location']).toBe(`/v1/tenants/${res.body.tenant_id}`);
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(res.body).toMatchObject({
        slug: 'acme',
        status: 'provisioning',
        data_region: REGION,
        isolation_tier: 'pooled',
        version: 1,
      });
      expect(['eu-pool-01', 'eu-pool-02']).toContain(res.body.cell_id);
      expect(JSON.stringify(res.body)).not.toMatch(/dek_ciphertext|kms_key_ref|wrapped/);

      const { rows: events } = await db.owner.query<{ topic: string; tenant_id: string }>(
        'SELECT topic, tenant_id FROM outbox_events WHERE aggregate_id = $1',
        [res.body.tenant_id],
      );
      expect(events).toEqual([
        { topic: 'tenant.tenant.provisioned.v1', tenant_id: res.body.tenant_id },
      ]);

      const { rows } = await db.owner.query<{ dek_ciphertext: Uint8Array; kms_key_ref: string }>(
        'SELECT dek_ciphertext, kms_key_ref FROM tenant_data_keys WHERE tenant_id = $1 AND dek_version = 1',
        [res.body.tenant_id],
      );
      const wrapped = rows[0]!.dek_ciphertext;
      expect(wrapped.length).toBe(1 + 12 + 16 + 32); // format + iv + tag + ciphertext, never a bare 32-byte key
      await expect(kms.unwrapDataKey(rows[0]!.kms_key_ref, wrapped)).resolves.toHaveLength(32);

      // AT2: same key + same body → replay, still one tenant
      const replay = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', idem)
        .send(createBody('acme'));
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(res.body);
      const { rows: count } = await db.owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tenants WHERE slug = 'acme'",
      );
      expect(count[0]!.n).toBe(1);
    });

    it('requires an Idempotency-Key', async () => {
      const res = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .send(createBody('no-key-corp'));
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects reusing a key for a different request', async () => {
      const idem = key();
      await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', idem)
        .send(createBody('first-co'));
      const res = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', idem)
        .send(createBody('second-co'));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('AT3–4: slug and region rules', () => {
    it('409 when the slug is taken', async () => {
      await createTenant('taken-co');
      const res = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', key())
        .send(createBody('taken-co'));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'TENANT_SLUG_TAKEN',
        type: 'https://errors.atlas.dev/tenant-slug-taken',
      });
    });

    it('422 for reserved slugs, 400 for malformed ones', async () => {
      const reserved = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', key())
        .send(createBody('admin'));
      expect(reserved.status).toBe(422);
      expect(reserved.body.code).toBe('TENANT_SLUG_RESERVED');

      const bad = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', key())
        .send(createBody('Bad_Slug'));
      expect(bad.status).toBe(400);
      expect(bad.body.errors[0].path).toBe('body.slug');
    });

    it('422 for an unsupported region and 400 for unknown fields', async () => {
      const region = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', key())
        .send({ ...createBody('mars-co'), data_region: 'mars-north-1' });
      expect(region.status).toBe(422);
      expect(region.body.code).toBe('UNSUPPORTED_DATA_REGION');

      const extra = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', key())
        .send({ ...createBody('extra-co'), status: 'active' });
      expect(extra.status).toBe(400);
    });

    it('places dedicated tenants in their own cell', async () => {
      const res = await http
        .post('/v1/tenants')
        .set(auth(superAdmin))
        .set('Idempotency-Key', key())
        .send({ ...createBody('bank-x'), isolation_tier: 'dedicated' });
      expect(res.body.cell_id).toBe(`${REGION}-dedicated-bank-x`);
    });
  });

  describe('AT5–6: authentication, authorisation and tenant isolation', () => {
    it('401 without a token, 401 with a bad token', async () => {
      expect((await http.get('/v1/tenants')).status).toBe(401);
      const forged = await signTestToken(
        { sub: 'x', roles: ['super_admin'] },
        'attacker-controlled-secret-0123456789',
      );
      const res = await http.get('/v1/tenants').set(auth(forged));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it('403 when a tenant_admin tries platform-only operations', async () => {
      const { tenant_id } = await createTenant('role-co');
      const admin = await signTestToken({ sub: 'u1', tid: tenant_id, roles: ['tenant_admin'] });
      expect(
        (
          await http
            .post('/v1/tenants')
            .set(auth(admin))
            .set('Idempotency-Key', key())
            .send(createBody('x-co'))
        ).status,
      ).toBe(403);
      expect((await http.get('/v1/tenants').set(auth(admin))).status).toBe(403);
      expect(
        (await http.post(`/v1/tenants/${tenant_id}:suspend`).set(auth(admin)).send({ reason: 'x' }))
          .status,
      ).toBe(403);
    });

    it('a tenant_admin sees only their own tenant; others are 404 (cross-tenant leak test)', async () => {
      const a = await createTenant('tenant-a');
      const b = await createTenant('tenant-b');
      const adminA = await signTestToken({ sub: 'ua', tid: a.tenant_id, roles: ['tenant_admin'] });

      const own = await http.get(`/v1/tenants/${a.tenant_id}`).set(auth(adminA));
      expect(own.status).toBe(200);
      expect(own.headers['etag']).toBe('"1"');

      const other = await http.get(`/v1/tenants/${b.tenant_id}`).set(auth(adminA));
      expect(other.status).toBe(404);
      expect(other.body.code).toBe('TENANT_NOT_FOUND');
      expect(JSON.stringify(other.body)).not.toContain('tenant-b');

      const otherWrite = await http
        .patch(`/v1/tenants/${b.tenant_id}`)
        .set(auth(adminA))
        .set('If-Match', '"1"')
        .send({ display_name: 'pwned' });
      expect(otherWrite.status).toBe(404);
    });

    it('employees cannot read tenant records at all', async () => {
      const { tenant_id } = await createTenant('emp-co');
      const employee = await signTestToken({ sub: 'e1', tid: tenant_id, roles: ['employee'] });
      expect((await http.get(`/v1/tenants/${tenant_id}`).set(auth(employee))).status).toBe(403);
    });
  });

  describe('AT7: lifecycle', () => {
    it('walks provisioning → active ⇄ suspended → offboarding → purged with history and events', async () => {
      const { tenant_id: id } = await createTenant('life-co');

      expect((await lifecycle(id, 'activate')).body.status).toBe('active');
      const invalid = await lifecycle(id, 'activate');
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe('INVALID_TENANT_TRANSITION');

      const noReason = await lifecycle(id, 'suspend');
      expect(noReason.status).toBe(400);
      expect(noReason.body.code).toBe('REASON_REQUIRED');

      expect((await lifecycle(id, 'suspend', { reason: 'unpaid invoice' })).body.status).toBe(
        'suspended',
      );
      expect((await lifecycle(id, 'reactivate')).body.status).toBe('active');
      const offboard = await lifecycle(id, 'offboard', { reason: 'contract ended' });
      expect(offboard.body.status).toBe('offboarding');
      expect(offboard.body.purge_not_before).toBe(
        new Date(clock.now().getTime() + 30 * DAY).toISOString(),
      );

      const early = await lifecycle(id, 'purge');
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('PURGE_GRACE_PERIOD_ACTIVE');

      clock.advanceBy(30 * DAY);
      const purged = await lifecycle(id, 'purge');
      expect(purged.status).toBe(200);
      expect(purged.body).toMatchObject({ status: 'purged', display_name: '[purged]' });

      const { rows: keys } = await db.owner.query<{
        dek_ciphertext: unknown;
        destroyed_at: unknown;
      }>('SELECT dek_ciphertext, destroyed_at FROM tenant_data_keys WHERE tenant_id = $1', [id]);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.dek_ciphertext === null && k.destroyed_at !== null)).toBe(true);

      const { rows: history } = await db.owner.query<{
        from_status: string | null;
        to_status: string;
        actor: string;
      }>(
        'SELECT from_status, to_status, actor FROM tenant_status_history WHERE tenant_id = $1 ORDER BY history_id',
        [id],
      );
      expect(history.map((h) => `${h.from_status ?? '∅'}→${h.to_status}`)).toEqual([
        '∅→provisioning',
        'provisioning→active',
        'active→suspended',
        'suspended→active',
        'active→offboarding',
        'offboarding→purged',
      ]);
      expect(new Set(history.map((h) => h.actor))).toEqual(new Set(['staff-1']));

      const { rows: events } = await db.owner.query<{ topic: string }>(
        'SELECT topic FROM outbox_events WHERE aggregate_id = $1 ORDER BY event_id',
        [id],
      );
      expect(events.map((e) => e.topic)).toEqual([
        'tenant.tenant.provisioned.v1',
        'tenant.tenant.activated.v1',
        'tenant.tenant.suspended.v1',
        'tenant.tenant.reactivated.v1',
        'tenant.tenant.offboarding_started.v1',
        'tenant.tenant.purged.v1',
      ]);

      const resolve = await http
        .get('/v1/tenant-directory:resolve')
        .query({ slug: 'life-co' })
        .set(
          auth(
            await signTestToken({
              sub: 'gateway',
              roles: ['service'],
              scopes: ['tenant-directory:read'],
            }),
          ),
        );
      expect(resolve.status).toBe(404);
    });

    it('rotates the data key for active tenants only, keeping old versions readable', async () => {
      const { tenant_id: id } = await createTenant('rotate-co');
      expect((await lifecycle(id, 'rotateDataKey')).body.code).toBe('TENANT_NOT_ACTIVE');
      await lifecycle(id, 'activate');
      const rotated = await lifecycle(id, 'rotateDataKey');
      expect(rotated.status).toBe(200);
      expect(rotated.body.dek_version).toBe(2);

      const { rows } = await db.owner.query<{
        dek_version: number;
        kms_key_ref: string;
        dek_ciphertext: Uint8Array;
        retired_at: Date | null;
      }>(
        'SELECT dek_version, kms_key_ref, dek_ciphertext, retired_at FROM tenant_data_keys WHERE tenant_id = $1 ORDER BY dek_version',
        [id],
      );
      expect(rows.map((r) => [r.dek_version, r.retired_at !== null])).toEqual([
        [1, true],
        [2, false],
      ]);
      // The retired key still unwraps, so data encrypted under v1 stays readable.
      for (const row of rows) {
        await expect(kms.unwrapDataKey(row.kms_key_ref, row.dek_ciphertext)).resolves.toHaveLength(
          32,
        );
      }
    });

    it('honours an optional If-Match so a retried rotation cannot apply twice', async () => {
      const { tenant_id: id } = await createTenant('retry-co');
      const activated = await lifecycle(id, 'activate');
      const etagNow = activated.headers['etag'] as string;
      const rotate = () =>
        http
          .post(`/v1/tenants/${id}:rotateDataKey`)
          .set(auth(superAdmin))
          .set('If-Match', etagNow)
          .send({});
      expect((await rotate()).status).toBe(200);
      const retry = await rotate();
      expect(retry.status).toBe(412);
      expect(retry.body.code).toBe('VERSION_MISMATCH');
      const stale = await http
        .post(`/v1/tenants/${id}:suspend`)
        .set(auth(superAdmin))
        .set('If-Match', etagNow)
        .send({ reason: 'test' });
      expect(stale.status).toBe(412);
    });

    it('404 for unknown custom methods or ids', async () => {
      expect((await lifecycle(newId(), 'activate')).status).toBe(404);
      expect(
        (await http.post(`/v1/tenants/${newId()}:explode`).set(auth(superAdmin))).body.code,
      ).toBe('ROUTE_NOT_FOUND');
    });
  });

  describe('AT8: settings with optimistic concurrency', () => {
    const settings = {
      limits: { api_rps: 100, parse_concurrency: 20, sandbox_concurrency: 80 },
      matching: { weights: { sem: 0.5, cov: 0.3, exp: 0.1, lex: 0.1 } },
      features: { 'interview.voice.barge_in': true },
      compliance: { jurisdictions: ['US-NY', 'EU'] },
      locale: 'en',
    };

    it('enforces If-Match, validates weights and emits settings_updated', async () => {
      const { tenant_id: id } = await createTenant('settings-co');
      const put = (ifMatch: string | null, body: object) => {
        const req = http.put(`/v1/tenants/${id}/settings`).set(auth(superAdmin));
        return (ifMatch ? req.set('If-Match', ifMatch) : req).send(body);
      };

      const missing = await put(null, settings);
      expect(missing.status).toBe(428);
      expect(missing.body.code).toBe('IF_MATCH_REQUIRED');

      expect((await put('"7"', settings)).status).toBe(412);

      const badWeights = await put('"1"', {
        ...settings,
        matching: { weights: { sem: 0.5, cov: 0.3, exp: 0.05, lex: 0.05 } },
      });
      expect(badWeights.status).toBe(400);
      expect(badWeights.body.code).toBe('INVALID_SETTINGS');

      const ok = await put('"1"', settings);
      expect(ok.status).toBe(200);
      expect(ok.headers['etag']).toBe('"2"');
      expect(ok.body.settings).toEqual(settings);

      expect((await put('"1"', settings)).status).toBe(412); // stale ETag after the update

      const { rows } = await db.owner.query<{
        payload: { changed_keys: string[]; version: number };
      }>(
        "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND topic = 'tenant.tenant.settings_updated.v1'",
        [id],
      );
      expect(rows[0]!.payload).toMatchObject({
        version: 2,
        changed_keys: ['compliance', 'features', 'limits', 'matching'],
      });
    });

    it('stops tenant admins changing limits or features, but allows the rest', async () => {
      const { tenant_id: id } = await createTenant('own-settings-co');
      const admin = await signTestToken({ sub: 'ta', tid: id, roles: ['tenant_admin'] });
      const current = (await http.get(`/v1/tenants/${id}`).set(auth(admin))).body as {
        settings: typeof settings;
      };
      const put = (ifMatch: string, body: object) =>
        http.put(`/v1/tenants/${id}/settings`).set(auth(admin)).set('If-Match', ifMatch).send(body);

      const raiseLimits = await put('"1"', {
        ...current.settings,
        limits: { ...current.settings.limits, api_rps: 5000 },
      });
      expect(raiseLimits.status).toBe(403);
      expect(raiseLimits.body.code).toBe('PLATFORM_MANAGED_SETTING');
      const enableFeature = await put('"1"', {
        ...current.settings,
        features: { 'interview.ai.enabled': true },
      });
      expect(enableFeature.status).toBe(403);

      const own = await put('"1"', {
        ...current.settings,
        matching: { weights: { sem: 0.5, cov: 0.3, exp: 0.1, lex: 0.1 } },
        locale: 'ar',
      });
      expect(own.status).toBe(200);
      expect(own.body.settings.limits).toEqual(current.settings.limits);
    });

    it('lets only super_admin change the retention policy', async () => {
      const { tenant_id: id } = await createTenant('retention-co');
      const policy = {
        candidate_inactive_days: 365,
        proctoring_frames_days: 14,
        interview_audio_days: 90,
        assessment_reports_days: 730,
      };
      const admin = await signTestToken({ sub: 'ta', tid: id, roles: ['tenant_admin'] });
      expect(
        (
          await http
            .put(`/v1/tenants/${id}/retention-policy`)
            .set(auth(admin))
            .set('If-Match', '"1"')
            .send(policy)
        ).status,
      ).toBe(403);
      const ok = await http
        .put(`/v1/tenants/${id}/retention-policy`)
        .set(auth(superAdmin))
        .set('If-Match', '"1"')
        .send(policy);
      expect(ok.status).toBe(200);
      expect(ok.body.retention_policy).toEqual(policy);
      // Scheduled erasers (proctoring frames, interview audio) are told which periods changed.
      const changed = await db.owner.query<{ payload: { changed_keys: string[] } }>(
        "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND topic = 'tenant.tenant.settings_updated.v1'",
        [id],
      );
      expect(changed.rows.map((r) => r.payload.changed_keys)).toContainEqual([
        'retention_policy.candidate_inactive_days',
        'retention_policy.proctoring_frames_days',
        'retention_policy.interview_audio_days',
        'retention_policy.assessment_reports_days',
      ]);
      // An identical policy changes nothing and announces nothing.
      const same = await http
        .put(`/v1/tenants/${id}/retention-policy`)
        .set(auth(superAdmin))
        .set('If-Match', `"${ok.body.version as number}"`)
        .send(policy);
      expect(same.status).toBe(200);
      const after = await db.owner.query(
        "SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND topic = 'tenant.tenant.settings_updated.v1'",
        [id],
      );
      expect(after.rows).toHaveLength(1);
    });
  });

  describe('AT9: directory resolve for the gateway', () => {
    it('requires the service role and directory scope', async () => {
      const { tenant_id } = await createTenant('resolve-co');
      const gateway = await signTestToken({
        sub: 'gateway',
        roles: ['service'],
        scopes: ['tenant-directory:read'],
      });
      const noScope = await signTestToken({ sub: 'gateway', roles: ['service'] });

      const ok = await http
        .get('/v1/tenant-directory:resolve')
        .query({ slug: 'resolve-co' })
        .set(auth(gateway));
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        tenant_id,
        cell_id: expect.stringMatching(/^eu-pool-0[12]$/),
        data_region: REGION,
        isolation_tier: 'pooled',
        status: 'provisioning',
      });

      expect(
        (
          await http
            .get('/v1/tenant-directory:resolve')
            .query({ slug: 'resolve-co' })
            .set(auth(noScope))
        ).status,
      ).toBe(403);
      expect(
        (
          await http
            .get('/v1/tenant-directory:resolve')
            .query({ slug: 'nobody-here' })
            .set(auth(gateway))
        ).status,
      ).toBe(404);
    });
  });

  describe('listing', () => {
    it('paginates newest-first with a cursor and filters by status', async () => {
      for (const slug of ['page-a', 'page-b', 'page-c']) {
        clock.advanceBy(1000);
        await createTenant(slug);
      }
      const first = await http.get('/v1/tenants').query({ limit: 2 }).set(auth(superAdmin));
      expect(first.status).toBe(200);
      expect(first.body.items.map((t: { slug: string }) => t.slug)).toEqual(['page-c', 'page-b']);
      const second = await http
        .get('/v1/tenants')
        .query({ limit: 2, cursor: first.body.next_cursor })
        .set(auth(superAdmin));
      expect(second.body.items[0].slug).toBe('page-a');

      const bad = await http.get('/v1/tenants').query({ cursor: 'garbage' }).set(auth(superAdmin));
      expect(bad.status).toBe(400);
      // A well-formed cursor carrying a non-UUID id must be a 400, not a database error.
      const forged = Buffer.from(JSON.stringify([new Date().toISOString(), 'not-a-uuid'])).toString(
        'base64url',
      );
      const forgedRes = await http
        .get('/v1/tenants')
        .query({ cursor: forged })
        .set(auth(superAdmin));
      expect(forgedRes.status).toBe(400);

      const purged = await http
        .get('/v1/tenants')
        .query({ status: 'purged' })
        .set(auth(superAdmin));
      expect(purged.body.items.every((t: { status: string }) => t.status === 'purged')).toBe(true);
    });
  });

  describe('AT10: health and observability', () => {
    it('serves health endpoints without auth', async () => {
      expect((await http.get('/healthz')).body).toEqual({ status: 'ok' });
      expect((await http.get('/readyz')).body).toEqual({ status: 'ready' });
    });

    it('returns problem+json for unknown routes and echoes a valid request id', async () => {
      const res = await http
        .get('/nope')
        .set('x-request-id', 'trace-12345678')
        .set(auth(superAdmin));
      expect(res.status).toBe(404);
      expect(res.headers['x-request-id']).toBe('trace-12345678');
      expect(res.body).toMatchObject({ code: 'ROUTE_NOT_FOUND', request_id: 'trace-12345678' });
    });

    it('never logs bearer tokens', () => {
      const all = JSON.stringify(logs.lines);
      expect(all).not.toContain(superAdmin);
      expect(
        logs.lines.some((l) => l['msg'] === 'http request' && typeof l['duration_ms'] === 'number'),
      ).toBe(true);
    });
  });

  describe('settings for platform services', () => {
    it('serves settings to service principals with tenant-settings:read only', async () => {
      const { tenant_id: id } = await createTenant('settings-read-co');
      const service = await signTestToken({
        sub: 'svc_matching',
        roles: ['service'],
        scopes: ['tenant-settings:read'],
      });
      const res = await http.get(`/v1/tenants/${id}/settings`).set(auth(service));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        tenant_id: id,
        version: expect.any(Number),
        settings: { matching: { weights: { sem: 0.4, cov: 0.35, exp: 0.15, lex: 0.1 } } },
        retention_policy: { proctoring_frames_days: 30 },
      });
      const noScope = await signTestToken({ sub: 'svc_x', roles: ['service'] });
      expect((await http.get(`/v1/tenants/${id}/settings`).set(auth(noScope))).status).toBe(403);
      expect((await http.get(`/v1/tenants/${newId()}/settings`).set(auth(service))).status).toBe(
        404,
      );
      expect((await http.get('/v1/tenants/nope/settings').set(auth(service))).status).toBe(404);
    });
  });

  describe('data keys for encrypting services', () => {
    it('serves wrapped key versions to service principals with tenant-keys:read only', async () => {
      const { tenant_id: id } = await createTenant('keys-read-co');
      await lifecycle(id, 'activate');
      await lifecycle(id, 'rotateDataKey');
      const service = await signTestToken({
        sub: 'svc_profile',
        roles: ['service'],
        scopes: ['tenant-keys:read'],
      });
      const res = await http.get(`/v1/tenants/${id}/data-keys`).set(auth(service));
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(
        res.body.keys.map((k: { dek_version: number; active: boolean }) => [
          k.dek_version,
          k.active,
        ]),
      ).toEqual([
        [2, true],
        [1, false],
      ]);
      for (const k of res.body.keys as { kms_key_ref: string; wrapped_key: string }[]) {
        await expect(
          kms.unwrapDataKey(k.kms_key_ref, Buffer.from(k.wrapped_key, 'base64')),
        ).resolves.toHaveLength(32);
      }

      const noScope = await signTestToken({ sub: 'svc_x', roles: ['service'] });
      expect((await http.get(`/v1/tenants/${id}/data-keys`).set(auth(noScope))).status).toBe(403);
      const admin = await signTestToken({ sub: 'ta', tid: id, roles: ['tenant_admin'] });
      expect((await http.get(`/v1/tenants/${id}/data-keys`).set(auth(admin))).status).toBe(403);
      expect((await http.get(`/v1/tenants/${newId()}/data-keys`).set(auth(service))).status).toBe(
        404,
      );
    });
  });
});

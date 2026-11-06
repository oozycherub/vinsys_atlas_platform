/**
 * Component Prompt 13 §8 acceptance tests (notification-svc) against the real HTTP stack, the real
 * event consumer and Postgres (PGlite) as the RLS-bound atlas_app role. Email, webhook receivers
 * and DNS are the fakes in ./fakes.ts.
 */
import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AttritionAlertRaised,
  ErasureRequested,
  InterviewCompleted,
  ProctoringSessionFinalized,
  ReportArtifactReady,
  SessionSubmitted,
  SessionTerminated,
  TenantPurged,
  UserDeactivated,
  UserInvited,
  UserRolesChanged,
} from '@atlas/contracts';
import {
  type Consumer,
  configureHttpApp,
  createConsumer,
  createLogger,
  FixedClock,
  JwtVerifier,
  newId,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import {
  createTestDatabase,
  MemoryLogStream,
  signTestToken,
  TEST_AUTH,
  type TestDatabase,
} from '@atlas/platform/testing';
import { AppModule } from '../../src/app.module';
import { EmailWorker } from '../../src/application/email.worker';
import {
  NOTIFICATION_CONSUMER,
  NotificationEventHandlers,
} from '../../src/application/event-handlers';
import { WebhooksService } from '../../src/application/webhooks.service';
import { retryDelayMs } from '../../src/domain/webhooks';
import { FakeDns, FakeEmailSender, FakeWebhookTransport } from './fakes';

const NOW = new Date('2026-11-06T09:00:00.000Z');

describe('notification-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  let emails: EmailWorker;
  let hooks: WebhooksService;
  const clock = new FixedClock(NOW);
  const email = new FakeEmailSender();
  const transport = new FakeWebhookTransport();
  const dns = new FakeDns();
  const logs = new MemoryLogStream();
  const A = newId();
  const B = newId();
  const user = {
    admin: newId(),
    rec: newId(),
    rev: newId(),
    e1: newId(),
    e2: newId(),
    adminB: newId(),
    mgr: newId(),
  };
  const addr: Record<string, string> = {
    admin: 'admin@a.test',
    rec: 'rec@a.test',
    rev: 'rev@a.test',
    e1: 'e1@a.test',
    e2: 'e2@a.test',
    adminB: 'admin@b.test',
    mgr: 'mgr@a.test',
  };
  const tok: Record<string, string> = {};

  const auth = (t: string | undefined) => ({ Authorization: `Bearer ${t ?? ''}` });
  const emit = (
    topic: string,
    tenantId: string,
    payload: Record<string, unknown>,
    eventId = newId(),
  ) => consumer.handle({ eventId, topic, tenantId, aggregateId: newId(), payload });
  const sql = (tenantId: string, q: string, params: unknown[] = []) =>
    withTenantTx(db, tenantId, async (tx) => (await tx.query(q, params)).rows);
  const outbox = (tenantId: string, topic: string) =>
    sql(
      tenantId,
      `SELECT payload FROM outbox_events WHERE topic = $1 ORDER BY created_at, event_id`,
      [topic],
    ).then((rows) => rows.map((r) => r['payload'] as Record<string, unknown>));
  const drainEmail = async () => {
    for (let i = 0; i < 20; i++) if ((await emails.runOnce()) === 0) return;
  };
  const inboxOf = async (t: string) => {
    const res = await http.get('/v1/me/notifications?limit=100').set(auth(t));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      items: {
        notification_id: string;
        type: string;
        title: string;
        body: string;
        read: boolean;
      }[];
      unread: number;
    };
  };
  const session = (tenantId: string) => ({
    tenant_id: tenantId,
    session_id: newId(),
    assessment_id: newId(),
    assessment_version: 1,
    candidate_id: newId(),
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    const logger = createLogger({ service: 'notification-svc', level: 'info', destination: logs });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        verifier: new JwtVerifier({ ...TEST_AUTH }),
        email,
        webhooks: transport,
        dns,
        settings: {
          defaultFrom: 'Atlas <no-reply@mail.atlas.test>',
          spfInclude: 'spf.mail.atlas.test',
          dkimTarget: 'dkim.mail.atlas.test',
          secretKek: randomBytes(32),
          batchSize: 50,
          leaseMs: 120_000,
          ssePollMs: 60_000,
        },
        logger,
      }),
      { logger: false },
    );
    configureHttpApp(app, logger);
    await app.init();
    http = request(app.getHttpServer());
    consumer = createConsumer({
      name: NOTIFICATION_CONSUMER,
      db,
      handlers: app.get(NotificationEventHandlers).handlers(),
      logger,
    });
    emails = app.get(EmailWorker);
    hooks = app.get(WebhooksService);
    const sign = (sub: string, tid: string | null, roles: string[], scopes: string[] = []) =>
      signTestToken({ sub, tid, roles: roles as never, scopes, expiresIn: '1h' });
    Object.assign(tok, {
      identity: await sign('svc_identity', null, ['service'], ['notifications:send']),
      svcNoScope: await sign('svc_other', null, ['service']),
      admin: await sign(user.admin, A, ['tenant_admin']),
      rec: await sign(user.rec, A, ['recruiter']),
      rev: await sign(user.rev, A, ['reviewer']),
      e1: await sign(user.e1, A, ['employee']),
      e2: await sign(user.e2, A, ['employee']),
      mgr: await sign(user.mgr, A, ['hiring_manager']),
      adminB: await sign(user.adminB, B, ['tenant_admin']),
    });
    const invite = (tenantId: string, id: string, address: string, roles: string[]) =>
      emit(UserInvited.topic, tenantId, {
        tenant_id: tenantId,
        user_id: id,
        email: address,
        roles,
        invited_by: 'seed',
        expires_at: '2026-11-13T09:00:00.000Z',
        occurred_at: NOW.toISOString(),
      });
    await invite(A, user.admin, addr['admin'] as string, ['tenant_admin']);
    await invite(A, user.rec, addr['rec'] as string, ['recruiter']);
    await invite(A, user.rev, addr['rev'] as string, ['reviewer']);
    await invite(A, user.e1, addr['e1'] as string, ['employee']);
    await invite(A, user.e2, addr['e2'] as string, ['employee']);
    await invite(A, user.mgr, addr['mgr'] as string, ['employee']);
    await invite(B, user.adminB, addr['adminB'] as string, ['tenant_admin']);
    await emit(UserRolesChanged.topic, A, {
      tenant_id: A,
      user_id: user.mgr,
      roles: ['hiring_manager'],
      previous_roles: ['employee'],
      actor: 'seed',
      occurred_at: NOW.toISOString(),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('identity link messages (POST /v1/internal/link-messages)', () => {
    const body = {
      kind: 'invitation',
      tenant_id: '',
      email: 'ada@corp.test',
      url: 'https://a.atlas.test/invite?token=SECRET-TOKEN-123',
      expires_at: '2026-11-13T09:00:00.000Z',
    };

    it('needs the service role with notifications:send, and an Idempotency-Key', async () => {
      const b = { ...body, tenant_id: A };
      expect(
        (
          await http
            .post('/v1/internal/link-messages')
            .set(auth(tok['svcNoScope']))
            .set('Idempotency-Key', 'k-noscope-1')
            .send(b)
        ).status,
      ).toBe(403);
      expect(
        (
          await http
            .post('/v1/internal/link-messages')
            .set(auth(tok['admin']))
            .set('Idempotency-Key', 'k-admin-123')
            .send(b)
        ).status,
      ).toBe(403);
      expect(
        (await http.post('/v1/internal/link-messages').set(auth(tok['identity'])).send(b)).status,
      ).toBe(400);
      const http1 = await http
        .post('/v1/internal/link-messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'k-http-link1')
        .send({ ...b, url: 'http://a.atlas.test/x' });
      expect(http1.status).toBe(400);
      const expired = await http
        .post('/v1/internal/link-messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'k-expired-1')
        .send({ ...b, expires_at: '2026-11-01T00:00:00.000Z' });
      expect(expired.status).toBe(400);
    });

    it('accepts once per key (identity retries reuse it), sends the email, then forgets the URL', async () => {
      const b = { ...body, tenant_id: A };
      const first = await http
        .post('/v1/internal/link-messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'link-abc12345')
        .send(b);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      expect(first.body.notification_ids).toHaveLength(1);
      const retry = await http
        .post('/v1/internal/link-messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'link-abc12345')
        .send(b);
      expect(retry.status).toBe(202);
      expect(retry.body).toEqual(first.body);
      const reused = await http
        .post('/v1/internal/link-messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'link-abc12345')
        .send({ ...b, email: 'other@corp.test' });
      expect(reused.status).toBe(422);

      await drainEmail();
      const sent = email.to('ada@corp.test');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.html).toContain('https://a.atlas.test/invite?token=SECRET-TOKEN-123');
      expect(sent[0]?.text).toContain('SECRET-TOKEN-123');
      expect(sent[0]?.from).toBe('Atlas <no-reply@mail.atlas.test>');
      const rows = await sql(
        A,
        `SELECT status, link_url FROM notifications WHERE notification_id = $1`,
        [first.body.notification_ids[0]],
      );
      expect(rows).toEqual([{ status: 'sent', link_url: null }]);
      // Bearer link: never in logs, events or the idempotency record.
      expect(JSON.stringify(logs.lines)).not.toContain('SECRET-TOKEN-123');
      const idem = await withSystemTx(
        db,
        async (tx) =>
          (
            await tx.query(
              `SELECT response_body::text AS b FROM idempotency_keys WHERE idempotency_key = 'link-abc12345'`,
            )
          ).rows,
      );
      expect(JSON.stringify(idem)).not.toContain('SECRET-TOKEN-123');
      const events = await sql(A, `SELECT payload::text AS p FROM outbox_events`);
      expect(JSON.stringify(events)).not.toContain('SECRET-TOKEN-123');
    });

    it('expires an unsent link instead of sending it late', async () => {
      const res = await http
        .post('/v1/internal/link-messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'link-late-0001')
        .send({
          ...body,
          tenant_id: A,
          kind: 'magic_link',
          email: 'late@corp.test',
          expires_at: '2026-11-06T09:10:00.000Z',
        });
      expect(res.status).toBe(202);
      clock.advanceBy(15 * 60_000);
      await drainEmail();
      clock.set(NOW);
      expect(email.to('late@corp.test')).toHaveLength(0);
      const [row] = await sql(
        A,
        `SELECT status, link_url FROM notifications WHERE notification_id = $1`,
        [res.body.notification_ids[0]],
      );
      expect(row).toEqual({ status: 'failed', link_url: null });
      const failed = await outbox(A, 'notification.delivery.failed.v1');
      expect(failed.some((e) => e['notification_id'] === res.body.notification_ids[0])).toBe(true);
    });
  });

  describe('templates', () => {
    const create = (source: string, subject = 'Hello {Recipient_Name}', t = tok['admin']) =>
      http
        .post('/v1/notification-templates')
        .set(auth(t))
        .send({ type: 'assessment_submitted', channel: 'email', subject, source });
    const mj = (inner: string) =>
      `<mjml><mj-body><mj-section><mj-column><mj-text>${inner}</mj-text></mj-column></mj-section></mj-body></mjml>`;

    it('rejects injection: double braces, unknown placeholders, scripts, handlers, javascript: URLs', async () => {
      for (const bad of [
        mj('{{constructor}}'),
        mj('{constructor}'),
        mj('{Unknown_Field}'),
        mj('<script>alert(1)</script>'),
        mj('<img src="x" onerror="alert(1)">'),
        mj('<a href="javascript:alert(1)">x</a>'),
        mj('<iframe src="https://evil.test"></iframe>'),
        '<mjml><mj-body><mj-bogus /></mj-body></mjml>',
      ]) {
        const res = await create(bad);
        expect(res.status, bad).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect((await create(mj('ok'), 'Hi {{Recipient_Name}}')).status).toBe(400);
      expect((await create(mj('ok'), 'Line\nbreak')).status).toBe(400);
      // {URL} belongs to link-bearing types, and only as an href.
      const url = await http
        .post('/v1/notification-templates')
        .set(auth(tok['admin']))
        .send({
          type: 'self_rating_reminder',
          channel: 'email',
          subject: 'x',
          source: mj('Go to {URL}'),
        });
      expect(url.status).toBe(400);
      expect((await create(mj('ok'), 'ok', tok['rec'])).status).toBe(403);
    });

    it('escapes values when rendering (preview)', async () => {
      const res = await http
        .post('/v1/notification-templates:preview')
        .set(auth(tok['admin']))
        .send({
          type: 'assessment_submitted',
          channel: 'email',
          subject: 'Session {Session_Id}',
          source: mj('Hi {Recipient_Name}, {Outcome}'),
          values: {
            Recipient_Name: '<script>alert(1)</script>',
            Outcome: '{{constructor}}',
            Session_Id: 'S\r\nBcc: x@evil.test',
          },
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(res.body.html).not.toContain('<script>alert');
      expect(res.body.html).toContain('{{constructor}}');
      expect(res.body.subject).toBe('Session S Bcc: x@evil.test');
      const inApp = await http
        .post('/v1/notification-templates:preview')
        .set(auth(tok['admin']))
        .send({ type: 'report_ready', channel: 'in_app' });
      expect(inApp.body).toMatchObject({ subject: 'Report ready', html: null });
      const badUrl = await http
        .post('/v1/notification-templates:preview')
        .set(auth(tok['admin']))
        .send({
          type: 'self_rating_reminder',
          channel: 'email',
          values: { URL: 'javascript:alert(1)' },
        });
      expect(badUrl.status).toBe(400);
    });

    it('stores a tenant template that real sends then use', async () => {
      const created = await create(
        mj('Custom: session {Session_Id} is {Outcome}.'),
        'Custom subject {Session_Id}',
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((await create(mj('dup'))).status).toBe(409);
      const updated = await http
        .put(`/v1/notification-templates/${created.body.template_id}`)
        .set(auth(tok['admin']))
        .send({ subject: 'Custom v2 {Session_Id}', source: mj('Custom v2: {Outcome}') });
      expect(updated.body.version).toBe(2);
      const list = await http.get('/v1/notification-templates').set(auth(tok['admin']));
      expect(list.body.items).toHaveLength(1);
      expect(
        (
          await http
            .get(`/v1/notification-templates/${created.body.template_id}`)
            .set(auth(tok['admin']))
        ).body.subject,
      ).toBe('Custom v2 {Session_Id}');

      const s = session(A);
      await emit(SessionSubmitted.topic, A, {
        ...s,
        outcome: 'submitted',
        review_required: false,
        occurred_at: NOW.toISOString(),
      });
      await drainEmail();
      const mail = email.to(addr['rec'] as string).at(-1);
      expect(mail?.subject).toBe(`Custom v2 ${s.session_id}`);
      expect(mail?.html).toContain('Custom v2: submitted');
      expect(
        (
          await http
            .delete(`/v1/notification-templates/${created.body.template_id}`)
            .set(auth(tok['admin']))
        ).status,
      ).toBe(204);
      expect(
        (
          await http
            .get(`/v1/notification-templates/${created.body.template_id}`)
            .set(auth(tok['admin']))
        ).status,
      ).toBe(404);
    });

    it('lists the types and their placeholder allowlists', async () => {
      const res = await http.get('/v1/notification-types').set(auth(tok['admin']));
      const submitted = res.body.items.find(
        (t: { type: string }) => t.type === 'assessment_submitted',
      );
      expect(submitted.placeholders).toEqual([
        'Recipient_Name',
        'Session_Id',
        'Assessment_Id',
        'Outcome',
        'Link_Path',
      ]);
    });
  });

  describe('event-driven notifications and toggles', () => {
    it('notifies recruiters and admins of a submission, in-app and by email', async () => {
      const s = session(A);
      await emit(SessionSubmitted.topic, A, {
        ...s,
        outcome: 'expired',
        review_required: true,
        occurred_at: NOW.toISOString(),
      });
      const rec = await inboxOf(tok['rec'] as string);
      expect(
        rec.items.some((i) => i.type === 'assessment_submitted' && i.body.includes(s.session_id)),
      ).toBe(true);
      const admin = await inboxOf(tok['admin'] as string);
      expect(admin.items.some((i) => i.body.includes(s.session_id))).toBe(true);
      expect(
        (await inboxOf(tok['e1'] as string)).items.some((i) => i.body.includes(s.session_id)),
      ).toBe(false);
      await drainEmail();
      expect(email.to(addr['rec'] as string).some((m) => m.html.includes(s.session_id))).toBe(true);
    });

    it('does not send a type the tenant switched off; transactional types cannot be switched off', async () => {
      const off = await http
        .put('/v1/notification-preferences/assessment_terminated')
        .set(auth(tok['admin']))
        .send({ enabled: false });
      expect(off.status).toBe(200);
      const s = session(A);
      await emit(SessionTerminated.topic, A, {
        ...s,
        reason: 'proctoring',
        occurred_at: NOW.toISOString(),
      });
      const rows = await sql(
        A,
        `SELECT count(*)::int AS n FROM notifications WHERE type = 'assessment_terminated'`,
      );
      expect(rows[0]?.['n']).toBe(0);
      const prefs = await http.get('/v1/notification-preferences').set(auth(tok['admin']));
      expect(
        prefs.body.items.find((p: { type: string }) => p.type === 'assessment_terminated'),
      ).toMatchObject({ enabled: false });
      expect(
        (
          await http
            .put('/v1/notification-preferences/invitation')
            .set(auth(tok['admin']))
            .send({ enabled: false })
        ).status,
      ).toBe(422);
      expect(
        (
          await http
            .put('/v1/notification-preferences/nope')
            .set(auth(tok['admin']))
            .send({ enabled: false })
        ).status,
      ).toBe(400);
      expect(
        (
          await http
            .put('/v1/notification-preferences/assessment_submitted')
            .set(auth(tok['rec']))
            .send({ enabled: false })
        ).status,
      ).toBe(403);
    });

    it('honours a user opt-out per channel, and a type switched off after it was queued', async () => {
      const own = await http
        .put('/v1/me/notification-preferences/proctoring_review_required')
        .set(auth(tok['rev']))
        .send({ enabled: true, email: false, in_app: true });
      expect(own.status).toBe(200);
      const s = session(A);
      const sent = email.sent.length;
      await emit(ProctoringSessionFinalized.topic, A, {
        tenant_id: A,
        session_id: s.session_id,
        assessment_id: s.assessment_id,
        trust_score: 41,
        band: 'red',
        review_required: true,
        breakdown: { gaze: 30 },
        revision: 1,
        occurred_at: NOW.toISOString(),
      });
      expect(
        (await inboxOf(tok['rev'] as string)).items.some(
          (i) => i.title === 'Integrity review needed',
        ),
      ).toBe(true);
      const queued = await sql(
        A,
        `SELECT recipient_user_id FROM notifications WHERE type = 'proctoring_review_required' AND channel = 'email'`,
      );
      expect(queued.map((r) => r['recipient_user_id'])).toEqual([user.rec]);
      // Switched off before the worker ran: suppressed, not sent.
      await http
        .put('/v1/notification-preferences/proctoring_review_required')
        .set(auth(tok['admin']))
        .send({ enabled: true, email: false, in_app: true });
      await drainEmail();
      expect(email.sent.length).toBe(sent);
      const [row] = await sql(
        A,
        `SELECT status FROM notifications WHERE type = 'proctoring_review_required' AND channel = 'email'`,
      );
      expect(row?.['status']).toBe('suppressed');
    });

    it('sends interview reviews to reviewers only when review is needed', async () => {
      const s = session(A);
      const base = {
        tenant_id: A,
        session_id: s.session_id,
        question_id: newId(),
        score_ratio: 0.5,
        completed_at: NOW.toISOString(),
      };
      await emit(InterviewCompleted.topic, A, { ...base, needs_review: false });
      await emit(InterviewCompleted.topic, A, { ...base, needs_review: true });
      const rev = await inboxOf(tok['rev'] as string);
      expect(
        rev.items.filter(
          (i) => i.type === 'interview_review_required' && i.body.includes(s.session_id),
        ),
      ).toHaveLength(1);
    });

    it('sends attrition alerts to HRBPs and the manager, never the employee', async () => {
      const tag = await http
        .put(`/v1/internal/recipients/${user.admin}`)
        .set(auth(tok['identity']))
        .send({ tenant_id: A, tags: ['hrbp'], display_name: 'Hana HR', time_zone: 'Asia/Dubai' });
      expect(tag.status, JSON.stringify(tag.body)).toBe(200);
      const alert = newId();
      await emit(AttritionAlertRaised.topic, A, {
        tenant_id: A,
        alert_id: alert,
        employee_id: newId(),
        manager_user_id: user.mgr,
        recipients: ['hrbp', 'manager'],
        drivers: ['No promotion in 34 months'],
        suggested_actions: [],
        model_version: 'pooled-1',
        occurred_at: NOW.toISOString(),
      });
      const hr = await inboxOf(tok['admin'] as string);
      expect(
        hr.items.some(
          (i) => i.type === 'attrition_alert' && i.body.includes('No promotion in 34 months'),
        ),
      ).toBe(true);
      expect(
        (await inboxOf(tok['mgr'] as string)).items.some((i) => i.type === 'attrition_alert'),
      ).toBe(true);
      expect(
        (await inboxOf(tok['e1'] as string)).items.some((i) => i.type === 'attrition_alert'),
      ).toBe(false);
      const rows = await sql(
        A,
        `SELECT data::text AS d FROM notifications WHERE type = 'attrition_alert'`,
      );
      expect(JSON.stringify(rows)).not.toMatch(/probability/i);
    });

    it('tells the requester when a report is ready', async () => {
      const report = newId();
      await emit(ReportArtifactReady.topic, A, {
        tenant_id: A,
        report_id: report,
        artifact_id: newId(),
        type: 'candidate_assessment_pdf',
        requested_by: user.rec,
        content_type: 'application/pdf',
        size_bytes: 1000,
        occurred_at: NOW.toISOString(),
      });
      const rec = await inboxOf(tok['rec'] as string);
      expect(rec.items.find((i) => i.type === 'report_ready')?.body).toBe(
        'Your candidate assessment pdf report is ready.',
      );
    });

    it('stops notifying a deactivated user', async () => {
      await emit(UserDeactivated.topic, A, {
        tenant_id: A,
        user_id: user.e2,
        actor: 'admin',
        occurred_at: NOW.toISOString(),
      });
      const res = await http.post('/v1/reminders').set(auth(tok['admin'])).send({
        type: 'self_rating_reminder',
        recipient_user_id: user.e2,
        due_at: NOW.toISOString(),
        values: {},
      });
      expect(res.status).toBe(201);
      await drainEmail();
      expect(email.to(addr['e2'] as string)).toHaveLength(0);
      expect((await inboxOf(tok['e2'] as string)).items).toHaveLength(0);
    });
  });

  describe('webhooks', () => {
    let good: { endpoint_id: string; secret: string };
    let down: { endpoint_id: string; secret: string };
    const goodUrl = 'https://hooks.a.test/atlas';
    const downUrl = 'https://down.a.test/atlas';

    it('accepts only https URLs to public hosts and returns the secret once', async () => {
      const create = (url: string) =>
        http
          .post('/v1/webhook-endpoints')
          .set(auth(tok['admin']))
          .send({ url, event_types: ['assessment.session.submitted'] });
      for (const bad of [
        'http://hooks.a.test/x',
        'https://10.0.0.5/x',
        'https://169.254.169.254/latest',
        'https://localhost/x',
        'https://user:pw@hooks.a.test/x',
        'not a url',
      ])
        expect((await create(bad)).status, bad).toBe(400);
      const res = await create(goodUrl);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.secret).toMatch(/^whsec_/);
      good = res.body;
      const again = await http
        .get(`/v1/webhook-endpoints/${good.endpoint_id}`)
        .set(auth(tok['admin']));
      expect(again.body.secret).toBeUndefined();
      const raw = await sql(
        A,
        `SELECT encode(secret_sealed, 'escape') AS s FROM webhook_endpoints`,
      );
      expect(JSON.stringify(raw)).not.toContain(good.secret);
      transport.behaviour.set(downUrl, 500);
      down = (await create(downUrl)).body;
      expect(
        (
          await http
            .post('/v1/webhook-endpoints')
            .set(auth(tok['rec']))
            .send({ url: goodUrl, event_types: ['report.artifact.ready'] })
        ).status,
      ).toBe(403);
    });

    it('signs deliveries so the documented algorithm verifies them', async () => {
      const s = session(A);
      const eventId = newId();
      await emit(
        SessionSubmitted.topic,
        A,
        { ...s, outcome: 'submitted', review_required: false, occurred_at: NOW.toISOString() },
        eventId,
      );
      await hooks.runOnce();
      const hit = transport.received.find((r) => r.url === goodUrl);
      expect(hit).toBeDefined();
      const header = hit?.headers['Atlas-Signature'] as string;
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header) ?? [];
      // Receiver side: HMAC-SHA256(secret, "<t>.<raw body>"), hex; t within 5 minutes.
      expect(createHmac('sha256', good.secret).update(`${t}.${hit?.body}`).digest('hex')).toBe(v1);
      expect(Math.abs(Number(t) - NOW.getTime() / 1000)).toBeLessThanOrEqual(300);
      const body = JSON.parse(hit?.body as string);
      expect(body).toMatchObject({
        id: eventId,
        type: 'assessment.session.submitted',
        tenant_id: A,
        data: { session_id: s.session_id },
      });
      const delivered = await http
        .get(`/v1/webhook-endpoints/${good.endpoint_id}/deliveries?status=delivered`)
        .set(auth(tok['admin']));
      expect(delivered.body.items).toHaveLength(1);
      // The same event again (redelivery from Kafka) is not delivered twice.
      await emit(
        SessionSubmitted.topic,
        A,
        { ...s, outcome: 'submitted', review_required: false, occurred_at: NOW.toISOString() },
        eventId,
      );
      await hooks.runOnce();
      expect(transport.received.filter((r) => r.url === goodUrl)).toHaveLength(1);
    });

    it(':test sends a signed ping', async () => {
      const res = await http
        .post(`/v1/webhook-endpoints/${good.endpoint_id}:test`)
        .set(auth(tok['admin']));
      expect(res.body).toEqual({ ok: true, status: 200, error: null });
      expect(JSON.parse(transport.received.at(-1)?.body as string).type).toBe('ping');
      transport.behaviour.set('https://gone.a.test/x', 'down');
      const gone = (
        await http
          .post('/v1/webhook-endpoints')
          .set(auth(tok['admin']))
          .send({ url: 'https://gone.a.test/x', event_types: ['report.artifact.ready'] })
      ).body;
      expect(
        (await http.post(`/v1/webhook-endpoints/${gone.endpoint_id}:test`).set(auth(tok['admin'])))
          .body,
      ).toEqual({ ok: false, status: null, error: 'connection failed' });
      expect(
        (await http.delete(`/v1/webhook-endpoints/${gone.endpoint_id}`).set(auth(tok['admin'])))
          .status,
      ).toBe(204);
    });

    it('retries with exponential backoff, then dead-letters and reports the failure', async () => {
      const deliveries = async () =>
        (
          await http
            .get(`/v1/webhook-endpoints/${down.endpoint_id}/deliveries`)
            .set(auth(tok['admin']))
        ).body.items;
      const [first] = await deliveries();
      expect(first.status).toBe('pending');
      for (let attempt = 1; attempt <= 8; attempt++) {
        await hooks.runOnce();
        const [d] = await deliveries();
        expect(d.attempts).toBe(attempt);
        if (attempt < 8) {
          expect(d.status).toBe('pending');
          expect(new Date(d.next_attempt_at).getTime() - clock.now().getTime()).toBe(
            retryDelayMs(attempt),
          );
          await hooks.runOnce(); // not yet due
          expect((await deliveries())[0].attempts).toBe(attempt);
          clock.advanceBy(retryDelayMs(attempt));
        } else {
          expect(d.status).toBe('dead');
          expect(d.last_error).toBe('HTTP 500');
        }
      }
      const failed = await outbox(A, 'notification.delivery.failed.v1');
      expect(failed.find((e) => e['endpoint_id'] === down.endpoint_id)).toMatchObject({
        channel: 'webhook',
        reason: 'retries_exhausted',
        attempts: 8,
      });
      const dead = await http
        .get(`/v1/webhook-endpoints/${down.endpoint_id}/deliveries?status=dead`)
        .set(auth(tok['admin']));
      expect(dead.body.items).toHaveLength(1);
      const re = await http
        .post(`/v1/webhook-deliveries/${first.delivery_id}:redeliver`)
        .set(auth(tok['admin']));
      expect(re.body).toMatchObject({ status: 'pending', attempts: 0 });
      expect(
        (
          await http
            .post(`/v1/webhook-deliveries/${first.delivery_id}:redeliver`)
            .set(auth(tok['admin']))
        ).status,
      ).toBe(400);
      clock.set(NOW);
    });

    it('disables an endpoint after 50 consecutive failures and tells the admins', async () => {
      await sql(
        A,
        `UPDATE webhook_endpoints SET consecutive_failures = 49 WHERE endpoint_id = $1`,
        [down.endpoint_id],
      );
      clock.advanceBy(3 * 3_600_000); // the redelivered item is due
      await hooks.runOnce();
      const ep = await http
        .get(`/v1/webhook-endpoints/${down.endpoint_id}`)
        .set(auth(tok['admin']));
      expect(ep.body).toMatchObject({ enabled: false, consecutive_failures: 50 });
      expect(ep.body.disabled_reason).toContain('50 consecutive');
      const admin = await inboxOf(tok['admin'] as string);
      expect(
        admin.items.some((i) => i.type === 'webhook_disabled' && i.body.includes(downUrl)),
      ).toBe(true);
      const failed = await outbox(A, 'notification.delivery.failed.v1');
      expect(failed.some((e) => e['reason'] === 'endpoint_disabled')).toBe(true);
      // Disabled endpoints get nothing: neither new deliveries nor retries.
      const calls = transport.received.length;
      const before = await sql(
        A,
        `SELECT delivery_id, attempts FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY delivery_id`,
        [down.endpoint_id],
      );
      clock.advanceBy(3_600_000);
      await hooks.runOnce();
      expect(transport.received.length).toBe(calls);
      // Not even claimed: the queue skips disabled endpoints' deliveries.
      expect(
        await sql(
          A,
          `SELECT delivery_id, attempts FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY delivery_id`,
          [down.endpoint_id],
        ),
      ).toEqual(before);
      clock.set(NOW);
      const enabled = await http
        .post(`/v1/webhook-endpoints/${down.endpoint_id}:enable`)
        .set(auth(tok['admin']));
      expect(enabled.body).toMatchObject({
        enabled: true,
        consecutive_failures: 0,
        disabled_at: null,
      });
      const patched = await http
        .patch(`/v1/webhook-endpoints/${down.endpoint_id}`)
        .set(auth(tok['admin']))
        .send({ description: 'flaky', event_types: ['report.artifact.ready'] });
      expect(patched.body).toMatchObject({
        description: 'flaky',
        event_types: ['report.artifact.ready'],
        url: downUrl,
      });
      expect(
        (
          await http
            .patch(`/v1/webhook-endpoints/${down.endpoint_id}`)
            .set(auth(tok['admin']))
            .send({ url: 'http://x.test' })
        ).status,
      ).toBe(400);
      expect(
        (await http.get('/v1/webhook-endpoints').set(auth(tok['admin']))).body.items,
      ).toHaveLength(2);
    });
  });

  describe('email delivery', () => {
    const message = (address: string, key: string, subject: string | null = null) =>
      http
        .post('/v1/internal/messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', key)
        .send({
          type: 'candidate_assessment_invitation',
          tenant_id: A,
          email: address,
          subject_id: subject,
          url: 'https://a.atlas.test/run?t=CANDIDATE-SECRET',
          expires_at: '2026-11-20T00:00:00.000Z',
          values: { Candidate_Name: 'Ada <b>', Assessment_Name: 'Java & SQL' },
        });

    it('sends candidate messages with escaped values; rejects unknown or reserved values', async () => {
      const res = await message('cand1@x.test', 'msg-cand-0001');
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      await drainEmail();
      const [m] = email.to('cand1@x.test');
      expect(m?.subject).toBe('Your assessment: Java & SQL');
      expect(m?.html).toContain('Ada &lt;b&gt;');
      expect(m?.html).toContain('CANDIDATE-SECRET');
      const bad = await http
        .post('/v1/internal/messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'msg-bad-00001')
        .send({
          type: 'candidate_assessment_invitation',
          tenant_id: A,
          email: 'c@x.test',
          url: 'https://a.test/x',
          expires_at: '2026-11-20T00:00:00.000Z',
          values: { URL: 'https://evil.test' },
        });
      expect(bad.status).toBe(400);
      const noLink = await http
        .post('/v1/internal/messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'msg-bad-00002')
        .send({
          type: 'candidate_assessment_invitation',
          tenant_id: A,
          email: 'c@x.test',
          values: {},
        });
      expect(noLink.status).toBe(400);
    });

    it('retries transient provider errors and fails permanently refused messages', async () => {
      email.fail('cand2@x.test', 'transient');
      await message('cand2@x.test', 'msg-cand-0002');
      await drainEmail();
      expect(email.to('cand2@x.test')).toHaveLength(0);
      clock.advanceBy(60_000);
      await drainEmail();
      expect(email.to('cand2@x.test')).toHaveLength(1);

      email.fail('cand3@x.test', 'permanent');
      const res = await message('cand3@x.test', 'msg-cand-0003');
      await drainEmail();
      clock.set(NOW);
      const [row] = await sql(
        A,
        `SELECT status, link_url, last_error FROM notifications WHERE notification_id = $1`,
        [res.body.notification_ids[0]],
      );
      expect(row).toEqual({ status: 'failed', link_url: null, last_error: 'fake permanent' });
      const failed = await outbox(A, 'notification.delivery.failed.v1');
      expect(
        failed.find((e) => e['notification_id'] === res.body.notification_ids[0]),
      ).toMatchObject({ channel: 'email', reason: 'permanent' });
      expect(JSON.stringify(failed)).not.toContain('cand3@x.test');
    });

    it('gives up after six attempts', async () => {
      email.fail('cand4@x.test', ...Array<'transient'>(6).fill('transient'));
      const res = await message('cand4@x.test', 'msg-cand-0004');
      for (let i = 0; i < 6; i++) {
        await drainEmail();
        clock.advanceBy(60 * 60_000);
      }
      clock.set(NOW);
      const [row] = await sql(
        A,
        `SELECT status, attempts FROM notifications WHERE notification_id = $1`,
        [res.body.notification_ids[0]],
      );
      expect(row).toEqual({ status: 'failed', attempts: 6 });
    });

    it('sends from a verified tenant domain', async () => {
      const added = await http
        .post('/v1/sending-domains')
        .set(auth(tok['admin']))
        .send({ domain: 'Mail.Corp-A.test' });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(
        (
          await http
            .post('/v1/sending-domains')
            .set(auth(tok['admin']))
            .send({ domain: 'mail.corp-a.test' })
        ).status,
      ).toBe(409);
      const records = added.body.dns_records as { type: string; name: string; value: string }[];
      expect(records.map((r) => r.type)).toEqual(['TXT', 'TXT', 'CNAME']);
      let check = await http
        .post(`/v1/sending-domains/${added.body.domain_id}:verify`)
        .set(auth(tok['admin']));
      expect(check.body).toMatchObject({
        status: 'failed',
        spf_verified: false,
        dkim_verified: false,
        ownership_verified: false,
      });
      dns.txtRecords.set(records[0]?.name as string, [records[0]?.value as string]);
      dns.txtRecords.set('mail.corp-a.test', ['v=spf1 include:spf.mail.atlas.test ~all']);
      dns.cnameRecords.set(records[2]?.name as string, [`${records[2]?.value}.`]);
      check = await http
        .post(`/v1/sending-domains/${added.body.domain_id}:verify`)
        .set(auth(tok['admin']));
      expect(check.body).toMatchObject({
        status: 'verified',
        spf_verified: true,
        dkim_verified: true,
        ownership_verified: true,
      });
      await http
        .put('/v1/notification-settings')
        .set(auth(tok['admin']))
        .send({ from_name: 'Corp A Talent' });
      await message('cand5@x.test', 'msg-cand-0005');
      await drainEmail();
      expect(email.to('cand5@x.test')[0]?.from).toBe('Corp A Talent <no-reply@mail.corp-a.test>');
      expect(
        (await http.get('/v1/sending-domains').set(auth(tok['admin']))).body.items,
      ).toHaveLength(1);
      expect(
        (await http.delete(`/v1/sending-domains/${added.body.domain_id}`).set(auth(tok['admin'])))
          .status,
      ).toBe(204);
    });
  });

  describe('reminders, quiet hours and the daily cap', () => {
    it('defers reminders in quiet hours (recipient time zone) and over the cap, never dropping them', async () => {
      const settings = await http
        .put('/v1/notification-settings')
        .set(auth(tok['admin']))
        .send({ quiet_hours: { start: '20:00', end: '08:00' }, time_zone: 'UTC', max_per_day: 2 });
      expect(settings.body).toEqual({
        quiet_hours: { start: '20:00', end: '08:00' },
        time_zone: 'UTC',
        max_per_day: 2,
        from_name: null,
      });
      expect(
        (
          await http
            .put('/v1/notification-settings')
            .set(auth(tok['admin']))
            .send({ time_zone: 'Mars/Base' })
        ).status,
      ).toBe(400);
      clock.set(new Date('2026-11-06T22:00:00.000Z'));
      const schedule = (due: string) =>
        http
          .post('/v1/reminders')
          .set(auth(tok['admin']))
          .send({
            type: 'self_rating_reminder',
            recipient_user_id: user.e1,
            due_at: due,
            values: { URL: 'https://a.atlas.test/skills' },
          });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push((await schedule('2026-11-06T21:00:00.000Z')).body.reminder_id);
      expect(
        (
          await http
            .post('/v1/reminders')
            .set(auth(tok['admin']))
            .send({
              type: 'self_rating_reminder',
              recipient_user_id: user.e1,
              due_at: NOW.toISOString(),
              values: { URL: 'http://x' },
            })
        ).status,
      ).toBe(400);
      expect(
        (
          await http
            .post('/v1/reminders')
            .set(auth(tok['admin']))
            .send({
              type: 'self_rating_reminder',
              recipient_user_id: user.e1,
              due_at: NOW.toISOString(),
              values: { Nope: 'x' },
            })
        ).status,
      ).toBe(400);
      await drainEmail();
      expect(email.to(addr['e1'] as string)).toHaveLength(0); // 22:00 UTC: quiet
      expect(
        (await inboxOf(tok['e1'] as string)).items.filter((i) => i.type === 'self_rating_reminder'),
      ).toHaveLength(3); // in-app is not deferred
      const queued = await sql(
        A,
        `SELECT available_at FROM notifications WHERE type = 'self_rating_reminder' AND channel = 'email' AND recipient_user_id = $1`,
        [user.e1],
      );
      expect(queued.map((r) => new Date(r['available_at'] as string).toISOString())).toEqual(
        Array(3).fill('2026-11-07T08:00:00.000Z'),
      );
      clock.set(new Date('2026-11-07T08:00:00.000Z'));
      await drainEmail();
      expect(email.to(addr['e1'] as string)).toHaveLength(2); // cap: 2 a day
      const [late] = await sql(
        A,
        `SELECT available_at FROM notifications WHERE type = 'self_rating_reminder' AND channel = 'email' AND status = 'queued'`,
      );
      expect(new Date(late?.['available_at'] as string).toISOString()).toBe(
        '2026-11-08T08:00:00.000Z',
      );
      clock.set(new Date('2026-11-08T08:00:00.000Z'));
      await drainEmail();
      expect(email.to(addr['e1'] as string)).toHaveLength(3);
      expect(email.to(addr['e1'] as string)[0]?.html).toContain('https://a.atlas.test/skills');

      // The HRBP's own zone (Asia/Dubai, UTC+4): 18:00 UTC is 22:00 there.
      clock.set(new Date('2026-11-08T18:00:00.000Z'));
      await schedule('2026-11-08T18:00:00.000Z').then(() => undefined);
      await http
        .post('/v1/reminders')
        .set(auth(tok['admin']))
        .send({
          type: 'manager_rating_reminder',
          recipient_user_id: user.admin,
          due_at: '2026-11-08T18:00:00.000Z',
          values: { Employee_Name: 'Omar' },
        });
      await drainEmail();
      expect(
        email.to(addr['admin'] as string).filter((m) => m.subject.includes('Omar')),
      ).toHaveLength(0);
      const [hr] = await sql(
        A,
        `SELECT available_at FROM notifications WHERE type = 'manager_rating_reminder' AND channel = 'email'`,
      );
      expect(new Date(hr?.['available_at'] as string).toISOString()).toBe(
        '2026-11-09T04:00:00.000Z',
      ); // 08:00 Dubai

      const list = await http.get('/v1/reminders?status=sent').set(auth(tok['admin']));
      expect(list.body.items.length).toBeGreaterThanOrEqual(4);
      const future = await schedule('2026-12-01T09:00:00.000Z');
      const cancelled = await http
        .post(`/v1/reminders/${future.body.reminder_id}:cancel`)
        .set(auth(tok['admin']));
      expect(cancelled.body.status).toBe('cancelled');
      expect(
        (await http.post(`/v1/reminders/${future.body.reminder_id}:cancel`).set(auth(tok['admin'])))
          .status,
      ).toBe(422);
      expect((await http.get('/v1/reminders').set(auth(tok['e1']))).status).toBe(403);
      clock.set(NOW);
      await http.put('/v1/notification-settings').set(auth(tok['admin'])).send({});
    });
  });

  describe('inbox and tenant isolation', () => {
    it('shows only the caller’s own notifications, with read state and paging', async () => {
      const rec = await inboxOf(tok['rec'] as string);
      expect(rec.unread).toBe(rec.items.length);
      const first = rec.items[0]?.notification_id as string;
      expect(
        (await http.post(`/v1/me/notifications/${first}:markRead`).set(auth(tok['e1']))).status,
      ).toBe(404);
      expect(
        (await http.post(`/v1/me/notifications/${first}:markRead`).set(auth(tok['rec']))).body,
      ).toEqual({ notification_id: first, read: true });
      expect((await inboxOf(tok['rec'] as string)).unread).toBe(rec.items.length - 1);
      const page1 = await http.get('/v1/me/notifications?limit=1').set(auth(tok['rec']));
      expect(page1.body.items).toHaveLength(1);
      const page2 = await http
        .get(`/v1/me/notifications?limit=1&cursor=${page1.body.next_cursor}`)
        .set(auth(tok['rec']));
      expect(page2.body.items[0].notification_id).not.toBe(page1.body.items[0].notification_id);
      const unread = await http
        .get('/v1/me/notifications?unread_only=true&limit=100')
        .set(auth(tok['rec']));
      expect(unread.body.items.every((i: { read: boolean }) => !i.read)).toBe(true);
      expect(
        (await http.get('/v1/me/notifications?cursor=bad!').set(auth(tok['rec']))).status,
      ).toBe(400);
      expect(
        (await http.post('/v1/me/notifications:markAllRead').set(auth(tok['rec']))).body.marked,
      ).toBe(rec.items.length - 1);
      expect((await http.get('/v1/me/notifications').set(auth(tok['identity']))).status).toBe(403);
    });

    it('never shows tenant A’s data to tenant B', async () => {
      const adminB = auth(tok['adminB']);
      expect((await http.get('/v1/webhook-endpoints').set(adminB)).body.items).toEqual([]);
      expect((await http.get(`/v1/webhook-endpoints?tenant_id=${A}`).set(adminB)).status).toBe(404);
      const aEndpoint = (await http.get('/v1/webhook-endpoints').set(auth(tok['admin']))).body
        .items[0].endpoint_id;
      expect((await http.get(`/v1/webhook-endpoints/${aEndpoint}`).set(adminB)).status).toBe(404);
      expect((await http.post(`/v1/webhook-endpoints/${aEndpoint}:test`).set(adminB)).status).toBe(
        404,
      );
      expect((await http.get('/v1/notification-templates').set(adminB)).body.items).toEqual([]);
      expect((await http.get('/v1/reminders').set(adminB)).body.items).toEqual([]);
      expect((await inboxOf(tok['adminB'] as string)).items).toEqual([]);
      const prefs = (await http.get('/v1/notification-preferences').set(adminB)).body.items;
      expect(prefs.find((p: { type: string }) => p.type === 'assessment_terminated').enabled).toBe(
        true,
      );
      const aNote = (await inboxOf(tok['admin'] as string)).items[0]?.notification_id as string;
      expect((await http.post(`/v1/me/notifications/${aNote}:markRead`).set(adminB)).status).toBe(
        404,
      );
      // A B event never reaches A's recipients.
      const s = session(B);
      await emit(SessionSubmitted.topic, B, {
        ...s,
        outcome: 'submitted',
        review_required: false,
        occurred_at: NOW.toISOString(),
      });
      expect(
        (await inboxOf(tok['admin'] as string)).items.some((i) => i.body.includes(s.session_id)),
      ).toBe(false);
      expect(
        (await inboxOf(tok['adminB'] as string)).items.some((i) => i.body.includes(s.session_id)),
      ).toBe(true);
    });
  });

  describe('server-sent events', () => {
    it('streams the unread count and new notifications', async () => {
      const server = app.getHttpServer() as {
        listen(port: number): void;
        address(): AddressInfo | string | null;
        listening: boolean;
      };
      if (!server.listening) await app.listen(0);
      const { port } = server.address() as AddressInfo;
      const abort = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/me/notifications:stream`, {
        headers: auth(tok['mgr']),
        signal: abort.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';
      const until = async (needle: string) => {
        while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
      };
      await until('event: unread');
      const alert = newId();
      await emit(AttritionAlertRaised.topic, A, {
        tenant_id: A,
        alert_id: alert,
        employee_id: newId(),
        manager_user_id: user.mgr,
        recipients: ['manager'],
        drivers: ['Pay below band'],
        suggested_actions: [],
        model_version: 'pooled-1',
        occurred_at: NOW.toISOString(),
      });
      await until('Pay below band');
      expect(text).toMatch(/id: [A-Za-z0-9_-]+\nevent: notification\ndata: \{/);
      abort.abort();
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/v1/me/notifications:stream`, {
            headers: auth(tok['identity']),
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('erasure and tenant purge', () => {
    it('deletes messages about an erased candidate and acknowledges', async () => {
      const candidate = newId();
      const res = await http
        .post('/v1/internal/messages')
        .set(auth(tok['identity']))
        .set('Idempotency-Key', 'msg-erase-0001')
        .send({
          type: 'candidate_assessment_invitation',
          tenant_id: A,
          email: 'gone@x.test',
          subject_id: candidate,
          url: 'https://a.test/x',
          expires_at: '2026-11-20T00:00:00.000Z',
          values: {},
        });
      expect(res.status).toBe(202);
      const request = newId();
      await emit(ErasureRequested.topic, A, {
        tenant_id: A,
        request_id: request,
        candidate_id: candidate,
        reason: 'data_subject',
        ack_required_from: ['notification-svc'],
        due_at: '2026-12-06T00:00:00.000Z',
        occurred_at: NOW.toISOString(),
      });
      expect(
        await sql(A, `SELECT 1 FROM notifications WHERE subject_id = $1`, [candidate]),
      ).toEqual([]);
      const acks = await outbox(A, 'privacy.erasure.acknowledged.v1');
      expect(acks).toContainEqual(
        expect.objectContaining({ request_id: request, service: 'notification-svc' }),
      );
    });

    it('removes every row of a purged tenant', async () => {
      await emit(TenantPurged.topic, B, {
        tenant_id: B,
        from_status: 'offboarding',
        to_status: 'purged',
        reason: null,
        actor: 'ops',
        occurred_at: NOW.toISOString(),
      });
      for (const t of ['notifications', 'notification_recipients'])
        expect(await sql(B, `SELECT 1 FROM ${t}`)).toEqual([]);
      expect(
        (await sql(A, `SELECT count(*)::int AS n FROM notification_recipients`))[0]?.['n'],
      ).toBeGreaterThan(0);
    });
  });

  it('health endpoints', async () => {
    expect((await http.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await http.get('/readyz')).body).toEqual({ status: 'ready' });
  });
});

/**
 * Component Prompt 13 §8 acceptance tests (report-svc) against the real HTTP stack, the real event
 * consumer and Postgres (PGlite) as atlas_app. Chromium, storage, Trino and the name directories
 * are the fakes in ./fakes.ts (ChromiumPdfRenderer has its own test in test/unit).
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssessmentSessionEvaluated,
  ErasureRequested,
  InterviewCompleted,
  ProctoringSessionFinalized,
  SessionStarted,
  SessionSubmitted,
  SessionTerminated,
  TenantPurged,
} from '@atlas/contracts';
import {
  type Consumer,
  configureHttpApp,
  createConsumer,
  createLogger,
  FixedClock,
  JwtVerifier,
  newId,
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
import { REPORT_CONSUMER, ReportEventHandlers } from '../../src/application/event-handlers';
import { ReportWorker } from '../../src/application/report.worker';
import {
  FakeDirectory,
  FakeEvidence,
  FakeLakehouse,
  FakePdfRenderer,
  MemoryArtifactStore,
} from './fakes';

const NOW = new Date('2026-11-06T09:00:00.000Z');

describe('report-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  let worker: ReportWorker;
  const clock = new FixedClock(NOW);
  const pdf = new FakePdfRenderer();
  const store = new MemoryArtifactStore();
  const lakehouse = new FakeLakehouse();
  const directory = new FakeDirectory();
  const evidence = new FakeEvidence();
  const logs = new MemoryLogStream();
  const A = newId();
  const B = newId();
  const tok: Record<string, string> = {};
  const skill = { java: newId(), sql: newId() };
  const s1 = { session: newId(), assessment: newId(), candidate: newId() };

  const auth = (t: string | undefined) => ({ Authorization: `Bearer ${t ?? ''}` });
  const emit = (topic: string, tenantId: string, payload: Record<string, unknown>) =>
    consumer.handle({ eventId: newId(), topic, tenantId, aggregateId: newId(), payload });
  const sql = (tenantId: string, q: string, params: unknown[] = []) =>
    withTenantTx(db, tenantId, async (tx) => (await tx.query(q, params)).rows);
  const drain = async () => {
    for (let i = 0; i < 10; i++) if ((await worker.runOnce()) === 0) return;
  };
  const report = async (t: string, body: object) => {
    const res = await http.post('/v1/reports').set(auth(t)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return res.body as { report_id: string; status: string };
  };
  const ready = async (t: string, id: string) => {
    await drain();
    const res = await http.get(`/v1/reports/${id}`).set(auth(t));
    expect(res.body.status, JSON.stringify(res.body)).toBe('ready');
    return res.body as {
      download: {
        url: string;
        expires_at: string;
        file_name: string;
        content_type: string;
        size_bytes: number;
      };
    };
  };
  const pathOf = (url: string) => url.replace('https://reports.atlas.test', '');
  const fetchBody = async (url: string) =>
    http
      .get(pathOf(url))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  async function seedSession(
    tenantId: string,
    s: { session: string; assessment: string; candidate: string },
  ) {
    const ref = {
      tenant_id: tenantId,
      session_id: s.session,
      assessment_id: s.assessment,
      assessment_version: 2,
      candidate_id: s.candidate,
    };
    await emit(SessionStarted.topic, tenantId, {
      ...ref,
      attempt_no: 1,
      deadline_at: '2026-11-06T10:00:00.000Z',
      occurred_at: '2026-11-06T08:00:00.000Z',
    });
    await emit(SessionSubmitted.topic, tenantId, {
      ...ref,
      outcome: 'submitted',
      review_required: true,
      occurred_at: '2026-11-06T08:50:00.000Z',
    });
    await emit(AssessmentSessionEvaluated.topic, tenantId, {
      tenant_id: tenantId,
      candidate_id: s.candidate,
      session_id: s.session,
      skills: [
        { skill_id: skill.java, score: 4, confidence: 0.9 },
        { skill_id: skill.sql, score: 2.5, confidence: 0.6 },
      ],
      evaluated_at: '2026-11-06T08:55:00.000Z',
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const logger = createLogger({ service: 'report-svc', level: 'info', destination: logs });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        verifier: new JwtVerifier({ ...TEST_AUTH }),
        pdf,
        artifacts: store,
        lakehouse,
        directory,
        evidence,
        settings: {
          publicBaseUrl: 'https://reports.atlas.test',
          linkKey: randomBytes(32),
          linkTtlMs: 15 * 60_000,
          artifactRetentionMs: 30 * 86_400_000,
          batchSize: 5,
          leaseMs: 300_000,
          maxAttempts: 3,
        },
        logger,
      }),
      { logger: false },
    );
    configureHttpApp(app, logger);
    await app.init();
    http = request(app.getHttpServer());
    consumer = createConsumer({
      name: REPORT_CONSUMER,
      db,
      handlers: app.get(ReportEventHandlers).handlers(),
      logger,
    });
    worker = app.get(ReportWorker);
    const sign = (sub: string, tid: string | null, roles: string[]) =>
      signTestToken({ sub, tid, roles: roles as never, scopes: [], expiresIn: '1h' });
    Object.assign(tok, {
      admin: await sign('admin-a', A, ['tenant_admin']),
      rec: await sign('rec-a', A, ['recruiter']),
      rec2: await sign('rec-a2', A, ['recruiter']),
      mgr: await sign('mgr-a', A, ['hiring_manager']),
      employee: await sign('emp-a', A, ['employee']),
      adminB: await sign('admin-b', B, ['tenant_admin']),
      recB: await sign('rec-b', B, ['recruiter']),
    });
    directory.names.set(s1.candidate, 'Ada <Lovelace>');
    directory.skills.set(skill.java, 'Java');
    directory.skills.set(skill.sql, 'SQL');
    await seedSession(A, s1);
    // Trust Score revisions out of order: the newest wins.
    const trust = (revision: number, score: number) =>
      emit(ProctoringSessionFinalized.topic, A, {
        tenant_id: A,
        session_id: s1.session,
        assessment_id: s1.assessment,
        trust_score: score,
        band: score < 60 ? 'red' : 'green',
        review_required: score < 60,
        breakdown: { second_face: 100 - score, gaze: 0 },
        revision,
        occurred_at: NOW.toISOString(),
      });
    await trust(2, 88);
    await trust(1, 40);
    await emit(InterviewCompleted.topic, A, {
      tenant_id: A,
      session_id: s1.session,
      question_id: newId(),
      score_ratio: 0.8,
      needs_review: false,
      completed_at: NOW.toISOString(),
      outcome: 'completed',
      recommendation: 'advance',
      competencies: [
        { skill_id: skill.java, weight: 1, score: 4 },
        { skill_id: skill.sql, weight: 0.5, score: null },
      ],
      revision: 1,
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('candidate PDF', () => {
    it('renders the default sections (no proctoring images) and a signed 15-minute link', async () => {
      const job = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s1.session },
      });
      expect(job.status).toBe('queued');
      const done = await ready(tok['rec'] as string, job.report_id);
      const html = pdf.html.at(-1) as string;
      for (const id of ['summary', 'skill_scores', 'integrity', 'ai_interview'])
        expect(html).toContain(`<section id="${id}">`);
      expect(html).not.toContain('id="proctoring_evidence"');
      expect(evidence.calls).toEqual([]);
      expect(html).toContain('Ada &lt;Lovelace&gt;');
      expect(html).toContain('<td>Java</td><td>4.0</td><td>90%</td>');
      expect(html).toContain('Trust Score <strong>88</strong>'); // revision 2 kept over the late revision 1
      expect(html).toContain('Recommendation: <strong>Advance</strong>');
      expect(html).toContain('Insufficient evidence');
      expect(html).toContain("default-src 'none'");
      expect(html).not.toMatch(/<script/i);

      expect(done.download.content_type).toBe('application/pdf');
      expect(new Date(done.download.expires_at).getTime() - NOW.getTime()).toBe(15 * 60_000);
      const file = await fetchBody(done.download.url);
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toMatch(
        /^attachment; filename="assessment-report-/,
      );
      expect(file.headers['cache-control']).toBe('no-store');
      expect((file.body as Buffer).subarray(0, 8).toString()).toBe('%PDF-1.7');

      const events = await sql(
        A,
        `SELECT payload FROM outbox_events WHERE topic = 'report.artifact.ready.v1'`,
      );
      expect(events[0]?.['payload']).toMatchObject({
        report_id: job.report_id,
        type: 'candidate_assessment_pdf',
        requested_by: 'rec-a',
        content_type: 'application/pdf',
      });
      expect(JSON.stringify(events)).not.toContain('sig=');
    });

    it('signed links: tampering, another tenant or expiry are refused', async () => {
      const job = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s1.session },
      });
      const { download } = await ready(tok['rec'] as string, job.report_id);
      const url = new URL(download.url);
      const sig = url.searchParams.get('sig') as string;
      const tampered = new URL(download.url);
      tampered.searchParams.set('sig', `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`);
      expect((await http.get(pathOf(tampered.toString()))).status).toBe(404);
      const otherTenant = new URL(download.url);
      otherTenant.searchParams.set('tenant_id', B);
      expect((await http.get(pathOf(otherTenant.toString()))).status).toBe(404);
      const longer = new URL(download.url);
      longer.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 3600));
      expect((await http.get(pathOf(longer.toString()))).status).toBe(404);
      expect((await http.get(`${url.pathname}?tenant_id=${A}`)).status).toBe(404);
      clock.advanceBy(15 * 60_000 + 1000);
      const expired = await http.get(pathOf(download.url));
      expect(expired.status).toBe(403);
      // A fresh GET issues a fresh link.
      const again = await http.get(`/v1/reports/${job.report_id}`).set(auth(tok['rec']));
      expect((await http.get(pathOf(again.body.download.url))).status).toBe(200);
      clock.set(NOW);
    });

    it('follows the tenant’s section settings; mandatory sections cannot be removed', async () => {
      expect(
        (
          await http
            .put('/v1/report-settings')
            .set(auth(tok['admin']))
            .send({ sections: [{ key: 'skill_scores', enabled: false }] })
        ).status,
      ).toBe(400);
      expect(
        (
          await http
            .put('/v1/report-settings')
            .set(auth(tok['admin']))
            .send({ sections: [{ key: 'bogus', enabled: true }] })
        ).status,
      ).toBe(400);
      expect(
        (
          await http
            .put('/v1/report-settings')
            .set(auth(tok['rec']))
            .send({ sections: [{ key: 'integrity', enabled: false }] })
        ).status,
      ).toBe(403);
      const put = await http
        .put('/v1/report-settings')
        .set(auth(tok['admin']))
        .send({
          sections: [
            { key: 'integrity', enabled: false },
            { key: 'proctoring_evidence', enabled: true },
          ],
        });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body.sections.find((s: { key: string }) => s.key === 'summary')).toMatchObject({
        mandatory: true,
        enabled: true,
      });
      const job = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s1.session },
      });
      await ready(tok['rec'] as string, job.report_id);
      const html = pdf.html.at(-1) as string;
      expect(html).not.toContain('id="integrity"');
      expect(html).toContain('<section id="proctoring_evidence">');
      expect(html).toContain('src="data:image/png;base64,');
      expect(html).not.toContain('svg'); // non-raster evidence is dropped
      expect(evidence.calls).toEqual([s1.session]);

      // A request can narrow optional sections, never drop mandatory ones or add disabled ones.
      const narrow = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s1.session, sections: ['summary', 'integrity'] },
      });
      await ready(tok['rec'] as string, narrow.report_id);
      const n = pdf.html.at(-1) as string;
      expect(n).toContain('id="summary"');
      expect(n).toContain('id="skill_scores"');
      expect(n).not.toContain('id="integrity"');
      expect(n).not.toContain('id="proctoring_evidence"');
      expect(n).not.toContain('id="ai_interview"');
      expect(evidence.calls).toHaveLength(1);
      expect(
        (
          await http
            .post('/v1/reports')
            .set(auth(tok['rec']))
            .send({
              type: 'candidate_assessment_pdf',
              params: { session_id: s1.session, sections: ['nope'] },
            })
        ).status,
      ).toBe(400);
      await http
        .put('/v1/report-settings')
        .set(auth(tok['admin']))
        .send({
          sections: [
            { key: 'integrity', enabled: true },
            { key: 'proctoring_evidence', enabled: false },
          ],
        });
      expect(
        (await http.get('/v1/report-settings').set(auth(tok['rec']))).body.sections.map(
          (s: { enabled: boolean }) => s.enabled,
        ),
      ).toEqual([true, true, true, false, true]);
    });

    it('retries renderer failures, then fails the job', async () => {
      pdf.failures = 1;
      const job = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s1.session },
      });
      await worker.runOnce();
      expect(
        (await http.get(`/v1/reports/${job.report_id}`).set(auth(tok['rec']))).body.status,
      ).toBe('queued');
      clock.advanceBy(30_000);
      await ready(tok['rec'] as string, job.report_id);
      pdf.failures = 3;
      const failing = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s1.session },
      });
      for (let i = 0; i < 3; i++) {
        await worker.runOnce();
        clock.advanceBy(120_000);
      }
      clock.set(NOW);
      const res = await http.get(`/v1/reports/${failing.report_id}`).set(auth(tok['rec']));
      expect(res.body).toMatchObject({
        status: 'failed',
        error: 'chromium crashed',
        download: null,
      });
    });

    it('refuses unknown sessions and roles without access', async () => {
      expect(
        (
          await http
            .post('/v1/reports')
            .set(auth(tok['rec']))
            .send({ type: 'candidate_assessment_pdf', params: { session_id: newId() } })
        ).status,
      ).toBe(404);
      expect(
        (
          await http
            .post('/v1/reports')
            .set(auth(tok['employee']))
            .send({ type: 'candidate_assessment_pdf', params: { session_id: s1.session } })
        ).status,
      ).toBe(403);
      expect(
        (await http.post('/v1/reports').set(auth(tok['rec'])).send({ type: 'nope', params: {} }))
          .status,
      ).toBe(400);
    });
  });

  describe('Excel exports', () => {
    it('streams an assessment’s results page by page', async () => {
      const assessment = newId();
      // 1,203 sessions: three pages of 500 and a short one.
      await sql(
        A,
        `INSERT INTO report_session_facts (tenant_id, session_id, assessment_id, candidate_id, attempt_no, submitted_at, outcome, skills, trust_score, trust_band)
         SELECT $1, gen_random_uuid(), $2, gen_random_uuid(), 1, $3::timestamptz, 'submitted',
                jsonb_build_array(jsonb_build_object('skillId', $4::text, 'score', (i % 5)::int, 'confidence', 1)), 90, 'green'
         FROM generate_series(1, 1203) i`,
        [A, assessment, NOW.toISOString(), skill.java],
      );
      expect(
        (
          await http
            .post('/v1/reports')
            .set(auth(tok['rec']))
            .send({ type: 'assessment_results_xlsx', params: { assessment_id: newId() } })
        ).status,
      ).toBe(404);
      const job = await report(tok['rec'] as string, {
        type: 'assessment_results_xlsx',
        params: { assessment_id: assessment },
      });
      const { download } = await ready(tok['rec'] as string, job.report_id);
      expect(download.file_name).toMatch(/^assessment-results-.*\.xlsx$/);
      const stored = store.only(`${A}/${job.report_id}/`)[0];
      expect(stored?.chunks).toBeGreaterThan(1); // arrived as a stream, not one buffer
      const file = await fetchBody(download.url);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.body as never);
      const sheet = wb.getWorksheet('Results');
      expect(sheet?.rowCount).toBe(1204);
      expect(sheet?.getRow(1).values).toEqual([
        undefined,
        'Session',
        'Candidate',
        'Attempt',
        'Submitted (UTC)',
        'Status',
        'Overall score',
        'Trust Score',
        'Trust band',
        'Interview recommendation',
        'Java',
      ]);
      expect(sheet?.getRow(2).getCell(5).value).toBe('submitted');
      expect(
        (
          await http
            .post('/v1/reports')
            .set(auth(tok['employee']))
            .send({ type: 'assessment_results_xlsx', params: { assessment_id: assessment } })
        ).status,
      ).toBe(403);
    });
  });

  describe('report gallery (lakehouse)', () => {
    it('lists the gallery for analysts only', async () => {
      const res = await http.get('/v1/report-gallery').set(auth(tok['mgr']));
      expect(res.body.items.map((g: { key: string }) => g.key)).toEqual([
        'skill_supply_by_department',
        'skill_gap_by_role',
        'assessment_outcomes',
        'hiring_funnel',
      ]);
      expect((await http.get('/v1/report-gallery').set(auth(tok['rec']))).status).toBe(403);
    });

    it('binds the caller’s tenant and the declared parameters only', async () => {
      const bad = (values: Record<string, unknown>) =>
        http
          .post('/v1/reports')
          .set(auth(tok['mgr']))
          .send({ type: 'gallery_xlsx', params: { report: 'assessment_outcomes', values } });
      expect((await bad({ from: '2026-01-01' })).status).toBe(400);
      expect((await bad({ from: '2026-01-01', to: "2026-12-31' OR 1=1 --" })).status).toBe(400);
      expect((await bad({ from: '2026-01-01', to: '2026-12-31', tenant_id: B })).status).toBe(400);
      expect(
        (
          await http
            .post('/v1/reports')
            .set(auth(tok['mgr']))
            .send({ type: 'gallery_xlsx', params: { report: 'drop_tables', values: {} } })
        ).status,
      ).toBe(400);
      lakehouse.result = {
        columns: ['assessment_id', 'sessions', 'completed', 'mean_score'],
        rows: [
          ['a1', 10, 9, 3.2],
          ['a2', 4, 4, 2.1],
        ],
      };
      const job = await report(tok['mgr'] as string, {
        type: 'gallery_xlsx',
        params: { report: 'assessment_outcomes', values: { from: '2026-01-01', to: '2026-12-31' } },
      });
      const { download } = await ready(tok['mgr'] as string, job.report_id);
      expect(lakehouse.calls.at(-1)?.params).toEqual([
        { kind: 'varchar', value: A },
        { kind: 'date', value: '2026-01-01' },
        { kind: 'date', value: '2026-12-31' },
      ]);
      expect(lakehouse.calls.at(-1)?.sql).toContain('WHERE tenant_id = ?');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await fetchBody(download.url)).body as never);
      expect(wb.worksheets[0]?.getRow(3).values).toEqual([undefined, 'a2', 4, 4, 2.1]);
    });
  });

  describe('isolation', () => {
    it('never shows tenant A’s reports to tenant B, nor one requester’s to another', async () => {
      const job = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s1.session },
      });
      await drain();
      expect((await http.get(`/v1/reports/${job.report_id}`).set(auth(tok['adminB']))).status).toBe(
        404,
      );
      expect(
        (await http.get(`/v1/reports/${job.report_id}?tenant_id=${A}`).set(auth(tok['adminB'])))
          .status,
      ).toBe(404);
      expect(
        (
          await http
            .post('/v1/reports')
            .set(auth(tok['recB']))
            .send({ type: 'candidate_assessment_pdf', params: { session_id: s1.session } })
        ).status,
      ).toBe(404);
      expect((await http.get('/v1/reports').set(auth(tok['adminB']))).body.items).toEqual([]);
      expect((await http.get(`/v1/reports/${job.report_id}`).set(auth(tok['rec2']))).status).toBe(
        404,
      );
      expect((await http.get(`/v1/reports/${job.report_id}`).set(auth(tok['admin']))).status).toBe(
        200,
      );
      const mine = (await http.get('/v1/reports').set(auth(tok['rec2']))).body.items;
      expect(mine).toEqual([]);
      expect(
        (await http.get('/v1/reports').set(auth(tok['admin']))).body.items.length,
      ).toBeGreaterThan(3);
      expect((await http.get('/v1/report-settings').set(auth(tok['employee']))).status).toBe(403);
    });
  });

  describe('erasure and purge', () => {
    it('erases a candidate’s facts, reports and stored files, and acknowledges', async () => {
      const s = { session: newId(), assessment: newId(), candidate: newId() };
      await seedSession(A, s);
      const job = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s.session },
      });
      await ready(tok['rec'] as string, job.report_id);
      const keys = store.only(`${A}/${job.report_id}/`).map((o) => o.key);
      expect(keys).toHaveLength(1);
      const requestId = newId();
      await emit(ErasureRequested.topic, A, {
        tenant_id: A,
        request_id: requestId,
        candidate_id: s.candidate,
        reason: 'data_subject',
        ack_required_from: ['report-svc'],
        due_at: '2026-12-06T00:00:00.000Z',
        occurred_at: NOW.toISOString(),
      });
      expect(store.deleted).toEqual(expect.arrayContaining(keys));
      expect(
        await sql(A, `SELECT 1 FROM report_session_facts WHERE candidate_id = $1`, [s.candidate]),
      ).toEqual([]);
      expect((await http.get(`/v1/reports/${job.report_id}`).set(auth(tok['rec']))).status).toBe(
        404,
      );
      const acks = await sql(
        A,
        `SELECT payload FROM outbox_events WHERE topic = 'privacy.erasure.acknowledged.v1'`,
      );
      expect(acks[0]?.['payload']).toMatchObject({ request_id: requestId, service: 'report-svc' });
    });

    it('marks a job failed when its session was erased before it ran', async () => {
      const s = { session: newId(), assessment: newId(), candidate: newId() };
      await seedSession(A, s);
      const job = await report(tok['rec'] as string, {
        type: 'candidate_assessment_pdf',
        params: { session_id: s.session },
      });
      await sql(A, `DELETE FROM report_session_facts WHERE session_id = $1`, [s.session]);
      await drain();
      expect(
        (await http.get(`/v1/reports/${job.report_id}`).set(auth(tok['rec']))).body,
      ).toMatchObject({ status: 'failed' });
    });

    it('purges a tenant and its stored files', async () => {
      const s = { session: newId(), assessment: newId(), candidate: newId() };
      await seedSession(B, s);
      await emit(SessionTerminated.topic, B, {
        tenant_id: B,
        session_id: s.session,
        assessment_id: s.assessment,
        assessment_version: 2,
        candidate_id: s.candidate,
        reason: 'left',
        occurred_at: NOW.toISOString(),
      });
      await emit(TenantPurged.topic, B, {
        tenant_id: B,
        from_status: 'offboarding',
        to_status: 'purged',
        reason: null,
        actor: 'ops',
        occurred_at: NOW.toISOString(),
      });
      expect(await sql(B, `SELECT 1 FROM report_session_facts`)).toEqual([]);
      expect(store.deleted).toContain(`${B}/*`);
      expect(
        (await sql(A, `SELECT count(*)::int AS n FROM report_session_facts`))[0]?.['n'],
      ).toBeGreaterThan(0);
    });
  });

  it('health endpoints', async () => {
    expect((await http.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await http.get('/readyz')).body).toEqual({ status: 'ready' });
  });
});

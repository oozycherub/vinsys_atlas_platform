/**
 * Component Prompt 12 §8 acceptance tests against the real HTTP stack, the real event consumer and
 * Postgres (PGlite) as the RLS-bound atlas_app role. parsing-svc, llm-gateway and taxonomy-svc are
 * the fakes in ./fakes.ts; intelligence-ml's side of a fulfilment plan is simulated in SQL.
 */
import 'reflect-metadata';
import ExcelJS from 'exceljs';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AllocationChanged,
  CandidateRescored,
  CandidateSkillsUpdated,
  ErasureRequested,
  JobProfileUpdated,
  OpportunityPublished,
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
import { INTEL_CONSUMER, IntelEventHandlers } from '../../src/application/event-handlers';
import { DEFAULT_INTEL_SETTINGS } from '../../src/application/ports';
import { IntelWorker } from '../../src/application/worker';
import { ExcelDemandSheets } from '../../src/infrastructure/sheets';
import { FakeEmbedder, FakeTaxonomy, FakeVectorSearch } from './fakes';

const NOW = new Date('2026-11-06T09:00:00.000Z');

describe('intelligence-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  let worker: IntelWorker;
  const clock = new FixedClock(NOW);
  const vectors = new FakeVectorSearch();
  const embedder = new FakeEmbedder();
  const taxonomy = new FakeTaxonomy();
  const logs = new MemoryLogStream();
  const A = newId();
  const B = newId();
  const skill = { credit: newId(), cash: newId(), sql: newId(), comms: newId(), python: newId() };
  const profile = { analyst: newId(), senior: newId(), lead: newId(), risk: newId() };
  const emp = { e1: newId(), e2: newId(), e3: newId(), e4: newId(), shy: newId() };
  const tok: Record<string, string> = {};

  const auth = (t: string | undefined) => ({ Authorization: `Bearer ${t ?? ''}` });
  const emit = (topic: string, tenantId: string, payload: Record<string, unknown>) =>
    consumer.handle({ eventId: newId(), topic, tenantId, aggregateId: newId(), payload });
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await worker.runOnce()) === 0) return;
  };
  const sql = (tenantId: string, q: string, params: unknown[] = [], hrbp = false) =>
    withTenantTx(db, tenantId, async (tx) => {
      if (hrbp) await tx.query(`SELECT set_config('app.hrbp', 'on', true)`);
      return (await tx.query(q, params)).rows;
    });
  const outbox = (tenantId: string, topic: string) =>
    sql(
      tenantId,
      `SELECT payload FROM outbox_events WHERE topic = $1 ORDER BY created_at, event_id`,
      [topic],
    ).then((rows) => rows.map((r) => r['payload'] as Record<string, unknown>));

  async function profileEvent(
    tenantId: string,
    id: string,
    title: string,
    skills: [string, number, number][],
  ) {
    await emit(JobProfileUpdated.topic, tenantId, {
      tenant_id: tenantId,
      job_profile_id: id,
      version: 1,
      status: 'published',
      title,
      skills: skills.map(([skill_id, weight, target_proficiency]) => ({
        skill_id,
        weight,
        target_proficiency,
        must_have: false,
      })),
      occurred_at: NOW.toISOString(),
    });
  }

  async function skillsEvent(tenantId: string, id: string, skills: [string, number, boolean][]) {
    await emit(CandidateSkillsUpdated.topic, tenantId, {
      tenant_id: tenantId,
      candidate_id: id,
      skills: skills.map(([skill_id, proficiency, is_validated]) => ({
        skill_id,
        proficiency,
        is_validated,
        calibration_needed: false,
      })),
      occurred_at: NOW.toISOString(),
    });
  }

  async function sync(tenantId: string, id: string, body: Record<string, unknown>) {
    const res = await http
      .put(`/v1/employees/${id}?tenant_id=${tenantId}`)
      .set(auth(tok['hris']))
      .send({ source_synced_at: NOW.toISOString(), ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const logger = createLogger({ service: 'intelligence-svc', level: 'info', destination: logs });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        verifier: new JwtVerifier({ ...TEST_AUTH }),
        vectors,
        embedder,
        taxonomy,
        sheets: new ExcelDemandSheets(),
        settings: { ...DEFAULT_INTEL_SETTINGS, annThreshold: 3 },
        logger,
      }),
      { logger: false },
    );
    configureHttpApp(app, logger, { bodyLimit: '8mb' });
    await app.init();
    http = request(app.getHttpServer());
    consumer = createConsumer({
      name: INTEL_CONSUMER,
      db,
      handlers: app.get(IntelEventHandlers).handlers(),
      logger,
    });
    worker = app.get(IntelWorker);
    const sign = (sub: string, tid: string | null, roles: string[], scopes: string[] = []) =>
      signTestToken({ sub, tid, roles: roles as never, scopes, expiresIn: '1h' });
    Object.assign(tok, {
      hris: await sign('svc:hris', null, ['service'], ['hris:sync']),
      svcNoScope: await sign('svc:other', null, ['service']),
      admin: await sign('admin-a', A, ['tenant_admin']),
      hrbp: await sign('hrbp-a', A, ['tenant_admin'], ['hrbp']),
      manager: await sign('mgr-1', A, ['hiring_manager']),
      managerHrbpLess: await sign('mgr-2', A, ['hiring_manager']),
      employeeHrbp: await sign('u-e1', A, ['employee'], ['hrbp']),
      e1: await sign('u-e1', A, ['employee']),
      e2: await sign('u-e2', A, ['employee']),
      e3: await sign('u-e3', A, ['employee']),
      shy: await sign('u-shy', A, ['employee']),
      adminB: await sign('admin-b', B, ['tenant_admin']),
      hrbpB: await sign('hrbp-b', B, ['tenant_admin'], ['hrbp']),
    });
    // Job profiles (taxonomy events) and the workforce (HRIS sync + skills events).
    await profileEvent(A, profile.analyst, 'Credit Analyst', [
      [skill.credit, 1, 4],
      [skill.cash, 0.5, 3],
    ]);
    await profileEvent(A, profile.senior, 'Senior Credit Analyst', [
      [skill.credit, 1, 5],
      [skill.cash, 1, 4],
      [skill.comms, 0.5, 3],
    ]);
    await profileEvent(A, profile.lead, 'Credit Lead', [
      [skill.credit, 1, 5],
      [skill.comms, 1, 5],
    ]);
    await profileEvent(A, profile.risk, 'Risk Analyst', [
      [skill.credit, 1, 3],
      [skill.sql, 1, 4],
    ]);
    const base = {
      department: 'credit',
      location: 'Dubai',
      job_profile_id: profile.analyst,
      hired_at: '2022-01-10',
      role_started_at: '2023-01-10',
      marketplace_opt_in: true,
    };
    await sync(A, emp.e1, { ...base, user_id: 'u-e1', manager_user_id: 'mgr-2' });
    await sync(A, emp.e2, { ...base, user_id: 'u-e2', manager_user_id: 'mgr-2' });
    await sync(A, emp.e3, {
      ...base,
      user_id: 'u-e3',
      manager_user_id: 'mgr-2',
      role_started_at: '2026-08-01',
    });
    await sync(A, emp.e4, { ...base, department: 'treasury', user_id: 'u-e4' });
    await sync(A, emp.shy, { ...base, user_id: 'u-shy', marketplace_opt_in: false });
    await skillsEvent(A, emp.e1, [
      [skill.credit, 4, true],
      [skill.cash, 3, true],
      [skill.comms, 3, true],
    ]);
    await skillsEvent(A, emp.e2, [
      [skill.credit, 3, true],
      [skill.cash, 2, false],
    ]);
    await skillsEvent(A, emp.e3, [
      [skill.credit, 4.5, true],
      [skill.cash, 4, true],
    ]);
    await skillsEvent(A, emp.e4, [[skill.credit, 1, false]]);
    await skillsEvent(A, emp.shy, [
      [skill.credit, 5, true],
      [skill.cash, 5, true],
    ]);
    for (const [id, text] of Object.entries({
      [emp.e1]: 'credit analysis cash flow lending',
      [emp.e2]: 'credit risk',
      [emp.e3]: 'cash flow credit analysis corporate lending',
    }))
      vectors.add(A, id, text);
    await drain();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('HRIS roster', () => {
    it('syncs employees and shows each record only to the right people', async () => {
      const me = await http.get(`/v1/employees/${emp.e1}`).set(auth(tok['e1']));
      expect(me.status, JSON.stringify(me.body)).toBe(200);
      expect(me.body).toMatchObject({
        department: 'credit',
        job_profile_id: profile.analyst,
        role_fit: { band: 'low' },
      });
      expect(me.body).not.toHaveProperty('compa_ratio'); // HR-only fields stay out
      const mine = await http.get('/v1/employees/me').set(auth(tok['e1']));
      expect(mine.body).toEqual(me.body); // found by the caller's user id
      expect((await http.get('/v1/employees/me').set(auth(tok['admin']))).status).toBe(404); // not in the roster
      expect(
        (await http.get(`/v1/employees/${emp.e1}`).set(auth(tok['managerHrbpLess']))).status,
      ).toBe(200); // their manager
      expect((await http.get(`/v1/employees/${emp.e1}`).set(auth(tok['e2']))).status).toBe(404);
      // A tenant user naming another tenant gets 404, not that tenant's data.
      expect(
        (await http.get(`/v1/employees/${emp.e1}?tenant_id=${B}`).set(auth(tok['e1']))).status,
      ).toBe(404);
      expect((await http.get(`/v1/employees/${emp.e1}`).set(auth(tok['adminB']))).status).toBe(404);
      const noScope = await http
        .put(`/v1/employees/${newId()}?tenant_id=${A}`)
        .set(auth(tok['svcNoScope']))
        .send({});
      expect(noScope.status).toBe(403);
      const noTenant = await http.put(`/v1/employees/${newId()}`).set(auth(tok['hris'])).send({});
      expect(noTenant.body.code).toBe('TENANT_ID_REQUIRED');
      const bulk = await http
        .post(`/v1/employees:bulkUpsert?tenant_id=${A}`)
        .set(auth(tok['hris']))
        .send({
          employees: [
            { employee_id: newId(), department: 'ops' },
            { employee_id: newId(), status: 'terminated' },
          ],
        });
      expect(bulk.status).toBe(400); // a terminated employee needs terminated_at
      const ok = await http
        .post(`/v1/employees:bulkUpsert?tenant_id=${A}`)
        .set(auth(tok['admin']))
        .send({
          employees: [
            { employee_id: newId(), department: 'ops', protected_attributes: { gender: 'f' } },
          ],
        });
      expect(ok.body).toEqual({ upserted: 1 });
      // Audit attributes are invisible without the HRBP context, even to the tenant.
      expect(await sql(A, 'SELECT * FROM intel_employee_protected')).toEqual([]);
      expect(await sql(A, 'SELECT * FROM intel_employee_protected', [], true)).toHaveLength(1);
    });
  });

  describe('career paths (readiness golden numbers)', () => {
    it('lists typed paths up to depth 3 with readiness, gaps and learning', async () => {
      for (const [from, to, type] of [
        [profile.analyst, profile.senior, 'vertical'],
        [profile.senior, profile.lead, 'vertical'],
        [profile.analyst, profile.risk, 'horizontal'],
      ] as const) {
        const res = await http.put('/v1/job-profile-transitions').set(auth(tok['admin'])).send({
          from_profile_id: from,
          to_profile_id: to,
          transition_type: type,
          typical_months: 24,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      expect(
        (
          await http.put('/v1/job-profile-transitions').set(auth(tok['manager'])).send({
            from_profile_id: profile.analyst,
            to_profile_id: profile.lead,
            transition_type: 'diagonal',
          })
        ).status,
      ).toBe(403);
      await http
        .post('/v1/learning-items')
        .set(auth(tok['admin']))
        .send({ title: 'Cash-flow modelling', skill_ids: [skill.cash], duration_hours: 12 });
      await http
        .post('/v1/learning-items')
        .set(auth(tok['admin']))
        .send({ title: 'Stakeholder communication', skill_ids: [skill.comms], duration_hours: 6 });
      const res = await http.get(`/v1/employees/${emp.e1}/career-paths`).set(auth(tok['e1']));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const byTarget = Object.fromEntries(
        (
          res.body.paths as {
            target_profile_id: string;
            learning: { uncovered_skills: string[] };
          }[]
        ).map((p) => [p.target_profile_id, p]),
      );
      // e1: credit 4, cash 3, comms 3. Senior: gaps credit 1·1, cash 1·1 → 2 / (5 + 4 + 1.5) = 0.190476.
      expect(byTarget[profile.senior]).toMatchObject({
        type: 'vertical',
        readiness: 0.8095,
        match_pct: 81,
        gap_band: 'low',
      });
      // Lead (depth 2): gaps credit 1, comms 2 → 3 / 10 = 0.3.
      expect(byTarget[profile.lead]).toMatchObject({
        type: 'vertical',
        readiness: 0.7,
        gap_band: 'medium',
      });
      expect(byTarget[profile.lead]).toMatchObject({
        steps: [{ profile_id: profile.senior }, { profile_id: profile.lead }],
      });
      // Risk: sql missing → 4 / (3 + 4) = 0.571 gap.
      expect(byTarget[profile.risk]).toMatchObject({
        type: 'horizontal',
        readiness: 0.4286,
        gap_band: 'high',
      });
      expect(byTarget[profile.senior]?.learning).toMatchObject({
        items: [{ title: 'Cash-flow modelling' }],
        hours: 12,
      });
      expect(byTarget[profile.risk]?.learning.uncovered_skills).toEqual([skill.sql]);
      expect(res.body.paths[0].target_profile_id).toBe(profile.senior); // most ready first
      expect(
        (await http.get(`/v1/employees/${emp.e1}/career-paths`).set(auth(tok['e2']))).status,
      ).toBe(404);
      expect(
        (await http.get('/v1/job-profile-transitions').set(auth(tok['e1']))).body.transitions,
      ).toHaveLength(3);
      expect((await http.get('/v1/learning-items').set(auth(tok['e1']))).body.items).toHaveLength(
        2,
      );
      const del = await http
        .delete(`/v1/job-profile-transitions/${profile.analyst}/${profile.risk}`)
        .set(auth(tok['admin']));
      expect(del.status).toBe(204);
      expect(
        (
          await http
            .delete(`/v1/job-profile-transitions/${profile.analyst}/${profile.risk}`)
            .set(auth(tok['admin']))
        ).status,
      ).toBe(404);
    });
  });

  describe('skill-gap analytics', () => {
    it('serves pre-aggregated heat-map cells, suppressing small groups', async () => {
      const res = await http
        .get('/v1/analytics/skill-gaps?group_by=department&period=6m')
        .set(auth(tok['manager']));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const credit = (
        res.body.cells as { group: string; skill_id: string; employees: number; gap_pct: number }[]
      ).filter((c) => c.group === 'credit');
      // Credit dept (analyst profile): e1 (4, 3), e2 (3, 2), e3 (4.5, 4), shy (5, 5) → credit gaps 0+1+0+0 of 4·4.
      expect(credit.find((c) => c.skill_id === skill.credit)).toMatchObject({
        employees: 4,
        gap_pct: 0.0625,
        band: 'low',
      });
      expect(credit.find((c) => c.skill_id === skill.cash)).toMatchObject({
        employees: 4,
        gap_pct: 0.0833,
      });
      expect((res.body.cells as { group: string }[]).some((c) => c.group === 'treasury')).toBe(
        false,
      ); // 1 employee: suppressed
      const profiles = await http
        .get('/v1/analytics/skill-gaps?group_by=job_profile')
        .set(auth(tok['admin']));
      expect(profiles.body.cells.length).toBeGreaterThan(0);
      expect((await http.get('/v1/analytics/skill-gaps').set(auth(tok['e1']))).status).toBe(403);
      expect(
        (await http.get('/v1/analytics/skill-gaps?period=99m').set(auth(tok['admin']))).status,
      ).toBe(400);
      // Tenant isolation: tenant B's leaders see nothing of tenant A.
      expect(
        (await http.get('/v1/analytics/skill-gaps').set(auth(tok['adminB']))).body.cells,
      ).toEqual([]);
    });
  });

  describe('marketplace', () => {
    let project: string;
    let gig: string;

    it('publishes, ranks with Score_internal and serves the feed', async () => {
      project = (
        await http
          .post('/v1/projects')
          .set(auth(tok['manager']))
          .send({ name: 'Acme refinancing', account_id: 'acme', start_date: '2026-12-01' })
      ).body.project_id as string;
      const noProject = await http.post('/v1/opportunities').set(auth(tok['manager'])).send({
        type: 'gig',
        title: 'X',
        start_date: '2026-12-01',
        job_profile_id: profile.analyst,
      });
      expect(noProject.body.code).toBe('PROJECT_REQUIRED');
      const noSkills = await http
        .post('/v1/opportunities')
        .set(auth(tok['manager']))
        .send({ type: 'role', title: 'X', start_date: '2026-12-01' });
      expect(noSkills.body.code).toBe('REQUIREMENTS_REQUIRED');
      expect(
        (
          await http
            .post('/v1/opportunities')
            .set(auth(tok['e1']))
            .send({ type: 'role', title: 'X', start_date: '2026-12-01' })
        ).status,
      ).toBe(403);
      const created = await http
        .post('/v1/opportunities')
        .set(auth(tok['manager']))
        .send({
          type: 'gig',
          title: 'Cash-flow review for a refinancing',
          description: 'Credit analysis and cash flow modelling for corporate lending',
          project_id: project,
          skills: [
            { skill_id: skill.credit, weight: 1, target_proficiency: 4, must_have: true },
            { skill_id: skill.cash, weight: 1, target_proficiency: 4 },
          ],
          allocation_pct: 50,
          start_date: '2026-12-01',
          end_date: '2027-02-28',
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      gig = created.body.opportunity_id as string;
      expect(created.body.status).toBe('draft');
      expect((await http.get(`/v1/opportunities/${gig}`).set(auth(tok['e1']))).status).toBe(404); // drafts are private
      const published = await http
        .post(`/v1/opportunities/${gig}:publish`)
        .set(auth(tok['manager']));
      expect(published.body.status).toBe('open');
      expect(
        (await http.post(`/v1/opportunities/${gig}:publish`).set(auth(tok['manager']))).body.code,
      ).toBe('INVALID_TRANSITION');
      expect(
        (await http.post(`/v1/opportunities/${gig}:publish`).set(auth(tok['managerHrbpLess'])))
          .status,
      ).toBe(403); // not the owner
      const events = await outbox(A, OpportunityPublished.topic);
      expect(events.at(-1)).toMatchObject({
        opportunity_id: gig,
        type: 'gig',
        allocation_pct: 50,
        required_skills: 2,
      });
      OpportunityPublished.schema.parse(events.at(-1));
      await drain();
      const rec = await http
        .post(`/v1/opportunities/${gig}:recommendCandidates`)
        .set(auth(tok['manager']))
        .send({ limit: 10 });
      expect(rec.status, JSON.stringify(rec.body)).toBe(200);
      const ids = (rec.body.candidates as { employee_id: string }[]).map((c) => c.employee_id);
      expect(ids.slice(0, 2).sort()).toEqual([emp.e1, emp.e3].sort());
      expect(ids).not.toContain(emp.shy); // not opted in (a gig, not a project)
      const top = rec.body.candidates[0] as {
        score_internal: number;
        explanation: { semantic: string };
      };
      expect(top.explanation.semantic).toBe('used');
      expect(top.score_internal).toBeGreaterThan(0.5);
      const e3 = (
        rec.body.candidates as {
          employee_id: string;
          availability: number;
          explanation: { availability: string[] };
        }[]
      ).find((c) => c.employee_id === emp.e3);
      expect(e3).toMatchObject({
        availability: 0.7,
        explanation: { availability: ['short_tenure'] },
      }); // 3 months in role
      expect(vectors.calls.some((c) => c === `ann:${A}`)).toBe(true); // > annThreshold eligible: ANN pre-filter
      const feed = await http.get('/v1/opportunities?for=me').set(auth(tok['e1']));
      expect(feed.status, JSON.stringify(feed.body)).toBe(200);
      expect(feed.body.items[0]).toMatchObject({
        opportunity: { opportunity_id: gig },
        low_confidence: false,
      });
      expect(feed.body.items[0]).not.toHaveProperty('score_internal');
      expect((await http.get('/v1/opportunities?for=me').set(auth(tok['shy']))).body.items).toEqual(
        [],
      );
      expect((await http.get('/v1/opportunities?for=me').set(auth(tok['adminB']))).status).toBe(
        403,
      ); // not in B's roster
      expect((await http.get('/v1/opportunities').set(auth(tok['e1']))).status).toBe(400); // for=me only
      // Leak test: tenant B can neither see nor act on tenant A's opportunity.
      expect((await http.get(`/v1/opportunities/${gig}`).set(auth(tok['adminB']))).status).toBe(
        404,
      );
      expect(
        (
          await http
            .post(`/v1/opportunities/${gig}:recommendCandidates`)
            .set(auth(tok['adminB']))
            .send({})
        ).status,
      ).toBe(404);
    });

    it('applies, accepts into an allocation, and never overbooks (DB constraint)', async () => {
      const applied = await http
        .post(`/v1/opportunities/${gig}/applications`)
        .set(auth(tok['e1']))
        .send({ note: 'Keen' });
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      expect(
        (await http.post(`/v1/opportunities/${gig}/applications`).set(auth(tok['e1'])).send({}))
          .body.code,
      ).toBe('ALREADY_APPLIED');
      expect(
        (await http.post(`/v1/opportunities/${gig}/applications`).set(auth(tok['shy'])).send({}))
          .body.code,
      ).toBe('NOT_OPTED_IN');
      const appId = applied.body.application_id as string;
      expect(
        (await http.post(`/v1/applications/${appId}:accept`).set(auth(tok['e1']))).status,
      ).toBe(403); // not the employee's call
      const accepted = await http
        .post(`/v1/applications/${appId}:accept`)
        .set(auth(tok['manager']));
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.allocation_id).toBeTruthy();
      expect(
        (await http.post(`/v1/applications/${appId}:decline`).set(auth(tok['manager']))).body.code,
      ).toBe('APPLICATION_DECIDED');
      const changed = await outbox(A, AllocationChanged.topic);
      expect(changed.at(-1)).toMatchObject({
        employee_id: emp.e1,
        percent: 50,
        start_date: '2026-12-01',
        end_date: '2027-02-28',
        change: 'created',
      });
      AllocationChanged.schema.parse(changed.at(-1));
      // 50% booked; another 60% overlapping is refused by the database trigger (110%).
      const direct = await http
        .post(`/v1/projects/${project}/allocations`)
        .set(auth(tok['manager']))
        .send({
          employee_id: emp.e1,
          percent: 60,
          start_date: '2027-01-15',
          end_date: '2027-03-31',
        });
      expect(direct.status).toBe(409);
      expect(direct.body.code).toBe('ALLOCATION_EXCEEDS_CAPACITY');
      const later = await http
        .post(`/v1/projects/${project}/allocations`)
        .set(auth(tok['manager']))
        .send({ employee_id: emp.e1, percent: 60, start_date: '2027-03-01' });
      expect(later.status, JSON.stringify(later.body)).toBe(201); // after the gig ends
      // A 120% booking straight into the table is refused too (the constraint is the database's).
      await expect(
        sql(
          A,
          `INSERT INTO project_allocations (tenant_id, allocation_id, project_id, employee_id, percent, during, source, created_by)
                VALUES ($1, $2, $3, $4, 70, daterange('2027-01-01', '2027-02-01'), 'manual', 'x')`,
          [A, newId(), project, emp.e1],
        ),
      ).rejects.toThrow(/would reach 120 percent/);
      const mine = await http.get(`/v1/employees/${emp.e1}/allocations`).set(auth(tok['e1']));
      expect(mine.body.allocations.map((a: { percent: number }) => a.percent)).toEqual([50, 60]);
      // Availability changed: e1 is re-scored and drops out of a new 60% gig in the same window.
      const busy = await http.post('/v1/opportunities').set(auth(tok['manager'])).send({
        type: 'project',
        title: 'Overlap',
        project_id: project,
        job_profile_id: profile.analyst,
        allocation_pct: 60,
        start_date: '2027-01-01',
        end_date: '2027-01-31',
      });
      await http
        .post(`/v1/opportunities/${busy.body.opportunity_id as string}:publish`)
        .set(auth(tok['manager']));
      await drain();
      const busyRec = await http
        .post(`/v1/opportunities/${busy.body.opportunity_id as string}:recommendCandidates`)
        .set(auth(tok['manager']))
        .send({ include_unavailable: true, limit: 50 });
      const e1 = (busyRec.body.candidates as { employee_id: string; availability: number }[]).find(
        (c) => c.employee_id === emp.e1,
      );
      expect(e1?.availability).toBe(0);
      expect(
        (busyRec.body.candidates as { employee_id: string }[]).some(
          (c) => c.employee_id === emp.shy,
        ),
      ).toBe(true); // projects need no opt-in
      const busyId = busy.body.opportunity_id as string;
      const feed = await http.get('/v1/opportunities?for=me').set(auth(tok['e1']));
      expect(
        (feed.body.items as { opportunity: { opportunity_id: string } }[]).some(
          (i) => i.opportunity.opportunity_id === busyId,
        ),
      ).toBe(false); // an opportunity the employee has no room for is not in their feed
      // Freeing the gig's booking re-scores e1 alone (the opportunity is not re-ranked).
      await http
        .delete(`/v1/allocations/${accepted.body.allocation_id as string}`)
        .set(auth(tok['manager']));
      await drain();
      const freed = await http
        .post(`/v1/opportunities/${busyId}:recommendCandidates`)
        .set(auth(tok['manager']))
        .send({ include_unavailable: true, limit: 50 });
      expect(
        (freed.body.candidates as { employee_id: string; availability: number }[]).find(
          (c) => c.employee_id === emp.e1,
        )?.availability,
      ).toBe(1);
      const removed = await http
        .delete(`/v1/allocations/${later.body.allocation_id as string}`)
        .set(auth(tok['manager']));
      expect(removed.status).toBe(204);
      expect((await outbox(A, AllocationChanged.topic)).at(-1)).toMatchObject({
        change: 'deleted',
      });
    });

    it('keeps internal applications private from the current manager until disclosed', async () => {
      const applied = await http
        .post(`/v1/opportunities/${gig}/applications`)
        .set(auth(tok['e2']))
        .send({});
      const appId = applied.body.application_id as string;
      const asManager = () =>
        http.get(`/v1/employees/${emp.e2}/applications`).set(auth(tok['managerHrbpLess']));
      expect((await asManager()).body.applications).toEqual([]);
      expect(
        (await http.get(`/v1/employees/${emp.e2}/applications`).set(auth(tok['e2']))).body
          .applications,
      ).toHaveLength(1);
      expect(
        (await http.post(`/v1/applications/${appId}:disclose`).set(auth(tok['manager']))).status,
      ).toBe(403);
      await http.post(`/v1/applications/${appId}:disclose`).set(auth(tok['e2']));
      expect((await asManager()).body.applications).toHaveLength(1);
      // The opportunity's owner sees every application to it.
      expect(
        (await http.get(`/v1/opportunities/${gig}/applications`).set(auth(tok['manager']))).body
          .applications.length,
      ).toBeGreaterThanOrEqual(2);
      // A tenant policy can make applications visible to managers by default.
      await http.post(`/v1/opportunities/${gig}/applications`).set(auth(tok['e3'])).send({});
      const policy = await http.put('/v1/intelligence/policy').set(auth(tok['admin'])).send({
        applications_visible_to_manager: true,
        learning_hours_per_day: 2,
        attrition_threshold: 0.4,
      });
      expect(policy.body).toEqual({
        applications_visible_to_manager: true,
        learning_hours_per_day: 2,
        attrition_threshold: 0.4,
      });
      expect(
        (await http.get(`/v1/employees/${emp.e3}/applications`).set(auth(tok['managerHrbpLess'])))
          .body.applications,
      ).toHaveLength(1);
      expect(
        (
          await http.put('/v1/intelligence/policy').set(auth(tok['manager'])).send({
            applications_visible_to_manager: false,
            learning_hours_per_day: 1,
            attrition_threshold: 0.35,
          })
        ).status,
      ).toBe(403);
      expect(
        (await http.get('/v1/intelligence/policy').set(auth(tok['manager']))).body
          .learning_hours_per_day,
      ).toBe(2);
      const withdrawn = await http.post(`/v1/applications/${appId}:withdraw`).set(auth(tok['e2']));
      expect(withdrawn.body.status).toBe('withdrawn');
    });

    it('invites, and only the employee answers an invitation', async () => {
      const inv = await http
        .post(`/v1/opportunities/${gig}/invitations`)
        .set(auth(tok['manager']))
        .send({ employee_id: emp.e4 });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const id = inv.body.application_id as string;
      expect(
        (await http.post(`/v1/applications/${id}:accept`).set(auth(tok['manager']))).status,
      ).toBe(403);
      expect((await http.post(`/v1/applications/${id}:accept`).set(auth(tok['e2']))).status).toBe(
        404,
      );
      const declined = await http
        .post(`/v1/applications/${id}:decline`)
        .set(
          auth(
            tok['e4'] ??
              (tok['e4'] = await signTestToken({ sub: 'u-e4', tid: A, roles: ['employee'] })),
          ),
        );
      expect(declined.body.status).toBe('declined');
      expect(
        (await http.post(`/v1/applications/${id}:frobnicate`).set(auth(tok['e4']))).status,
      ).toBe(404);
      const closed = await http.post(`/v1/opportunities/${gig}:close`).set(auth(tok['manager']));
      expect(closed.body.status).toBe('closed');
      await drain();
      expect(
        (await http.get('/v1/opportunities?for=me').set(auth(tok['e1']))).body.items.some(
          (i: { opportunity: { opportunity_id: string } }) => i.opportunity.opportunity_id === gig,
        ),
      ).toBe(false);
    });

    it("ranks a role linked to a requisition by matching-svc's score", async () => {
      const requisition = newId();
      await emit(CandidateRescored.topic, A, {
        tenant_id: A,
        candidate_id: emp.e2,
        weights_version: 'w1',
        scores: [{ requisition_id: requisition, score: 0.91, band: 'strong' }],
        occurred_at: NOW.toISOString(),
      });
      await emit(CandidateRescored.topic, A, {
        tenant_id: A,
        candidate_id: newId(),
        weights_version: 'w1',
        scores: [],
        occurred_at: NOW.toISOString(),
      });
      const role = await http.post('/v1/opportunities').set(auth(tok['manager'])).send({
        type: 'role',
        title: 'Credit analyst (internal)',
        job_profile_id: profile.analyst,
        requisition_id: requisition,
        start_date: '2027-01-04',
      });
      await http
        .post(`/v1/opportunities/${role.body.opportunity_id as string}:publish`)
        .set(auth(tok['manager']));
      await drain();
      const rec = await http
        .post(`/v1/opportunities/${role.body.opportunity_id as string}:recommendCandidates`)
        .set(auth(tok['manager']))
        .send({});
      expect(rec.body.candidates[0]).toMatchObject({
        employee_id: emp.e2,
        score: 0.91,
        explanation: { source: 'requisition' },
      });
    });
  });

  describe('demand and fulfilment plans', () => {
    const header =
      'title,account_id,external_ref,job_profile_id,skills,headcount,allocation_pct,start_date,end_date,location';
    it('loads CSV and XLSX sheets, reporting bad rows', async () => {
      const csv = [
        header,
        `Analyst,acme,D1,${profile.analyst},,2,100,2026-12-15,,Dubai`,
        `Quant,acme,D2,,${skill.python}:1:5,1,,2026-12-15,,`,
        `Broken,acme,D3,,,1,,2026-12-15,,`,
      ].join('\n');
      const res = await http
        .post('/v1/demands:upload')
        .set(auth(tok['manager']))
        .send({ file_name: 'demand.csv', content_base64: Buffer.from(csv).toString('base64') });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body).toMatchObject({
        status: 'processed',
        rows_total: 3,
        rows_loaded: 2,
        errors: [{ row: 3 }],
      });
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Demand');
      sheet.addRow(header.split(','));
      sheet.addRow([
        'Analyst',
        'acme',
        'D1',
        profile.analyst,
        '',
        3,
        100,
        new Date('2026-12-15T00:00:00Z'),
        '',
        'Dubai',
      ]);
      const xlsx = Buffer.from(await book.xlsx.writeBuffer());
      const again = await http
        .post('/v1/demands:upload')
        .set(auth(tok['manager']))
        .send({ file_name: 'demand.xlsx', content_base64: xlsx.toString('base64') });
      expect(again.body).toMatchObject({ status: 'processed', rows_loaded: 1 });
      const list = await http.get('/v1/demands?account_id=acme').set(auth(tok['manager']));
      expect(
        list.body.demands.map((d: { external_ref: string; headcount: number }) => [
          d.external_ref,
          d.headcount,
        ]),
      ).toEqual([
        ['D1', 3],
        ['D2', 1],
      ]); // D1 updated in place
      expect(list.body.demands[0].skills).toHaveLength(2); // the profile's requirements
      const batch = await http
        .get(`/v1/demand-batches/${res.body.batch_id as string}`)
        .set(auth(tok['manager']));
      expect(batch.body).toMatchObject({ file_name: 'demand.csv', rows_loaded: 2 });
      const unknown = await http
        .post('/v1/demands:upload')
        .set(auth(tok['manager']))
        .send({
          file_name: 'd.csv',
          content_base64: Buffer.from(
            [header, `Lead,acme,,${newId()},,1,,2026-12-15,,`].join('\n'),
          ).toString('base64'),
        });
      expect(unknown.body).toMatchObject({
        status: 'failed',
        rows_loaded: 0,
        errors: [{ message: expect.stringContaining('not known') }],
      });
      const garbage = await http
        .post('/v1/demands:upload')
        .set(auth(tok['manager']))
        .send({ file_name: 'd.xlsx', content_base64: Buffer.from('not a zip').toString('base64') });
      expect(garbage.body.code).toBe('UNREADABLE_FILE');
      expect(
        (
          await http
            .post('/v1/demands:upload')
            .set(auth(tok['manager']))
            .send({ file_name: 'd.pdf', content_base64: 'eA==' })
        ).status,
      ).toBe(400);
      expect(
        (
          await http
            .post('/v1/demands:upload')
            .set(auth(tok['e1']))
            .send({ file_name: 'd.csv', content_base64: 'eA==' })
        ).status,
      ).toBe(403);
      expect((await http.get('/v1/demands').set(auth(tok['adminB']))).body.demands).toEqual([]);
    });

    it('queues a plan for intelligence-ml and serves its lines when done', async () => {
      const first = await http
        .post('/v1/fulfilment-plans:compute')
        .set(auth(tok['manager']))
        .send({ account_id: 'acme', horizon_days: 60 });
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({ status: 'queued', created: true });
      const again = await http
        .post('/v1/fulfilment-plans:compute')
        .set(auth(tok['manager']))
        .send({ account_id: 'acme' });
      expect(again.body).toMatchObject({ plan_id: first.body.plan_id, created: false });
      const planId = first.body.plan_id as string;
      expect(
        (await http.get(`/v1/fulfilment-plans/${planId}`).set(auth(tok['manager']))).body,
      ).toMatchObject({ status: 'queued', lines: [] });
      // intelligence-ml's worker (Python) writes the result; simulated here.
      const demand = (
        await sql(A, `SELECT demand_id::text AS id FROM demands WHERE external_ref = 'D2'`)
      )[0]?.['id'];
      await sql(
        A,
        `INSERT INTO fulfilment_plan_lines (tenant_id, plan_id, demand_id, slot, classification, days_until_start) VALUES ($1, $2, $3, 1, 'recruit', 39)`,
        [A, planId, demand],
      );
      await sql(
        A,
        `UPDATE fulfilment_plans SET status = 'done', solver_status = 'OPTIMAL', summary = '{"recruit": 1}' WHERE plan_id = $1`,
        [planId],
      );
      const done = await http.get(`/v1/fulfilment-plans/${planId}`).set(auth(tok['manager']));
      expect(done.body).toMatchObject({
        status: 'done',
        solver_status: 'OPTIMAL',
        lines: [{ classification: 'recruit', slot: 1 }],
      });
      expect(
        (await http.get(`/v1/fulfilment-plans/${planId}`).set(auth(tok['adminB']))).status,
      ).toBe(404);
    });
  });

  describe('attrition governance', () => {
    beforeAll(async () => {
      await sql(
        A,
        `INSERT INTO attrition_models (tenant_id, model_version, scope, trained_at, metrics, features, excluded, alerts_enabled, artifact)
                    VALUES ($1, 'pooled-2026-11-01-x', 'pooled', now(), '{"auc": 0.81, "ece": 0.03}', '["tenure_months"]', '{}', true, '{}')`,
        [A],
        true,
      );
      await sql(
        A,
        `INSERT INTO attrition_scores (tenant_id, employee_id, scored_on, probability, model_version, drivers)
                    VALUES ($1, $2, '2026-11-06', 0.52, 'pooled-2026-11-01-x', '[{"phrase": "No promotion in 34 months"}]')`,
        [A, emp.e2],
        true,
      );
      await sql(
        A,
        `INSERT INTO attrition_alerts (tenant_id, alert_id, employee_id, probability, first_crossing, drivers, suggested_actions, model_version, raised_on)
                    VALUES ($1, $2, $3, 0.52, true, '[]', '[]', 'pooled-2026-11-01-x', '2026-11-06')`,
        [A, newId(), emp.e2],
        true,
      );
    });

    it('refuses managers without the hrbp scope, and employees always', async () => {
      expect(
        (await http.get('/v1/attrition/alerts').set(auth(tok['managerHrbpLess']))).status,
      ).toBe(403);
      expect((await http.get('/v1/attrition/alerts').set(auth(tok['admin']))).status).toBe(403);
      expect((await http.get('/v1/attrition/alerts').set(auth(tok['employeeHrbp']))).status).toBe(
        403,
      );
      expect(
        (await http.get(`/v1/attrition/employees/${emp.e2}`).set(auth(tok['e2']))).status,
      ).toBe(403);
      // Employee-facing routes never carry risk.
      const me = await http.get(`/v1/employees/${emp.e2}`).set(auth(tok['e2']));
      expect(JSON.stringify(me.body)).not.toMatch(/probab|attrition|risk/i);
    });

    it('serves HRBPs, under the HRBP policy, with an audit trail', async () => {
      const alerts = await http.get('/v1/attrition/alerts?status=open').set(auth(tok['hrbp']));
      expect(alerts.status, JSON.stringify(alerts.body)).toBe(200);
      expect(alerts.body.alerts).toHaveLength(1);
      const id = alerts.body.alerts[0].alert_id as string;
      expect(
        (await http.post(`/v1/attrition/alerts/${id}:acknowledge`).set(auth(tok['hrbp']))).body
          .status,
      ).toBe('acknowledged');
      expect(
        (await http.post(`/v1/attrition/alerts/${id}:acknowledge`).set(auth(tok['hrbp']))).status,
      ).toBe(404);
      const scores = await http.get(`/v1/attrition/employees/${emp.e2}`).set(auth(tok['hrbp']));
      expect(scores.body.scores[0]).toMatchObject({ probability: 0.52 });
      expect((await http.get('/v1/attrition/model').set(auth(tok['hrbp']))).body).toMatchObject({
        scope: 'pooled',
        alerts_enabled: true,
      });
      expect((await http.get('/v1/attrition/model').set(auth(tok['hrbpB']))).status).toBe(404);
      // Leak test: another tenant's HRBP sees none of it.
      expect((await http.get('/v1/attrition/alerts').set(auth(tok['hrbpB']))).body.alerts).toEqual(
        [],
      );
      const audit = await sql(A, `SELECT subject, action FROM intel_audit_log ORDER BY audit_id`);
      // The refused second acknowledgement rolled back with its audit row (nothing was read).
      expect(audit.map((r) => r['action'])).toEqual([
        'attrition.alerts.list',
        'attrition.alert.acknowledge',
        'attrition.employee.read',
        'attrition.model.read',
      ]);
      expect(audit.every((r) => r['subject'] === 'hrbp-a')).toBe(true);
      await expect(sql(A, `UPDATE intel_audit_log SET subject = 'x'`)).rejects.toThrow(
        /permission denied/,
      );
      // Even inside the tenant, the tables are empty without the HRBP context.
      expect(await sql(A, 'SELECT * FROM attrition_alerts')).toEqual([]);
    });
  });

  describe('events', () => {
    it('erases an employee everywhere and acknowledges', async () => {
      const requestId = newId();
      await emit(ErasureRequested.topic, A, {
        tenant_id: A,
        request_id: requestId,
        candidate_id: emp.e2,
        reason: 'data_subject',
        ack_required_from: ['intelligence-svc'],
        due_at: NOW.toISOString(),
        occurred_at: NOW.toISOString(),
      });
      for (const table of [
        'intel_employees',
        'intel_employee_skills',
        'opportunity_applications',
        'opportunity_matches',
        'employee_role_gaps',
      ])
        expect(
          await sql(A, `SELECT 1 FROM ${table} WHERE employee_id = $1`, [emp.e2]),
          table,
        ).toEqual([]);
      expect(
        await sql(A, 'SELECT 1 FROM attrition_scores WHERE employee_id = $1', [emp.e2], true),
      ).toEqual([]);
      expect((await outbox(A, 'privacy.erasure.acknowledged.v1')).at(-1)).toMatchObject({
        request_id: requestId,
        service: 'intelligence-svc',
      });
    });

    it('purges a tenant', async () => {
      await sync(B, newId(), { department: 'x' });
      await emit(TenantPurged.topic, B, {
        tenant_id: B,
        from_status: 'offboarding',
        to_status: 'purged',
        reason: null,
        actor: 'system',
        occurred_at: NOW.toISOString(),
      });
      expect(await sql(B, 'SELECT 1 FROM intel_employees')).toEqual([]);
    });

    it('keeps job profiles monotonic and survives a failing skill graph', async () => {
      await emit(JobProfileUpdated.topic, A, {
        tenant_id: A,
        job_profile_id: profile.analyst,
        version: 0 + 1,
        status: 'published',
        title: 'Stale',
        skills: [],
        occurred_at: NOW.toISOString(),
      });
      expect(
        (
          await sql(A, `SELECT title FROM intel_job_profiles WHERE job_profile_id = $1`, [
            profile.analyst,
          ])
        )[0],
      ).toMatchObject({ title: 'Stale' }); // same version: accepted
      await emit(JobProfileUpdated.topic, A, {
        tenant_id: A,
        job_profile_id: profile.analyst,
        version: 2,
        status: 'published',
        title: 'Credit Analyst II',
        skills: [{ skill_id: skill.credit, weight: 1, target_proficiency: 4, must_have: false }],
        occurred_at: NOW.toISOString(),
      });
      await emit(JobProfileUpdated.topic, A, {
        tenant_id: A,
        job_profile_id: profile.analyst,
        version: 1,
        status: 'published',
        title: 'Old',
        skills: [],
        occurred_at: NOW.toISOString(),
      });
      expect(
        (
          await sql(A, `SELECT title FROM intel_job_profiles WHERE job_profile_id = $1`, [
            profile.analyst,
          ])
        )[0],
      ).toMatchObject({ title: 'Credit Analyst II' });
      taxonomy.fail = true;
      vectors.down = true;
      await drain(); // ranking degrades (no SEM, no related skills) instead of failing
      taxonomy.fail = false;
      vectors.down = false;
      expect(await sql(A, `SELECT 1 FROM intel_work`)).toEqual([]);
    });
  });
});

/**
 * Component Prompt 08 §8 acceptance tests against the real HTTP stack, the event consumer and
 * Postgres (PGlite) running as the RLS-bound atlas_app role; the server clock is a FixedClock.
 */
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ErasureRequested,
  InterviewCompleted,
  SubmissionJudged,
  TenantPurged,
  ViolationRaised,
} from '@atlas/contracts';
import {
  type Consumer,
  configureHttpApp,
  createConsumer,
  createLogger,
  FixedClock,
  JwtVerifier,
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
import { ASSESSMENT_CONSUMER, AssessmentEventHandlers } from '../../src/application/event-handlers';
import { DEFAULT_ASSESSMENT_SETTINGS } from '../../src/application/ports';
import { ResultsService } from '../../src/application/results.service';
import { ServiceRejectedError } from '../../src/application/ports';
import { MemoryInterviewGateway } from '../../src/infrastructure/interview-gateway';
import { MemoryProctoringGateway } from '../../src/infrastructure/proctoring-gateway';
import { MemoryProfileDirectory } from '../../src/infrastructure/profile-directory';
import { MemorySandboxGateway } from '../../src/infrastructure/sandbox-gateway';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const HIDDEN = [
  '"correct"',
  '"accepted"',
  '"tests"',
  '"rubric"',
  '"answer_key"',
  '"case_sensitive"',
  '"expected"',
  '"reference_solution"',
  '"checker"',
];

describe('assessment-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  let results: ResultsService;
  const clock = new FixedClock(NOW);
  const sandbox = new MemorySandboxGateway();
  const proctoring = new MemoryProctoringGateway();
  const interviews = new MemoryInterviewGateway();
  const logs = new MemoryLogStream();
  const tenantA = newId();
  const tenantB = newId();
  const skill = { java: newId(), sql: newId(), writing: newId() };
  let recruiterA: string;
  let recruiterB: string;
  let reviewer1: string;
  let reviewer2: string;
  let candidateJwt: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const session = (t: string) => ({ Authorization: `Session ${t}` });
  const emit = (
    topic: string,
    tenantId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) => consumer.handle({ eventId: newId(), topic, tenantId, aggregateId, payload });
  const noHidden = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const key of HIDDEN) expect(text, `${key} leaked`).not.toContain(key);
  };

  async function question(token: string, body: Record<string, unknown>): Promise<string> {
    const res = await http.post('/v1/questions').set(auth(token)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.question_id as string;
  }

  async function published(token: string, body: Record<string, unknown>): Promise<string> {
    const created = await http
      .post('/v1/assessments')
      .set(auth(token))
      .send({ title: 'Backend screening', duration_seconds: 1800, ...body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.assessment_id as string;
    const pub = await http.post(`/v1/assessments/${id}:publish`).set(auth(token));
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    return id;
  }

  async function invite(
    token: string,
    assessmentId: string,
    body: Record<string, unknown> = { kind: 'open' },
  ) {
    const res = await http
      .post(`/v1/assessments/${assessmentId}/invite-links`)
      .set(auth(token))
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { token: string; url: string; invite_id: string };
  }

  async function redeem(inviteToken: string, email = `cand-${newId()}@mail.example`) {
    const res = await http
      .post(`/v1/invite-links/${inviteToken}:redeem`)
      .send({ full_name: 'Test Candidate', email });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { session_id: string; session_token: string };
  }

  async function started(assessmentId: string, token = recruiterA) {
    const inv = await invite(token, assessmentId);
    const s = await redeem(inv.token);
    const start = await http
      .post(`/v1/sessions/${s.session_id}:start`)
      .set(session(s.session_token));
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    return s;
  }

  const answer = (
    s: { session_id: string; session_token: string },
    qid: string,
    rev: number,
    value: unknown,
  ) =>
    http
      .put(`/v1/sessions/${s.session_id}/responses/${qid}`)
      .set(session(s.session_token))
      .send({ client_rev: rev, answer: value });

  beforeAll(async () => {
    db = await createTestDatabase();
    const logger = createLogger({ service: 'assessment-svc', level: 'info', destination: logs });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        verifier: new JwtVerifier({ ...TEST_AUTH }),
        limiter: new MemoryRateLimiter(clock),
        profiles: new MemoryProfileDirectory(),
        sandbox,
        proctoring,
        interviews,
        settings: { ...DEFAULT_ASSESSMENT_SETTINGS, ssePollMs: 5, sessionRateLimit: 1000 },
        logger,
      }),
      { logger: false },
    );
    configureHttpApp(app, logger);
    await app.init();
    http = request(app.getHttpServer());
    consumer = createConsumer({
      name: ASSESSMENT_CONSUMER,
      db,
      handlers: app.get(AssessmentEventHandlers).handlers(),
    });
    results = app.get(ResultsService);
    recruiterA = await signTestToken({ sub: 'rec-a', tid: tenantA, roles: ['recruiter'] });
    recruiterB = await signTestToken({ sub: 'rec-b', tid: tenantB, roles: ['recruiter'] });
    reviewer1 = await signTestToken({ sub: 'rev-1', tid: tenantA, roles: ['reviewer'] });
    reviewer2 = await signTestToken({ sub: 'rev-2', tid: tenantA, roles: ['reviewer'] });
    candidateJwt = await signTestToken({ sub: 'cand-1', tid: tenantA, roles: ['candidate'] });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('AT1 + AT6: publish, invite, start, answer, submit → score, band, per-skill proficiency', () => {
    it('scores correctly and announces per-skill proficiency', async () => {
      clock.set(NOW);
      const mcq = await question(recruiterA, {
        type: 'mcq',
        prompt: 'Which collection keeps insertion order?',
        payload: {
          options: [
            { id: 'a', text: 'HashSet', correct: false },
            { id: 'b', text: 'LinkedHashSet', correct: true },
          ],
        },
        marks: 2,
        skill_ids: [skill.java],
      });
      const tf = await question(recruiterA, {
        type: 'true_false',
        prompt: 'Java strings are immutable.',
        payload: { correct: true },
        marks: 1,
        skill_ids: [skill.java],
      });
      const multi = await question(recruiterA, {
        type: 'multiple_answer',
        prompt: 'Which are SQL aggregates?',
        payload: {
          options: [
            { id: 'a', text: 'COUNT', correct: true },
            { id: 'b', text: 'SUM', correct: true },
            { id: 'c', text: 'JOIN', correct: false },
            { id: 'd', text: 'AVG', correct: true },
          ],
          partial_credit: true,
        },
        marks: 3,
        skill_ids: [skill.sql],
      });
      const blank = await question(recruiterA, {
        type: 'fill_blank',
        prompt: 'The SQL keyword that filters groups is ____.',
        payload: { accepted: ['HAVING'] },
        marks: 1,
        skill_ids: [skill.sql],
      });
      const bank = await http
        .post('/v1/question-banks')
        .set(auth(recruiterA))
        .send({ name: 'Java basics', skill_ids: [skill.java] });
      const bankQs = await Promise.all(
        [1, 2, 3].map((n) =>
          question(recruiterA, {
            bank_id: bank.body.bank_id,
            type: 'true_false',
            prompt: `Bank statement ${n} is true.`,
            payload: { correct: true },
            marks: 1,
            skill_ids: [skill.java],
          }),
        ),
      );
      const assessmentId = await published(recruiterA, {
        navigation: 'section_switch',
        report_config: {
          bands: [
            { name: 'Strong', min_percent: 80 },
            { name: 'Fair', min_percent: 50 },
            { name: 'Weak', min_percent: 0 },
          ],
          skill_validity_months: 12,
        },
        definition: {
          sections: [
            { title: 'Java', questions: [{ question_id: mcq }, { question_id: tf }] },
            {
              title: 'SQL',
              questions: [{ question_id: multi }, { question_id: blank }],
              banks: [{ bank_id: bank.body.bank_id, count: 2 }],
            },
          ],
        },
      });
      // Editing a published question creates v2; the published assessment keeps v1.
      const revised = await http
        .put(`/v1/questions/${mcq}`)
        .set(auth(recruiterA))
        .send({
          type: 'mcq',
          prompt: 'Changed',
          payload: {
            options: [
              { id: 'a', text: 'x', correct: true },
              { id: 'b', text: 'y', correct: false },
            ],
          },
          marks: 2,
        });
      expect(revised.body.version).toBe(2);

      const s = await started(assessmentId);
      const state = await http.get(`/v1/sessions/${s.session_id}`).set(session(s.session_token));
      expect(state.body).toMatchObject({
        status: 'started',
        question_count: 6,
        remaining_seconds: 1800,
      });

      const items = [];
      for (let n = 1; n <= 6; n++) {
        const q = await http
          .get(`/v1/sessions/${s.session_id}/questions/${n}`)
          .set(session(s.session_token));
        expect(q.status, JSON.stringify(q.body)).toBe(200);
        noHidden(q.body);
        items.push(q.body as { question_id: string; type: string; prompt: string });
      }
      expect(items[0]!.prompt).toBe('Which collection keeps insertion order?'); // the pinned v1
      const drawn = items.slice(4).map((i) => i.question_id);
      expect(new Set(drawn).size).toBe(2);
      expect(drawn.every((id) => bankQs.includes(id))).toBe(true);

      expect((await answer(s, mcq, 1, { option_id: 'a' })).status).toBe(200); // wrong first …
      const fixed = await answer(s, mcq, 2, { option_id: 'b' }); // … then corrected
      expect(fixed.body).toMatchObject({ client_rev: 2, remaining_seconds: 1800 });
      await answer(s, tf, 1, { value: true }); // +1
      await answer(s, multi, 1, { option_ids: ['a', 'b', 'c'] }); // (2 − 1)/3 of 3 = 1
      await answer(s, blank, 1, { text: '  having ' }); // +1 (case-insensitive, trimmed)
      await answer(s, drawn[0]!, 1, { value: true }); // +1
      await answer(s, drawn[1]!, 1, { value: false }); // 0

      const submitted = await http
        .post(`/v1/sessions/${s.session_id}:submit`)
        .set(session(s.session_token));
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      noHidden(submitted.body);

      const result = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      // 2 + 1 + 1 + 1 + 1 + 0 = 6 of 2 + 1 + 3 + 1 + 1 + 1 = 9 → 66.67 % → Fair
      expect(result.body).toMatchObject({
        status: 'evaluated',
        raw_score: 6,
        max_score: 9,
        percent_score: 66.67,
        performance_band: 'Fair',
      });
      expect(
        result.body.questions.find((q: { question_id: string }) => q.question_id === multi).score,
      ).toBe(1);

      const { rows } = await db.owner.query<{ topic: string; payload: Record<string, unknown> }>(
        `SELECT topic, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at, event_id`,
        [s.session_id],
      );
      expect(rows.map((r) => r.topic)).toEqual([
        'assessment.session.started.v1',
        'assessment.session.submitted.v1',
        'assessment.session.evaluated.v1',
      ]);
      const evaluated = rows[2]!.payload as {
        skills: { skill_id: string; score: number; confidence: number }[];
        valid_until: string;
      };
      // Java: 2 + 1 + 1 + 0 = 4 of 5 marks → 4.0 (4 items, confidence 0.8);
      // SQL: 1 + 1 = 2 of 4 marks → 2.5 (2 items, confidence 0.6). The scale is 0–5.
      expect(evaluated.skills).toEqual(
        expect.arrayContaining([
          { skill_id: skill.java, score: 4, confidence: 0.8 },
          { skill_id: skill.sql, score: 2.5, confidence: 0.6 },
        ]),
      );
      expect(evaluated.valid_until.slice(0, 7)).toBe('2027-11');

      const stats = await http.get(`/v1/questions/${mcq}?version=1`).set(auth(recruiterA));
      expect(stats.body.stats).toMatchObject({ attempts: 1, correct: 1, difficulty_index: null });
      const published2 = await http.get(`/v1/assessments/${assessmentId}`).set(auth(recruiterA));
      expect(
        (
          await http
            .put(`/v1/assessments/${assessmentId}`)
            .set({ ...auth(recruiterA), 'If-Match': `"${published2.body.lock_version}"` })
            .send({ title: 'x', duration_seconds: 60, definition: published2.body.definition })
        ).body.code,
      ).toBe('ASSESSMENT_PUBLISHED');
      const v2 = await http
        .post(`/v1/assessments/${assessmentId}:newVersion`)
        .set(auth(recruiterA));
      expect(v2.body).toMatchObject({ version: 2, status: 'draft' });
    });
  });

  describe('AT2: the deadline is the server’s', () => {
    it('rejects late answers and submits the drafts', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'Late?',
        payload: { correct: true },
        marks: 1,
        skill_ids: [skill.java],
      });
      const assessmentId = await published(recruiterA, {
        duration_seconds: 120,
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const s = await started(assessmentId);
      expect((await answer(s, q, 1, { value: true })).status).toBe(200);
      clock.advanceBy(121_000);
      const late = await answer(s, q, 2, { value: false });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('SESSION_EXPIRED');
      const submit = await http
        .post(`/v1/sessions/${s.session_id}:submit`)
        .set(session(s.session_token));
      expect(submit.status).toBe(409);
      const result = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(result.body).toMatchObject({ status: 'evaluated', raw_score: 1 }); // the acknowledged draft counted

      // The expiry workflow, with nobody calling: the sweeper submits the drafts.
      clock.set(NOW);
      const quiet = await started(assessmentId);
      await answer(quiet, q, 1, { value: true });
      clock.advanceBy(10 * 60_000);
      const swept = await results.sweep();
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      const sweptResult = await http
        .get(`/v1/sessions/${quiet.session_id}/result`)
        .set(auth(recruiterA));
      expect(sweptResult.body).toMatchObject({ status: 'evaluated', raw_score: 1 });
      const outcome = await db.owner.query<{ payload: { outcome: string } }>(
        `SELECT payload FROM outbox_events WHERE topic = 'assessment.session.submitted.v1' AND aggregate_id = $1`,
        [quiet.session_id],
      );
      expect(outcome.rows[0]!.payload.outcome).toBe('expired');
    });

    it('pauses an interrupted session and credits the time back, up to the allowance', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'Pause?',
        payload: { correct: true },
        marks: 1,
      });
      const assessmentId = await published(recruiterA, {
        duration_seconds: 600,
        settings: { pause_allowance_seconds: 120 },
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const s = await started(assessmentId);
      clock.advanceBy(45_000); // no heartbeat for 45 s
      await results.sweep();
      const paused = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(paused.body.status).toBe('paused');
      clock.advanceBy(155_000); // back after 200 s in total; only 120 s are credited
      const resumed = await http
        .post(`/v1/sessions/${s.session_id}:heartbeat`)
        .set(session(s.session_token));
      expect(resumed.body.status).toBe('in_progress');
      expect(resumed.body.deadline_at).toBe(
        new Date(NOW.getTime() + (600 + 120) * 1000).toISOString(),
      );
      expect(resumed.body.remaining_seconds).toBe(600 + 120 - 200);
    });
  });

  describe('AT3: concurrent submits', () => {
    it('lets exactly one win', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'Race?',
        payload: { correct: true },
        marks: 1,
      });
      const assessmentId = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const s = await started(assessmentId);
      await answer(s, q, 1, { value: true });
      const outcomes = await Promise.all(
        [1, 2, 3].map(() =>
          http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token)),
        ),
      );
      expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      const submitted = await db.owner.query(
        `SELECT 1 FROM outbox_events WHERE topic = 'assessment.session.submitted.v1' AND aggregate_id = $1`,
        [s.session_id],
      );
      expect(submitted.rows).toHaveLength(1);
      // The token still reads the ended session during the grace period, then stops working.
      expect(
        (await http.get(`/v1/sessions/${s.session_id}`).set(session(s.session_token))).status,
      ).toBe(200);
      clock.advanceBy(3601_000);
      const late = await http.get(`/v1/sessions/${s.session_id}`).set(session(s.session_token));
      expect(late.status).toBe(401);
      expect(late.body.code).toBe('SESSION_TOKEN_EXPIRED');
    });
  });

  describe('AT4: isolation and hidden answers', () => {
    it('binds the session token to its session and its tenant', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'fill_blank',
        prompt: 'Secret word?',
        payload: { accepted: ['swordfish'] },
        marks: 1,
      });
      const assessmentId = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const mine = await started(assessmentId);
      const theirs = await started(assessmentId);
      const crossed = await http
        .get(`/v1/sessions/${theirs.session_id}`)
        .set(session(mine.session_token));
      expect(crossed.status).toBe(401);
      expect(crossed.body.code).toBe('SESSION_TOKEN_INVALID');
      expect(
        (
          await http
            .get(`/v1/sessions/${theirs.session_id}/questions/1`)
            .set(session(mine.session_token))
        ).status,
      ).toBe(401);
      const missing = await http.get(`/v1/sessions/${mine.session_id}`);
      expect(missing.status).toBe(401);
      expect(missing.body.code).toBe('SESSION_TOKEN_REQUIRED');
      expect(
        (await http.get(`/v1/sessions/${mine.session_id}/result`).set(auth(candidateJwt))).status,
      ).toBe(403);
      expect(
        (await http.get(`/v1/sessions/${mine.session_id}/result`).set(auth(recruiterB))).status,
      ).toBe(404);
      expect((await http.get(`/v1/assessments/${assessmentId}`).set(auth(recruiterB))).status).toBe(
        404,
      );
      const q1 = await http
        .get(`/v1/sessions/${mine.session_id}/questions/1`)
        .set(session(mine.session_token));
      noHidden(q1.body);
      expect(JSON.stringify(q1.body)).not.toContain('swordfish');
      const saved = await answer(mine, q, 1, { text: 'guess' });
      noHidden(saved.body);
      const state = await http
        .get(`/v1/sessions/${mine.session_id}`)
        .set(session(mine.session_token));
      noHidden(state.body);
      expect(state.body).not.toHaveProperty('raw_score');
    });
  });

  describe('AT5: reviewers hold the score until all have finished', () => {
    it('releases the mean of all reviewers', async () => {
      clock.set(NOW);
      const essay = await question(recruiterA, {
        type: 'descriptive',
        prompt: 'Explain ACID.',
        payload: { rubric: 'Atomicity, consistency, isolation, durability' },
        marks: 10,
        skill_ids: [skill.writing],
      });
      const assessmentId = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: essay }] }] },
      });
      const s = await started(assessmentId);
      await answer(s, essay, 1, { text: 'Atomicity means …' });
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      const held = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(held.body).toMatchObject({
        status: 'submitted',
        review_status: 'pending_review',
        raw_score: null,
      });

      const assigned = await http
        .post(`/v1/sessions/${s.session_id}/reviewers`)
        .set(auth(recruiterA))
        .send({ reviewer_ids: ['rev-1', 'rev-2'] });
      expect(assigned.body.review_status).toBe('in_review');
      expect(
        (
          await http
            .post(`/v1/sessions/${s.session_id}:review`)
            .set(auth(recruiterB))
            .send({ scores: { [essay]: 5 } })
        ).status,
      ).toBe(404);
      const outsider = await signTestToken({ sub: 'rev-9', tid: tenantA, roles: ['reviewer'] });
      expect(
        (
          await http
            .post(`/v1/sessions/${s.session_id}:review`)
            .set(auth(outsider))
            .send({ scores: { [essay]: 5 } })
        ).status,
      ).toBe(403);
      expect(
        (
          await http
            .post(`/v1/sessions/${s.session_id}:review`)
            .set(auth(reviewer1))
            .send({ scores: { [essay]: 11 } })
        ).body.code,
      ).toBe('INVALID_MARKS');

      const first = await http
        .post(`/v1/sessions/${s.session_id}:review`)
        .set(auth(reviewer1))
        .send({ scores: { [essay]: 6 } });
      expect(first.body).toMatchObject({ released: false, pending_reviewers: 1 });
      expect(
        (await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA))).body
          .raw_score,
      ).toBeNull();
      const second = await http
        .post(`/v1/sessions/${s.session_id}:review`)
        .set(auth(reviewer2))
        .send({ scores: { [essay]: 9 }, comment: 'Thorough' });
      expect(second.body).toMatchObject({ released: true, status: 'evaluated' });
      const final = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(final.body).toMatchObject({
        status: 'evaluated',
        raw_score: 7.5,
        review_status: 'cleared',
      });
      expect(
        (
          await http
            .post(`/v1/sessions/${s.session_id}:review`)
            .set(auth(reviewer2))
            .send({ scores: { [essay]: 1 } })
        ).body.code,
      ).toBe('ALREADY_REVIEWED');

      const status = await http
        .patch(`/v1/sessions/${s.session_id}/candidate-status`)
        .set({ ...auth(recruiterA), 'If-Match': `"${final.body.lock_version}"` })
        .send({ status: 'shortlisted' });
      expect(status.body.candidate_status).toBe('shortlisted');
      // A second writer with the same (now stale) ETag loses: compare-and-set on lock_version.
      const lost = await http
        .patch(`/v1/sessions/${s.session_id}/candidate-status`)
        .set({ ...auth(recruiterA), 'If-Match': `"${final.body.lock_version}"` })
        .send({ status: 'rejected' });
      expect(lost.status).toBe(412);
      const shortlisted = await http
        .get(`/v1/assessments/${assessmentId}/sessions?candidate_status=shortlisted`)
        .set(auth(recruiterA));
      expect(shortlisted.body.items.map((i: { session_id: string }) => i.session_id)).toEqual([
        s.session_id,
      ]);
    });
  });

  describe('runtime rules', () => {
    it('enforces revisions, navigation, attempts and invite limits', async () => {
      clock.set(NOW);
      const a = await question(recruiterA, {
        type: 'true_false',
        prompt: 'A?',
        payload: { correct: true },
        marks: 1,
      });
      const b = await question(recruiterA, {
        type: 'true_false',
        prompt: 'B?',
        payload: { correct: true },
        marks: 1,
      });
      const assessmentId = await published(recruiterA, {
        settings: { max_attempts: 2, retake_cooldown_days: 1 },
        definition: {
          sections: [
            { title: 'One', questions: [{ question_id: a }] },
            { title: 'Two', questions: [{ question_id: b }] },
          ],
        },
      });
      const inv = await invite(recruiterA, assessmentId);
      const email = 'repeat@mail.example';
      const s = await redeem(inv.token, email);
      const before = await http
        .get(`/v1/sessions/${s.session_id}/questions/1`)
        .set(session(s.session_token));
      expect(before.body.code).toBe('SESSION_NOT_STARTED');
      await http.post(`/v1/sessions/${s.session_id}:start`).set(session(s.session_token));
      expect((await answer(s, a, 2, { value: true })).body).toMatchObject({
        code: 'STALE_REVISION',
        client_rev: 0,
      });
      expect((await answer(s, a, 1, { value: 'yes' })).status).toBe(400);
      await answer(s, a, 1, { value: true });
      expect((await answer(s, a, 1, { value: false })).body.code).toBe('STALE_REVISION'); // a replayed save
      await answer(s, b, 1, { value: true }); // opens section two …
      expect((await answer(s, a, 2, { value: false })).body.code).toBe('SECTION_LOCKED'); // … closing section one
      expect(
        (await http.post(`/v1/invite-links/${inv.token}:redeem`).send({ full_name: 'R', email }))
          .body.code,
      ).toBe('SESSION_EXISTS');
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      expect(
        (await http.post(`/v1/invite-links/${inv.token}:redeem`).send({ full_name: 'R', email }))
          .body.code,
      ).toBe('RETAKE_COOLDOWN');
      clock.advanceBy(2 * 24 * 3600_000);
      const retake = await redeem(inv.token, email);
      const attempts = await db.owner.query<{ attempt_no: number }>(
        'SELECT attempt_no FROM assessment_sessions WHERE session_id = $1',
        [retake.session_id],
      );
      expect(attempts.rows[0]!.attempt_no).toBe(2);
      await http.post(`/v1/sessions/${retake.session_id}:start`).set(session(retake.session_token));
      await http
        .post(`/v1/sessions/${retake.session_id}:submit`)
        .set(session(retake.session_token));
      clock.advanceBy(2 * 24 * 3600_000);
      expect(
        (await http.post(`/v1/invite-links/${inv.token}:redeem`).send({ full_name: 'R', email }))
          .body.code,
      ).toBe('MAX_ATTEMPTS');

      const targeted = await invite(recruiterA, assessmentId, {
        kind: 'targeted',
        candidate_id: newId(),
      });
      expect((await http.post(`/v1/invite-links/${targeted.token}:redeem`).send({})).status).toBe(
        201,
      );
      expect(
        (await http.post(`/v1/invite-links/${targeted.token}:redeem`).send({})).body.code,
      ).toBe('SESSION_EXISTS');
      const open = await invite(recruiterA, assessmentId, { kind: 'open', max_uses: 1 });
      await redeem(open.token);
      expect(
        (
          await http
            .post(`/v1/invite-links/${open.token}:redeem`)
            .send({ full_name: 'X', email: 'x@mail.example' })
        ).body.code,
      ).toBe('INVITE_EXHAUSTED');
      expect((await http.post(`/v1/invite-links/${open.token}:redeem`).send({})).body.code).toBe(
        'DETAILS_REQUIRED',
      );
      await http.delete(`/v1/invite-links/${open.invite_id}`).set(auth(recruiterA));
      expect(
        (await http.post(`/v1/invite-links/inv_${'x'.repeat(30)}:redeem`).send({})).status,
      ).toBe(404);
    });
  });

  describe('authoring lifecycle', () => {
    it('edits drafts with If-Match, clones, lists, retires and closes assessments', async () => {
      clock.set(NOW);
      const qid = await question(recruiterA, {
        type: 'true_false',
        prompt: 'Draft?',
        payload: { correct: true },
        marks: 1,
      });
      const def = { sections: [{ title: 'S', questions: [{ question_id: qid }] }] };
      const created = await http
        .post('/v1/assessments')
        .set(auth(recruiterA))
        .send({ title: 'Draft', duration_seconds: 600, definition: def });
      const id = created.body.assessment_id as string;
      expect(created.headers['etag']).toBe('"0"');
      const edited = await http
        .put(`/v1/assessments/${id}`)
        .set({ ...auth(recruiterA), 'If-Match': '"0"' })
        .send({ title: 'Edited', duration_seconds: 900, definition: def });
      expect(edited.body).toMatchObject({
        title: 'Edited',
        duration_seconds: 900,
        lock_version: 1,
      });
      const stale = await http
        .put(`/v1/assessments/${id}`)
        .set({ ...auth(recruiterA), 'If-Match': '"0"' })
        .send({ title: 'Lost update', duration_seconds: 900, definition: def });
      expect(stale.status).toBe(412);
      const bad = await http
        .put(`/v1/assessments/${id}`)
        .set({ ...auth(recruiterA), 'If-Match': '"1"' })
        .send({ title: 'x', duration_seconds: 900, definition: { sections: [] } });
      expect(bad.body.code).toBe('INVALID_DEFINITION');
      expect(
        (
          await http
            .post(`/v1/assessments/${id}/invite-links`)
            .set(auth(recruiterA))
            .send({ kind: 'open' })
        ).body.code,
      ).toBe('NOT_PUBLISHED');
      expect(
        (
          await http
            .post(`/v1/assessments/${id}:setStatus`)
            .set(auth(recruiterA))
            .send({ status: 'inactive' })
        ).body.code,
      ).toBe('NOT_PUBLISHED');
      await http.post(`/v1/assessments/${id}:publish`).set(auth(recruiterA));
      expect(
        (await http.post(`/v1/assessments/${id}:publish`).set(auth(recruiterA))).body.code,
      ).toBe('ALREADY_PUBLISHED');
      const inv = await invite(recruiterA, id);
      const v2 = await http.post(`/v1/assessments/${id}:newVersion`).set(auth(recruiterA));
      expect(
        (await http.post(`/v1/assessments/${id}:newVersion`).set(auth(recruiterA))).body.code,
      ).toBe('DRAFT_EXISTS');
      // While v2 is a draft, new invites still point at the published v1.
      const shared = await invite(recruiterA, id);
      const listed = await http.get(`/v1/assessments/${id}/invite-links`).set(auth(recruiterA));
      expect(
        listed.body.items.map((i: { assessment_version: number }) => i.assessment_version),
      ).toEqual([1, 1]);
      expect(v2.body.version).toBe(2);
      expect(shared.token).toMatch(/^inv_/);

      const copy = await http.post(`/v1/assessments/${id}:clone`).set(auth(recruiterA));
      expect(copy.body).toMatchObject({ version: 1, status: 'draft', title: 'Edited (copy)' });
      expect(copy.body.assessment_id).not.toBe(id);
      const drafts = await http.get('/v1/assessments?status=draft').set(auth(recruiterA));
      expect(drafts.body.items.map((a: { assessment_id: string }) => a.assessment_id)).toEqual(
        expect.arrayContaining([copy.body.assessment_id]),
      );
      expect(
        (await http.get(`/v1/assessments/${id}?version=1`).set(auth(recruiterA))).body.status,
      ).toBe('published');

      const qs = await http.get('/v1/questions?limit=200').set(auth(recruiterA));
      expect(qs.body.items.some((x: { question_id: string }) => x.question_id === qid)).toBe(true);
      expect((await http.post(`/v1/questions/${qid}:retire`).set(auth(recruiterA))).status).toBe(
        204,
      );
      expect((await http.get(`/v1/questions/${qid}`).set(auth(recruiterA))).body.status).toBe(
        'retired',
      );
      expect(
        (
          await http
            .put(`/v1/questions/${qid}`)
            .set(auth(recruiterA))
            .send({
              type: 'mcq',
              prompt: 'x',
              payload: {
                options: [
                  { id: 'a', text: 'a', correct: true },
                  { id: 'b', text: 'b', correct: false },
                ],
              },
            })
        ).body.code,
      ).toBe('TYPE_IMMUTABLE');
      expect(
        (
          await http
            .post('/v1/questions')
            .set(auth(recruiterA))
            .send({ type: 'mcq', prompt: 'x', payload: { options: [] } })
        ).status,
      ).toBe(400);
      expect(
        (
          await http
            .post('/v1/questions')
            .set(auth(candidateJwt))
            .send({ type: 'true_false', prompt: 'x', payload: { correct: true } })
        ).status,
      ).toBe(403);

      // Closing the published v1 (while v2 is still a draft) stops new attempts.
      const closed = await http
        .post(`/v1/assessments/${id}:setStatus?version=1`)
        .set(auth(recruiterA))
        .send({ status: 'inactive' });
      expect(closed.body).toMatchObject({ version: 1, status: 'inactive' });
      expect(
        (
          await http
            .post(`/v1/invite-links/${inv.token}:redeem`)
            .send({ full_name: 'Late', email: 'late@mail.example' })
        ).body.code,
      ).toBe('ASSESSMENT_UNAVAILABLE');
      await expect(
        db.owner.query(
          `UPDATE assessments SET definition = '{}'::jsonb WHERE assessment_id = $1 AND version = 1`,
          [id],
        ),
      ).rejects.toThrow(/immutable/);
    });
  });

  describe('events from other bricks', () => {
    const codingPayload = (reference = 'print(input()[::-1])') => ({
      languages: ['python', 'cpp'],
      starter_code: { python: 'def rev(s):\n  pass' },
      tests: [
        { input: 'ab', expected: 'ba', hidden: false },
        { input: 'abc', expected: 'cba', weight: 3 },
      ],
      reference_solution: { language: 'python', code: reference },
    });

    const codingQuestion = (reference?: string) =>
      question(recruiterA, {
        type: 'coding',
        prompt: 'Reverse a string.',
        payload: codingPayload(reference),
        marks: 10,
        skill_ids: [skill.java],
      });

    const judged = (
      s: { session_id: string },
      qid: string,
      submissionId: string,
      extra: Record<string, unknown> = {},
    ) =>
      emit(SubmissionJudged.topic, tenantA, submissionId, {
        tenant_id: tenantA,
        session_id: s.session_id,
        question_id: qid,
        submission_id: submissionId,
        verdict: 'wrong_answer',
        tests_passed: 1,
        tests_total: 2,
        judged_at: NOW.toISOString(),
        ...extra,
      });

    const submissionOf = (sessionId: string, qid: string) =>
      [...sandbox.submissions.entries()].find(
        ([, v]) => v.sessionId === sessionId && v.questionId === qid,
      )?.[0];

    it('scores coding answers from the judge, after the session ended', async () => {
      clock.set(NOW);
      const code = await codingQuestion();
      const assessmentId = await published(recruiterA, {
        kind: 'coding',
        definition: { sections: [{ title: 'S', questions: [{ question_id: code }] }] },
      });
      const s = await started(assessmentId);
      const view = await http
        .get(`/v1/sessions/${s.session_id}/questions/1`)
        .set(session(s.session_token));
      expect(view.body.coding).toEqual({
        languages: ['python', 'cpp'],
        starter_code: { python: 'def rev(s):\n  pass' },
      });
      noHidden(view.body);
      // A saved draft, never submitted: the session submit sends it to the judge.
      await answer(s, code, 1, { language: 'python', code: 'print(input()[::-1])' });
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      const auto = submissionOf(s.session_id, code);
      expect(auto, 'draft auto-submitted').toBeDefined();
      expect(sandbox.submissions.get(auto ?? '')?.body).toMatchObject({
        language: 'python',
        source: 'print(input()[::-1])',
        question_version: 1,
      });
      expect(sandbox.submissions.get(auto ?? '')?.body.active_until).toBeUndefined();
      expect(
        (await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA))).body.status,
      ).toBe('submitted'); // waiting for the judge
      // The weighted share counts (1 of 2 tests passed, but the passed one weighs 1 of 4).
      await judged(s, code, auto ?? '', { score_ratio: 0.25 });
      const result = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(result.body).toMatchObject({ status: 'evaluated', raw_score: 2.5, max_score: 10 });

      // Judged DURING the session (a mid-test "submit code"): submitting keeps that result.
      const early = await started(assessmentId);
      const sub = await http
        .post(`/v1/sessions/${early.session_id}/questions/${code}/submissions`)
        .set(session(early.session_token))
        .send({ language: 'python', code: 'print(input()[::-1])' });
      expect(sub.status, JSON.stringify(sub.body)).toBe(202);
      await judged(early, code, sub.body.submission_id, {
        verdict: 'accepted',
        tests_passed: 2,
        score_ratio: 1,
      });
      await http.post(`/v1/sessions/${early.session_id}:submit`).set(session(early.session_token));
      const kept = await http.get(`/v1/sessions/${early.session_id}/result`).set(auth(recruiterA));
      expect(kept.body).toMatchObject({ status: 'evaluated', raw_score: 10 });
      expect(
        [...sandbox.submissions.values()].filter((v) => v.sessionId === early.session_id),
      ).toHaveLength(1); // nothing re-submitted at the end
    });

    it('gates publishing on verified coding tests', async () => {
      clock.set(NOW);
      const draft = async (qid: string) => {
        const created = await http
          .post('/v1/assessments')
          .set(auth(recruiterA))
          .send({
            title: 'Coding',
            kind: 'coding',
            duration_seconds: 1800,
            definition: { sections: [{ title: 'S', questions: [{ question_id: qid }] }] },
          });
        return http
          .post(`/v1/assessments/${created.body.assessment_id as string}:publish`)
          .set(auth(recruiterA));
      };
      const noRef = await question(recruiterA, {
        type: 'coding',
        prompt: 'P',
        payload: { languages: ['python'], tests: [{ input: '1', expected: '1' }] },
      });
      expect((await draft(noRef)).body.code).toBe('REFERENCE_SOLUTION_REQUIRED');
      expect((await draft(await codingQuestion('PENDING'))).body).toMatchObject({
        status: 422,
        code: 'CODING_TESTS_PENDING',
      });
      const flaky = await draft(await codingQuestion('FLAKY'));
      expect(flaky.body.code).toBe('CODING_TESTS_INVALID');
      expect(flaky.body.detail).toContain('RESULTS_DIFFER');
      // A coding question in a referenced bank is checked too.
      const bank = await http
        .post('/v1/question-banks')
        .set(auth(recruiterA))
        .send({ name: 'Algorithms' });
      await question(recruiterA, {
        type: 'coding',
        bank_id: bank.body.bank_id,
        prompt: 'Wrong reference',
        payload: codingPayload('WRONG'),
      });
      const fixed = await codingQuestion();
      const withBank = await http
        .post('/v1/assessments')
        .set(auth(recruiterA))
        .send({
          title: 'Bank',
          duration_seconds: 1800,
          definition: {
            sections: [
              {
                title: 'S',
                questions: [{ question_id: fixed }],
                banks: [{ bank_id: bank.body.bank_id, count: 1 }],
              },
            ],
          },
        });
      const bankPub = await http
        .post(`/v1/assessments/${withBank.body.assessment_id as string}:publish`)
        .set(auth(recruiterA));
      expect(bankPub.body.code).toBe('CODING_TESTS_INVALID');
      // The judge is down: 503, nothing published.
      sandbox.failing = true;
      try {
        expect((await draft(await codingQuestion())).status).toBe(503);
      } finally {
        sandbox.failing = false;
      }
      // Verified: published, with the languages to pre-warm in the event.
      const ok = await draft(await codingQuestion());
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const event = await db.owner.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM outbox_events WHERE topic = 'assessment.assessment.published.v1' AND aggregate_id = $1`,
        [ok.body.assessment_id],
      );
      expect(event.rows[0]?.payload['coding_languages']).toEqual(['cpp', 'python']);
      // Registered with sandbox-svc as written, reference included.
      expect([...sandbox.bundles.values()].at(-1)).toMatchObject({
        languages: ['python', 'cpp'],
        tests: [
          { input: 'ab', expected: 'ba', hidden: false },
          { input: 'abc', expected: 'cba', hidden: true, weight: 3 },
        ],
        reference_solution: { language: 'python', source: 'print(input()[::-1])' },
      });
    });

    it('forwards runs and submissions for live sessions only', async () => {
      clock.set(NOW);
      const code = await codingQuestion();
      const tf = await question(recruiterA, {
        type: 'true_false',
        prompt: 'T?',
        payload: { correct: true },
      });
      const assessmentId = await published(recruiterA, {
        kind: 'mixed',
        definition: {
          sections: [{ title: 'S', questions: [{ question_id: code }, { question_id: tf }] }],
        },
      });
      const s = await started(assessmentId);
      const other = await started(assessmentId);
      const base = `/v1/sessions/${s.session_id}`;
      const run = await http
        .post(`${base}/questions/${code}/runs`)
        .set(session(s.session_token))
        .send({ language: 'python', code: 'print(1)', stdin: '42' });
      expect(run.status, JSON.stringify(run.body)).toBe(202);
      expect(sandbox.runs.get(run.body.run_id)?.body).toMatchObject({
        language: 'python',
        source: 'print(1)',
        stdin: '42',
        active_until: new Date(NOW.getTime() + 1800_000).toISOString(),
      });
      const got = await http
        .get(`${base}/runs/${run.body.run_id as string}?wait=2`)
        .set(session(s.session_token));
      expect(got.body).toMatchObject({ status: 'accepted', stdout: '42' });
      // Another session's token cannot read it.
      expect(
        (
          await http
            .get(`/v1/sessions/${other.session_id}/runs/${run.body.run_id as string}`)
            .set(session(other.session_token))
        ).status,
      ).toBe(404);
      const rejected = [
        [{ language: 'java', code: 'x' }, code, 'LANGUAGE_NOT_ALLOWED'],
        [{ language: 'python', code: 'x' }, tf, 'NOT_A_CODING_QUESTION'],
        [{ language: 'python', code: 'x', extra: 1 }, code, 'VALIDATION_FAILED'],
      ] as const;
      for (const [body, qid, codeName] of rejected) {
        const r = await http
          .post(`${base}/questions/${qid}/runs`)
          .set(session(s.session_token))
          .send(body);
        expect(r.body.code, JSON.stringify(r.body)).toBe(codeName);
      }
      // The judge's throttle reaches the candidate with Retry-After.
      sandbox.rejectNext = new ServiceRejectedError(
        429,
        'RUN_THROTTLED',
        'One run every 3 seconds.',
        2,
      );
      const throttled = await http
        .post(`${base}/questions/${code}/runs`)
        .set(session(s.session_token))
        .send({ language: 'python', code: 'x' });
      expect(throttled.status).toBe(429);
      expect(throttled.body.code).toBe('RUN_THROTTLED');
      expect(throttled.headers['retry-after']).toBe('2');

      // Submissions: the same code is one submission; the view is checked against the session.
      const submit = () =>
        http
          .post(`${base}/questions/${code}/submissions`)
          .set(session(s.session_token))
          .send({ language: 'python', code: 'print(input()[::-1])' });
      const first = await submit();
      const again = await submit();
      expect(again.body.submission_id).toBe(first.body.submission_id);
      expect(
        (
          await http
            .get(`${base}/submissions/${first.body.submission_id as string}`)
            .set(session(s.session_token))
        ).body,
      ).toMatchObject({ status: 'queued' });
      expect(
        (
          await http
            .get(
              `/v1/sessions/${other.session_id}/submissions/${first.body.submission_id as string}`,
            )
            .set(session(other.session_token))
        ).status,
      ).toBe(404);
      // After the deadline: nothing reaches the judge from the candidate.
      clock.set(new Date(NOW.getTime() + 1801_000));
      const late = await http
        .post(`${base}/questions/${code}/runs`)
        .set(session(s.session_token))
        .send({ language: 'python', code: 'x' });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('SESSION_EXPIRED');
    });

    it('auto-submits drafts when sessions expire, retrying while the judge is down', async () => {
      clock.set(NOW);
      const code = await codingQuestion();
      const assessmentId = await published(recruiterA, {
        kind: 'coding',
        definition: { sections: [{ title: 'S', questions: [{ question_id: code }] }] },
      });
      const s = await started(assessmentId);
      await answer(s, code, 1, { language: 'cpp', code: 'int main(){}' });
      sandbox.failing = true;
      clock.set(new Date(NOW.getTime() + 1801_000));
      const swept = await results.sweep();
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      expect(submissionOf(s.session_id, code)).toBeUndefined();
      sandbox.failing = false;
      const retried = await results.sweep();
      expect(retried.dispatched).toBeGreaterThanOrEqual(1);
      const id = submissionOf(s.session_id, code);
      expect(sandbox.submissions.get(id ?? '')?.body).toMatchObject({
        language: 'cpp',
        source: 'int main(){}',
      });
      expect((await results.sweep()).dispatched).toBe(0); // sent once
      await judged(s, code, id ?? '', { verdict: 'accepted', tests_passed: 2, score_ratio: 1 });
      expect(
        (await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA))).body,
      ).toMatchObject({ status: 'evaluated', raw_score: 10 });
    });

    it('ignores stale judge results and sends judge failures to a reviewer', async () => {
      clock.set(NOW);
      const code = await codingQuestion();
      const assessmentId = await published(recruiterA, {
        kind: 'coding',
        definition: { sections: [{ title: 'S', questions: [{ question_id: code }] }] },
      });
      const s = await started(assessmentId);
      const send = (src: string) =>
        http
          .post(`/v1/sessions/${s.session_id}/questions/${code}/submissions`)
          .set(session(s.session_token))
          .send({ language: 'python', code: src });
      const older = (await send('v1')).body.submission_id as string;
      clock.set(new Date(NOW.getTime() + 60_000));
      const newer = (await send('v2')).body.submission_id as string;
      // The newer result arrives first; the older one, delivered late, does not overwrite it.
      await judged(s, code, newer, {
        verdict: 'accepted',
        tests_passed: 2,
        score_ratio: 1,
        submitted_at: new Date(NOW.getTime() + 60_000).toISOString(),
      });
      await judged(s, code, older, { submitted_at: NOW.toISOString(), score_ratio: 0 });
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      expect(
        (await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA))).body,
      ).toMatchObject({ status: 'evaluated', raw_score: 10 });

      // internal_error: never charged; a reviewer scores the answer instead.
      const t = await started(assessmentId);
      await answer(t, code, 1, { language: 'python', code: 'v3' });
      await http.post(`/v1/sessions/${t.session_id}:submit`).set(session(t.session_token));
      const auto = submissionOf(t.session_id, code) ?? '';
      await judged(t, code, auto, { verdict: 'internal_error', tests_passed: 0, tests_total: 0 });
      const held = await http.get(`/v1/sessions/${t.session_id}/result`).set(auth(recruiterA));
      expect(held.body).toMatchObject({ status: 'submitted', review_status: 'pending_review' });
      expect(held.body.raw_score ?? null).toBeNull();
      await http
        .post(`/v1/sessions/${t.session_id}/reviewers`)
        .set(auth(recruiterA))
        .send({ reviewer_ids: ['rev-1'] });
      const reviewed = await http
        .post(`/v1/sessions/${t.session_id}:review`)
        .set(auth(reviewer1))
        .send({ scores: { [code]: 6 } });
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      expect(
        (await http.get(`/v1/sessions/${t.session_id}/result`).set(auth(recruiterA))).body,
      ).toMatchObject({ status: 'evaluated', raw_score: 6, review_status: 'cleared' });
    });

    /** A producer's recorded payload (packages/contracts/fixtures), with placeholders filled. */
    const fixture = (name: string, values: Record<string, string>) => {
      const text = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'packages', 'contracts', 'fixtures', name),
        'utf8',
      ).replace(/"\{\{(\w+)\}\}"/g, (_, key: string) => JSON.stringify(values[key]));
      return JSON.parse(text) as { topic: string; payload: Record<string, unknown> };
    };

    it('starts proctoring for proctored assessments, with consent', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'P?',
        payload: { correct: true },
      });
      const plain = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const proctored = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
        settings: {
          proctoring: { enabled: true, id_verification: true, rules: { safe_browser: false } },
        },
      });
      const consent = { consent: { biometrics: true, version: '2026-11' } };
      const a = await started(plain);
      const notEnabled = await http
        .post(`/v1/sessions/${a.session_id}:startProctoring`)
        .set(session(a.session_token))
        .send(consent);
      expect(notEnabled.body.code).toBe('PROCTORING_NOT_ENABLED');
      const s = await started(proctored);
      const res = await http
        .post(`/v1/sessions/${s.session_id}:startProctoring`)
        .set(session(s.session_token))
        .send(consent);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ proctor_token: `apt_${s.session_id}`, next_seq: 1 });
      expect(proctoring.starts.at(-1)).toMatchObject({
        tenantId: tenantA,
        sessionId: s.session_id,
        body: {
          assessment_id: proctored,
          rules: { safe_browser: false },
          id_verification: true,
          consent: { biometrics: true, version: '2026-11', granted_at: NOW.toISOString() },
        },
      });
      const bad = await http
        .post(`/v1/sessions/${s.session_id}:startProctoring`)
        .set(session(s.session_token))
        .send({ consent: { biometrics: 'yes' } });
      expect(bad.status).toBe(400);
      // proctoring-svc's refusals reach the candidate with their code.
      proctoring.start = () =>
        Promise.reject(new ServiceRejectedError(422, 'CONSENT_REQUIRED', 'Consent needed.', null));
      const refused = await http
        .post(`/v1/sessions/${s.session_id}:startProctoring`)
        .set(session(s.session_token))
        .send({ consent: { biometrics: false, version: '2026-11' } });
      expect(refused.body).toMatchObject({ status: 422, code: 'CONSENT_REQUIRED' });
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      const ended = await http
        .post(`/v1/sessions/${s.session_id}:startProctoring`)
        .set(session(s.session_token))
        .send(consent);
      expect(ended.status).toBe(409);
    });

    it('honours the proctoring-svc contract: termination and a red Trust Score', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'P?',
        payload: { correct: true },
      });
      const assessmentId = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      // Termination, as proctoring-svc produced it (services/proctoring-svc/test).
      const live = await started(assessmentId);
      const term = fixture('proctoring.violation.raised.v1.terminate.json', {
        tenant_id: tenantA,
        session_id: live.session_id,
        occurred_at: NOW.toISOString(),
      });
      await emit(term.topic, tenantA, live.session_id, term.payload);
      const terminated = await http
        .get(`/v1/sessions/${live.session_id}/result`)
        .set(auth(recruiterA));
      expect(terminated.body).toMatchObject({
        status: 'evaluated',
        trust_score: term.payload['trust_score'],
      });
      // A red Trust Score: recorded and sent to human review, never an automatic rejection.
      const done = await started(assessmentId);
      await answer(done, q, 1, true);
      await http.post(`/v1/sessions/${done.session_id}:submit`).set(session(done.session_token));
      const red = fixture('proctoring.session.finalized.v1.red.json', {
        tenant_id: tenantA,
        session_id: done.session_id,
        assessment_id: assessmentId,
        occurred_at: NOW.toISOString(),
      });
      await emit(red.topic, tenantA, done.session_id, red.payload);
      const result = await http.get(`/v1/sessions/${done.session_id}/result`).set(auth(recruiterA));
      expect(result.body).toMatchObject({
        trust_score: red.payload['trust_score'],
        review_status: 'pending_review',
        candidate_status: 'pending',
      });
    });

    it('terminates on a proctoring violation and closes the event stream', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'P?',
        payload: { correct: true },
        marks: 1,
        skill_ids: [skill.java],
      });
      const assessmentId = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const s = await started(assessmentId);
      await emit(ViolationRaised.topic, tenantA, s.session_id, {
        tenant_id: tenantA,
        session_id: s.session_id,
        rule: 'multiple_faces',
        severity: 3,
        action: 'terminate',
        trust_score: 22,
        occurred_at: NOW.toISOString(),
      });
      const result = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(result.body).toMatchObject({
        status: 'evaluated',
        trust_score: 22,
        termination_reason: 'proctoring: multiple_faces',
      });
      const evaluated = await db.owner.query(
        `SELECT 1 FROM outbox_events WHERE topic = 'assessment.session.evaluated.v1' AND aggregate_id = $1`,
        [s.session_id],
      );
      expect(evaluated.rows).toEqual([]); // no skill evidence from a terminated session
      expect((await answer(s, q, 1, { value: true })).body.code).toBe('SESSION_ENDED');

      const stream = await http
        .get(`/v1/sessions/${s.session_id}/events`)
        .set(session(s.session_token));
      expect(stream.headers['content-type']).toContain('text/event-stream');
      const names = stream.text
        .split('\n')
        .filter((l) => l.startsWith('event: '))
        .map((l) => l.slice(7));
      expect(names).toEqual(['state', 'terminated', 'ended']);
    });

    it('scores AI interview questions, and sends low-confidence ones to review', async () => {
      clock.set(NOW);
      const spoken = await question(recruiterA, {
        type: 'descriptive',
        prompt: 'Tell us about a hard bug.',
        payload: { rubric: 'STAR' },
        marks: 4,
      });
      const assessmentId = await published(recruiterA, {
        kind: 'ai_interview',
        definition: { sections: [{ title: 'S', questions: [{ question_id: spoken }] }] },
      });
      const s = await started(assessmentId);
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      await emit(InterviewCompleted.topic, tenantA, s.session_id, {
        tenant_id: tenantA,
        session_id: s.session_id,
        question_id: spoken,
        score_ratio: 0.75,
        needs_review: false,
        completed_at: NOW.toISOString(),
      });
      const result = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(result.body.questions[0]).toMatchObject({ state: 'scored' });
    });

    it('starts AI interview questions and honours the interview-svc contract', async () => {
      clock.set(NOW);
      const interviewId = '0192f0c1-0000-7000-8000-0000000000aa';
      const iq = await question(recruiterA, {
        type: 'ai_interview',
        prompt: 'AI interview: working capital',
        payload: { interview_id: interviewId },
        marks: 10,
      });
      const tf = await question(recruiterA, {
        type: 'true_false',
        prompt: 'T?',
        payload: { correct: true },
        marks: 1,
      });
      const badPayload = await http
        .post('/v1/questions')
        .set(auth(recruiterA))
        .send({ type: 'ai_interview', prompt: 'X', payload: { interview_id: 'nope' } });
      expect(badPayload.status).toBe(400);
      const assessmentId = await published(recruiterA, {
        kind: 'mixed',
        definition: {
          sections: [{ title: 'S', questions: [{ question_id: iq }, { question_id: tf }] }],
        },
      });
      const s = await started(assessmentId);
      // The candidate cannot write the interview's answer.
      expect((await answer(s, iq, 1, { interview_session_id: interviewId })).body.code).toBe(
        'ANSWER_NOT_EDITABLE',
      );
      const notInterview = await http
        .post(`/v1/sessions/${s.session_id}/questions/${tf}:startInterview`)
        .set(session(s.session_token));
      expect(notInterview.body.code).toBe('NOT_AN_INTERVIEW_QUESTION');
      const res = await http
        .post(`/v1/sessions/${s.session_id}/questions/${iq}:startInterview`)
        .set(session(s.session_token));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ interview_token: 'ivt_1', mode: 'text' });
      expect(interviews.starts.at(-1)).toMatchObject({
        tenantId: tenantA,
        interviewId,
        body: {
          assessment_id: assessmentId,
          assessment_session_id: s.session_id,
          question_id: iq,
        },
      });
      // A reload resumes the same interview session with a fresh token; the answer stays.
      const again = await http
        .post(`/v1/sessions/${s.session_id}/questions/${iq}:startInterview`)
        .set(session(s.session_token));
      expect(again.body).toMatchObject({
        session_id: res.body.session_id,
        interview_token: 'ivt_2',
      });
      const view = await http
        .get(`/v1/sessions/${s.session_id}/questions/1`)
        .set(session(s.session_token));
      expect(view.body).toMatchObject({
        type: 'ai_interview',
        response: { interview_session_id: res.body.session_id },
        client_rev: 1,
      });
      // interview-svc's refusals reach the candidate with their code.
      const original = interviews.start.bind(interviews);
      interviews.start = () =>
        Promise.reject(
          new ServiceRejectedError(409, 'INTERVIEW_NOT_PUBLISHED', 'Not published.', null),
        );
      const refused = await http
        .post(`/v1/sessions/${s.session_id}/questions/${iq}:startInterview`)
        .set(session(s.session_token));
      expect(refused.body).toMatchObject({ status: 409, code: 'INTERVIEW_NOT_PUBLISHED' });
      interviews.start = original;
      await answer(s, tf, 1, { value: true });
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      const waiting = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(waiting.body.status).not.toBe('evaluated');
      // interview-svc's recorded payload: scored, but flagged for a person (approval required).
      const values = {
        tenant_id: tenantA,
        session_id: s.session_id,
        question_id: iq,
        interview_session_id: res.body.session_id as string,
        interview_id: interviewId,
        completed_at: NOW.toISOString(),
      };
      const review = fixture('interview.session.completed.v1.review.json', values);
      expect(review.topic).toBe(InterviewCompleted.topic);
      InterviewCompleted.schema.parse(review.payload);
      await emit(review.topic, tenantA, s.session_id, review.payload);
      const held = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(held.body).toMatchObject({ status: 'submitted', review_status: 'pending_review' });
      expect(
        held.body.questions.find((q: { question_id: string }) => q.question_id === iq),
      ).toMatchObject({
        state: 'pending_review',
      });
      // The recruiter's override (revision 2) settles it.
      const settled = fixture('interview.session.completed.v1.override.json', values);
      InterviewCompleted.schema.parse(settled.payload);
      await emit(settled.topic, tenantA, s.session_id, settled.payload);
      const final = await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA));
      expect(final.body).toMatchObject({ status: 'evaluated', review_status: 'cleared' });
      expect(
        final.body.questions.find((q: { question_id: string }) => q.question_id === iq),
      ).toMatchObject({
        state: 'scored',
        score: 7.5,
      });
    });

    it('lets a reviewer mark an AI interview that interview-svc sent to review', async () => {
      clock.set(NOW);
      const interviewId = '0192f0c1-0000-7000-8000-0000000000ab';
      const iq = await question(recruiterA, {
        type: 'ai_interview',
        prompt: 'AI interview',
        payload: { interview_id: interviewId },
        marks: 10,
      });
      const assessmentId = await published(recruiterA, {
        kind: 'ai_interview',
        definition: { sections: [{ title: 'S', questions: [{ question_id: iq }] }] },
      });
      const s = await started(assessmentId);
      const res = await http
        .post(`/v1/sessions/${s.session_id}/questions/${iq}:startInterview`)
        .set(session(s.session_token));
      await http.post(`/v1/sessions/${s.session_id}:submit`).set(session(s.session_token));
      const review = fixture('interview.session.completed.v1.review.json', {
        tenant_id: tenantA,
        session_id: s.session_id,
        question_id: iq,
        interview_session_id: res.body.session_id as string,
        interview_id: interviewId,
        completed_at: NOW.toISOString(),
      });
      await emit(review.topic, tenantA, s.session_id, review.payload);
      await http
        .post(`/v1/sessions/${s.session_id}/reviewers`)
        .set(auth(recruiterA))
        .send({ reviewer_ids: ['rev-1'] });
      const reviewed = await http
        .post(`/v1/sessions/${s.session_id}:review`)
        .set(auth(reviewer1))
        .send({ scores: { [iq]: 6 } });
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      expect(
        (await http.get(`/v1/sessions/${s.session_id}/result`).set(auth(recruiterA))).body,
      ).toMatchObject({ status: 'evaluated', raw_score: 6, review_status: 'cleared' });
    });

    it('streams time warnings to a live session', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'W?',
        payload: { correct: true },
        marks: 1,
      });
      const assessmentId = await published(recruiterA, {
        duration_seconds: 120,
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const s = await started(assessmentId);
      clock.advanceBy(70_000); // 50 s left: inside the 60 s warning
      setTimeout(() => {
        void emit(ViolationRaised.topic, tenantA, s.session_id, {
          tenant_id: tenantA,
          session_id: s.session_id,
          rule: 'end_stream',
          severity: 3,
          action: 'terminate',
          trust_score: null,
          occurred_at: NOW.toISOString(),
        });
      }, 50);
      const stream = await http
        .get(`/v1/sessions/${s.session_id}/events`)
        .set(session(s.session_token));
      const names = stream.text
        .split('\n')
        .filter((l) => l.startsWith('event: '))
        .map((l) => l.slice(7));
      expect(names.slice(0, 3)).toEqual(['state', 'time_warning', 'time_warning']);
      expect(names).toContain('terminated');
      expect(names.at(-1)).toBe('ended');
    });
  });

  describe('data protection', () => {
    it('erases a candidate’s sessions and acknowledges', async () => {
      clock.set(NOW);
      const q = await question(recruiterA, {
        type: 'true_false',
        prompt: 'E?',
        payload: { correct: true },
        marks: 1,
      });
      const assessmentId = await published(recruiterA, {
        definition: { sections: [{ title: 'S', questions: [{ question_id: q }] }] },
      });
      const s = await started(assessmentId);
      await answer(s, q, 1, { value: true });
      const { rows } = await db.owner.query<{ candidate_id: string }>(
        'SELECT candidate_id FROM assessment_sessions WHERE session_id = $1',
        [s.session_id],
      );
      const requestId = newId();
      await emit(ErasureRequested.topic, tenantA, requestId, {
        tenant_id: tenantA,
        request_id: requestId,
        candidate_id: rows[0]!.candidate_id,
        reason: 'data_subject',
        ack_required_from: ['assessment-svc'],
        due_at: NOW.toISOString(),
        occurred_at: NOW.toISOString(),
      });
      expect(
        (
          await db.owner.query('SELECT 1 FROM session_responses WHERE session_id = $1', [
            s.session_id,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (await http.get(`/v1/sessions/${s.session_id}`).set(session(s.session_token))).status,
      ).toBe(401);
      const acks = await db.owner.query<{ payload: { service: string } }>(
        `SELECT payload FROM outbox_events WHERE topic = 'privacy.erasure.acknowledged.v1' AND aggregate_id = $1`,
        [requestId],
      );
      expect(acks.rows.map((r) => r.payload.service)).toEqual(['assessment-svc']);
    });

    it('purges a tenant and keeps PII out of logs', async () => {
      await question(recruiterB, {
        type: 'true_false',
        prompt: 'B?',
        payload: { correct: true },
        marks: 1,
      });
      await emit(TenantPurged.topic, tenantB, tenantB, {
        tenant_id: tenantB,
        from_status: 'offboarding',
        to_status: 'purged',
        reason: null,
        actor: 'staff',
        occurred_at: NOW.toISOString(),
      });
      expect(
        (await db.owner.query('SELECT 1 FROM questions WHERE tenant_id = $1', [tenantB])).rows,
      ).toEqual([]);
      expect(JSON.stringify(logs.lines)).not.toContain('repeat@mail.example');
      expect((await http.get('/readyz')).body).toEqual({ status: 'ready' });
    });
  });
});

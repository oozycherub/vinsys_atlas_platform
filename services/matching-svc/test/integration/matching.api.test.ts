/**
 * Component Prompt 07 §8 acceptance tests against the real HTTP stack, the real event consumer and
 * Postgres (PGlite) running as the RLS-bound atlas_app role. parsing-svc, llm-gateway, taxonomy
 * and tenant-svc are replaced by the fakes in ./fakes.ts.
 */
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CandidateSkillsUpdated,
  ErasureRequested,
  JobProfileUpdated,
  ResumeParsed,
  TenantPurged,
  TenantSettingsUpdated,
} from '@atlas/contracts';
import {
  type Consumer,
  configureHttpApp,
  createConsumer,
  createLogger,
  FixedClock,
  JwtVerifier,
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
import { MATCHING_CONSUMER, MatchingEventHandlers } from '../../src/application/event-handlers';
import { DEFAULT_MATCHING_SETTINGS } from '../../src/application/ports';
import { RescoreWorker } from '../../src/application/worker';
import { MemoryMatchCache } from '../../src/infrastructure/cache';
import { PgLexicalIndex } from '../../src/infrastructure/lexical';
import { FakeEmbedder, FakeTaxonomy, FakeVectorSearch, FakeWeights } from './fakes';

const NOW = new Date('2026-11-05T10:00:00.000Z');

interface Seed {
  summary: string;
  roles: { title: string; employer: string; responsibilities: string[] }[];
  skills: { id: string; name: string; proficiency: number; validated?: boolean }[];
  months: number;
}

interface MatchResult {
  candidate_id: string;
  score: number;
  band: string;
  components: { sem: number; cov: number; exp: number; lex: number; gate: number };
  explanation: {
    matched: { skill_id: string; via?: { skill_id: string; rho: number } }[];
    partial: { skill_id: string; via?: { skill_id: string; rho: number } }[];
    gaps: { skill_id: string }[];
    must_have_failed: string[];
    evidence: { skill_id: string; snippet: string }[];
  };
}

describe('matching-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  let worker: RescoreWorker;
  const clock = new FixedClock(NOW);
  const vectors = new FakeVectorSearch();
  const embedder = new FakeEmbedder();
  const taxonomy = new FakeTaxonomy();
  const weights = new FakeWeights();
  const logs = new MemoryLogStream();
  const tenantA = newId();
  const tenantB = newId();
  const skill = {
    python: newId(),
    kafka: newId(),
    spark: newId(),
    pulsar: newId(),
    react: newId(),
  };
  const profileId = newId();
  let recruiterA: string;
  let recruiterB: string;
  let reviewerA: string;
  let candidateA: string;
  let service: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const emit = (
    topic: string,
    tenantId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) => consumer.handle({ eventId: newId(), topic, tenantId, aggregateId, payload });

  async function seedCandidate(tenantId: string, s: Seed, id = newId()): Promise<string> {
    const profile = {
      schema_version: '3.0',
      summary: s.summary,
      work_history: s.roles.map((r) => ({ ...r, skills_mentioned: [] })),
      education: [],
      certifications: [],
      projects: [],
      skills: s.skills.map((k) => ({ raw: k.name, skill_id: k.id, context: 'skills' })),
      languages: [],
      flags: [],
    };
    await emit(ResumeParsed.topic, tenantId, newId(), {
      tenant_id: tenantId,
      candidate_id: id,
      document_id: newId(),
      parser_version: 'v3.0.0',
      language: 'en',
      page_count: 1,
      flags: [],
      profile,
      current_title: s.roles[0]?.title ?? null,
      total_experience_months: s.months,
      skills: s.skills.map((k) => ({
        skill_id: k.id,
        proficiency: Math.min(3.5, k.proficiency),
        confidence: 0.5,
      })),
      occurred_at: NOW.toISOString(),
    });
    await emit(CandidateSkillsUpdated.topic, tenantId, id, {
      tenant_id: tenantId,
      candidate_id: id,
      skills: s.skills.map((k) => ({
        skill_id: k.id,
        proficiency: k.proficiency,
        is_validated: k.validated ?? false,
        calibration_needed: false,
      })),
      occurred_at: NOW.toISOString(),
    });
    vectors.addCandidate(tenantId, id, {
      profile_summary: s.summary,
      ...Object.fromEntries(
        s.roles.map((r, i) => [`experience_${i}`, [r.title, ...r.responsibilities].join(' ')]),
      ),
    });
    return id;
  }

  const strong: Seed = {
    summary: 'Senior data engineer building streaming data pipelines with Kafka, Spark and Python.',
    roles: [
      {
        title: 'Senior Data Engineer',
        employer: 'Northwind Systems',
        responsibilities: ['Built streaming pipelines with Kafka and Spark in Python'],
      },
    ],
    skills: [
      { id: skill.python, name: 'Python', proficiency: 4.5, validated: true },
      { id: skill.kafka, name: 'Kafka', proficiency: 4 },
      { id: skill.spark, name: 'Spark', proficiency: 3.5 },
    ],
    months: 96,
  };
  const related: Seed = {
    summary: 'Data engineer running event streaming on Pulsar with Python services.',
    roles: [
      {
        title: 'Data Engineer',
        employer: 'Bluefjord Analytics',
        responsibilities: ['Ran Pulsar event streaming for Python services'],
      },
    ],
    skills: [
      { id: skill.python, name: 'Python', proficiency: 4 },
      { id: skill.pulsar, name: 'Pulsar', proficiency: 4 },
      { id: skill.spark, name: 'Spark', proficiency: 2 },
    ],
    months: 72,
  };
  const weak: Seed = {
    summary: 'Frontend developer building React user interfaces.',
    roles: [
      {
        title: 'Frontend Developer',
        employer: 'Lanternfish Media',
        responsibilities: ['Built React components'],
      },
    ],
    skills: [
      { id: skill.react, name: 'React', proficiency: 4 },
      { id: skill.python, name: 'Python', proficiency: 1 },
    ],
    months: 24,
  };

  async function createRequisition(
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await http
      .post('/v1/job-requisitions')
      .set({ ...auth(token), 'Idempotency-Key': `create-${newId()}` })
      .send({
        title: 'Senior Data Engineer',
        description: 'Build streaming data pipelines with Kafka and Spark in Python.',
        job_profile_id: profileId,
        min_experience_years: 5,
        keywords: ['streaming', 'pipelines'],
        ...body,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.requisition_id as string;
  }

  async function calibrate(token: string, id: string, body: Record<string, unknown> = {}) {
    const res = await http.post(`/v1/job-requisitions/${id}:calibrate`).set(auth(token)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function match(token: string, id: string, body: Record<string, unknown> = {}) {
    const res = await http.post(`/v1/job-requisitions/${id}:match`).set(auth(token)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      weights_version: string;
      cached: boolean;
      total: number;
      results: MatchResult[];
    };
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const logger = createLogger({ service: 'matching-svc', level: 'info', destination: logs });
    taxonomy.profiles.set(profileId, {
      version: 1,
      title: 'Senior Data Engineer',
      skills: [
        { skill_id: skill.python, weight: 1, target_proficiency: 4, must_have: true },
        { skill_id: skill.kafka, weight: 0.8, target_proficiency: 3.5, must_have: false },
        { skill_id: skill.spark, weight: 0.5, target_proficiency: 3, must_have: false },
      ],
    });
    taxonomy.skills.set(skill.python, { name: 'Python', related: [] });
    taxonomy.skills.set(skill.kafka, {
      name: 'Kafka',
      related: [{ skill_id: skill.pulsar, rho: 0.9 }],
    });
    taxonomy.skills.set(skill.spark, { name: 'Spark', related: [] });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        verifier: new JwtVerifier({ ...TEST_AUTH }),
        vectors,
        embedder,
        taxonomy,
        weights,
        lexical: new PgLexicalIndex(db),
        cache: new MemoryMatchCache(),
        settings: DEFAULT_MATCHING_SETTINGS,
        logger,
      }),
      { logger: false },
    );
    configureHttpApp(app, logger);
    await app.init();
    http = request(app.getHttpServer());
    consumer = createConsumer({
      name: MATCHING_CONSUMER,
      db,
      handlers: app.get(MatchingEventHandlers).handlers(),
    });
    worker = app.get(RescoreWorker);
    recruiterA = await signTestToken({ sub: 'rec-a', tid: tenantA, roles: ['recruiter'] });
    recruiterB = await signTestToken({ sub: 'rec-b', tid: tenantB, roles: ['recruiter'] });
    reviewerA = await signTestToken({ sub: 'rev-a', tid: tenantA, roles: ['reviewer'] });
    candidateA = await signTestToken({ sub: 'cand-a', tid: tenantA, roles: ['candidate'] });
    service = await signTestToken({ sub: 'svc_ats', roles: ['service'] });
  });

  beforeEach(() => {
    weights.weightsByTenant.clear();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('requisitions', () => {
    it('creates idempotently, patches with If-Match, and calibrates from the job profile', async () => {
      const key = { ...auth(recruiterA), 'Idempotency-Key': 'req-create-0001' };
      const body = {
        title: 'Platform Engineer',
        job_profile_id: profileId,
        keywords: ['kubernetes'],
      };
      const first = await http.post('/v1/job-requisitions').set(key).send(body);
      expect(first.status).toBe(201);
      const replay = await http.post('/v1/job-requisitions').set(key).send(body);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.requisition_id).toBe(first.body.requisition_id);
      const id = first.body.requisition_id as string;
      expect(first.body.calibration.status).toBe('uncalibrated');

      const notYet = await http
        .post(`/v1/job-requisitions/${id}:match`)
        .set(auth(recruiterA))
        .send({});
      expect(notYet.body.code).toBe('REQUISITION_NOT_CALIBRATED');

      const calibrated = await calibrate(recruiterA, id);
      expect(calibrated.calibration).toMatchObject({
        status: 'calibrated',
        version: 1,
        source: 'job_profile',
        job_profile_version: 1,
      });
      expect(calibrated.calibration.skills).toHaveLength(3);
      const { rows } = await db.owner.query<{
        calibration: { skills: { skill_id: string; related: { rho: number }[] }[] };
      }>('SELECT calibration FROM job_requisitions WHERE requisition_id = $1', [id]);
      const kafka = rows[0]!.calibration.skills.find((s) => s.skill_id === skill.kafka);
      expect(kafka?.related).toEqual([{ skill_id: skill.pulsar, rho: 0.8 }]); // ρ 0.9 capped
      const events = await db.owner.query<{ payload: { calibration_version: number } }>(
        `SELECT payload FROM outbox_events WHERE topic = 'matching.requisition.calibrated.v1' AND aggregate_id = $1`,
        [id],
      );
      expect(events.rows.map((e) => e.payload.calibration_version)).toEqual([1]);

      const stale = await http
        .patch(`/v1/job-requisitions/${id}`)
        .set({ ...auth(recruiterA), 'If-Match': '"2"' })
        .send({ description: 'More' });
      expect(stale.status).toBe(200);
      expect(stale.body.calibration.status).toBe('stale');
      const conflict = await http
        .patch(`/v1/job-requisitions/${id}`)
        .set({ ...auth(recruiterA), 'If-Match': '"2"' })
        .send({ openings: 2 });
      expect(conflict.status).toBe(412);
      expect(
        (await http.patch(`/v1/job-requisitions/${id}`).set(auth(recruiterA)).send({ openings: 2 }))
          .status,
      ).toBe(428);

      const manual = await createRequisition(recruiterA, { job_profile_id: null });
      const none = await http
        .post(`/v1/job-requisitions/${manual}:calibrate`)
        .set(auth(recruiterA))
        .send({});
      expect(none.body.code).toBe('NO_REQUIREMENTS');
      const byHand = await calibrate(recruiterA, manual, {
        skills: [{ skill_id: skill.python, weight: 1, target: 3, must_have: true }],
      });
      expect(byHand.calibration).toMatchObject({
        source: 'manual',
        skills: [{ name: 'Python', target: 3 }],
      });

      const list = await http.get('/v1/job-requisitions?limit=1').set(auth(reviewerA));
      expect(list.body.items).toHaveLength(1);
      const next = await http
        .get(`/v1/job-requisitions?limit=1&cursor=${list.body.next_cursor}`)
        .set(auth(reviewerA));
      expect(next.body.items[0].requisition_id).not.toBe(list.body.items[0].requisition_id);
      expect((await http.get('/v1/job-requisitions?cursor=junk').set(auth(reviewerA))).status).toBe(
        422,
      );
    });

    it('enforces roles and tenancy', async () => {
      const id = await createRequisition(recruiterA);
      expect((await http.get(`/v1/job-requisitions/${id}`).set(auth(recruiterB))).status).toBe(404);
      expect((await http.get(`/v1/job-requisitions/${id}`).set(auth(candidateA))).status).toBe(403);
      expect(
        (await http.post(`/v1/job-requisitions/${id}:match`).set(auth(reviewerA)).send({})).status,
      ).toBe(403);
      expect((await http.get('/v1/job-requisitions').set(auth(service))).body.code).toBe(
        'TENANT_ID_REQUIRED',
      );
      expect(
        (await http.get(`/v1/job-requisitions/${id}?tenant_id=${tenantA}`).set(auth(service)))
          .status,
      ).toBe(200);
      expect((await http.get('/v1/job-requisitions/not-a-uuid').set(auth(recruiterA))).status).toBe(
        404,
      );
      expect((await http.get('/v1/job-requisitions')).status).toBe(401);
    });
  });

  describe('matching', () => {
    let reqId: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      ids.strong = await seedCandidate(tenantA, strong);
      ids.related = await seedCandidate(tenantA, related);
      ids.weak = await seedCandidate(tenantA, weak);
      ids.otherTenant = await seedCandidate(tenantB, strong); // identical profile, other tenant
      await worker.drainAll(); // no requisitions yet: nothing to score
      reqId = await createRequisition(recruiterA);
      await calibrate(recruiterA, reqId);
      await worker.drainAll(); // rediscovery: the new requisition is ranked
    });

    it('ranks with the PRD formula and explains each score', async () => {
      const result = await match(recruiterA, reqId);
      const by = Object.fromEntries(result.results.map((r) => [r.candidate_id, r]));
      const [s, r, w] = [by[ids.strong!]!, by[ids.related!]!, by[ids.weak!]!];
      expect(result.results.map((x) => x.candidate_id)).toEqual([
        ids.strong,
        ids.related,
        ids.weak,
      ]);
      expect(result.weights_version).toMatch(/^w-[0-9a-f]{12}$/);

      expect(s.components).toMatchObject({ cov: 1, exp: 1, lex: 1, gate: 1 });
      expect(['strong', 'good']).toContain(s.band);
      expect(s.explanation.matched.map((m) => m.skill_id).sort()).toEqual(
        [skill.python, skill.kafka, skill.spark].sort(),
      );
      expect(s.explanation.evidence.find((e) => e.skill_id === skill.kafka)?.snippet).toContain(
        'Kafka',
      );

      // Related credit: no Kafka, but Pulsar 4 · ρ 0.8 = 3.2 of the 3.5 required.
      const kafka = r.explanation.partial.find((m) => m.skill_id === skill.kafka);
      expect(kafka?.via).toEqual({ skill_id: skill.pulsar, rho: 0.8 });
      expect(r.components.exp).toBeCloseTo(Math.exp(-0 / 8), 6); // 6 years ≥ 5

      // Must-have gate: Python 1 < 0.5 · 4, so the whole score is halved.
      expect(w.components.gate).toBe(0.5);
      expect(w.explanation.must_have_failed).toEqual([skill.python]);
      expect(w.components.exp).toBeCloseTo(Math.exp(-9 / 8), 4);
      expect(w.band).toBe('weak');
      const linear =
        0.4 * w.components.sem +
        0.35 * w.components.cov +
        0.15 * w.components.exp +
        0.1 * w.components.lex;
      expect(w.score).toBeCloseTo(0.5 * linear, 3);
    });

    it('caches per (requisition, calibration, weights_version) and filters', async () => {
      const first = await match(recruiterA, reqId);
      const second = await match(recruiterA, reqId);
      expect(second.cached).toBe(true);
      expect(second.results).toEqual(first.results);
      const strongOnly = await match(recruiterA, reqId, {
        filters: { min_score: first.results[0]!.score },
      });
      expect(strongOnly.results.map((r) => r.candidate_id)).toEqual([ids.strong]);
      const weakBand = await match(recruiterA, reqId, { filters: { bands: ['weak'] } });
      expect(weakBand.results.every((r) => r.band === 'weak')).toBe(true);
      const excluded = await match(recruiterA, reqId, {
        limit: 1,
        filters: { exclude_candidate_ids: [ids.strong] },
      });
      expect(excluded.results.map((r) => r.candidate_id)).toEqual([ids.related]);
      expect(excluded.total).toBe(2);
    });

    it('never surfaces another tenant’s candidates (leak test)', async () => {
      const result = await match(recruiterA, reqId, { limit: 200 });
      expect(result.results.map((r) => r.candidate_id)).not.toContain(ids.otherTenant);
      expect(vectors.calls.every((c) => c.tenantId === tenantA || c.tenantId === tenantB)).toBe(
        true,
      );
      expect(
        vectors.calls.filter((c) => c.kind === 'ann').every((c) => c.tenantId === tenantA),
      ).toBe(true);
      const theirs = await http
        .get(`/v1/candidates/${ids.otherTenant}/matches`)
        .set(auth(recruiterA));
      expect(theirs.body.items).toEqual([]);
      const cross = await http
        .post(`/v1/job-requisitions/${reqId}:match`)
        .set(auth(recruiterB))
        .send({});
      expect(cross.status).toBe(404);
      const { rows } = await db.owner.query('SELECT 1 FROM match_scores WHERE tenant_id = $1', [
        tenantB,
      ]);
      expect(rows).toEqual([]);
    });

    it('re-scores a new candidate incrementally and announces it', async () => {
      const late = await seedCandidate(tenantA, {
        ...strong,
        summary: 'Streaming engineer: Kafka, Spark, Python pipelines.',
      });
      await worker.drainAll();
      const mine = await http.get(`/v1/candidates/${late}/matches`).set(auth(recruiterA));
      expect(mine.body.items.map((i: { requisition_id: string }) => i.requisition_id)).toContain(
        reqId,
      );
      const { rows } = await db.owner.query<{
        payload: { scores: { requisition_id: string; band: string }[] };
      }>(
        `SELECT payload FROM outbox_events WHERE topic = 'matching.candidate.rescored.v1' AND aggregate_id = $1`,
        [late],
      );
      expect(rows[0]!.payload.scores.map((s) => s.requisition_id)).toContain(reqId);
      const ranked = await match(recruiterA, reqId);
      expect(ranked.cached).toBe(false); // the rescoring invalidated the cache
      expect(ranked.results.map((r) => r.candidate_id)).toContain(late);
    });

    it('re-calibrates when the linked job profile changes', async () => {
      taxonomy.profiles.set(profileId, {
        version: 2,
        title: 'Senior Data Engineer',
        skills: [{ skill_id: skill.python, weight: 1, target_proficiency: 3, must_have: true }],
      });
      await emit(JobProfileUpdated.topic, tenantA, profileId, {
        tenant_id: tenantA,
        job_profile_id: profileId,
        version: 2,
        status: 'published',
        title: 'Senior Data Engineer',
        skills: [{ skill_id: skill.python, weight: 1, target_proficiency: 3, must_have: true }],
        occurred_at: NOW.toISOString(),
      });
      await worker.drainAll();
      const view = await http.get(`/v1/job-requisitions/${reqId}`).set(auth(recruiterA));
      expect(view.body.calibration).toMatchObject({ version: 2, job_profile_version: 2 });
      const result = await match(recruiterA, reqId);
      const weakNow = result.results.find((r) => r.candidate_id === ids.weak)!;
      expect(weakNow.components.gate).toBe(0.5); // 1 < 0.5 · 3 still fails the must-have
    });

    it('uses the tenant’s weights, versioned, and rejects weights that do not sum to 1', async () => {
      const before = await match(recruiterA, reqId);
      weights.weightsByTenant.set(tenantA, { sem: 0, cov: 1, exp: 0, lex: 0 });
      await emit(TenantSettingsUpdated.topic, tenantA, tenantA, {
        tenant_id: tenantA,
        version: 7,
        changed_keys: ['matching'],
        actor: 'adm',
        occurred_at: NOW.toISOString(),
      });
      expect(weights.evicted).toContain(tenantA);
      await worker.drainAll();
      const after = await match(recruiterA, reqId);
      expect(after.weights_version).not.toBe(before.weights_version);
      expect(
        after.results.every((r) => Math.abs(r.score - r.components.gate * r.components.cov) < 1e-3),
      ).toBe(true);
      const { rows } = await db.owner.query<{ weights_version: string }>(
        'SELECT DISTINCT weights_version FROM match_scores WHERE requisition_id = $1',
        [reqId],
      );
      expect(rows.map((r) => r.weights_version)).toEqual([after.weights_version]);

      weights.weightsByTenant.set(tenantA, { sem: 0.5, cov: 0.5, exp: 0.5, lex: 0 });
      const bad = await http
        .post(`/v1/job-requisitions/${reqId}:match`)
        .set(auth(recruiterA))
        .send({});
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('INVALID_WEIGHTS');
    });

    it('is fair under counterfactual name and pronoun swaps (mean |Δ| < 0.02)', async () => {
      const pairs: [string, string][] = [
        ['Emily Carter', 'Jamal Okafor'],
        ['Sofia Rossi', 'Wei Zhang'],
        ['Hannah Schmidt', 'Arjun Mehta'],
        ['Olivia Brown', 'Mohammed Haddad'],
        ['Chloe Martin', 'Kwame Mensah'],
      ];
      const pronouns = [
        ['she', 'her', 'he', 'his'],
        ['he', 'his', 'she', 'her'],
      ] as const;
      const deltas: number[] = [];
      for (const [n, [a, b]] of pairs.entries()) {
        const [p1, q1, p2, q2] = pronouns[n % 2]!;
        const variant = (name: string, p: string, q: string): Seed => ({
          ...strong,
          summary: `${name} is a data engineer; ${p} builds streaming pipelines with Kafka, Spark and Python for ${q} team.`,
          roles: [
            {
              ...strong.roles[0]!,
              responsibilities: [
                `${name} built Kafka and Spark pipelines in Python with ${q} team`,
              ],
            },
          ],
        });
        const one = await seedCandidate(tenantA, variant(a, p1, q1));
        const two = await seedCandidate(tenantA, variant(b, p2, q2));
        await worker.drainAll();
        const ranked = await match(recruiterA, reqId, { limit: 200 });
        const score = (id: string) => ranked.results.find((r) => r.candidate_id === id)!.score;
        deltas.push(Math.abs(score(one) - score(two)));
      }
      const mean = deltas.reduce((x, y) => x + y, 0) / deltas.length;
      expect(mean).toBeLessThan(0.02);
    });
  });

  describe('re-scoring worker', () => {
    it('keeps work through a dependency outage and retries it, then gives up after 5 attempts', async () => {
      const id = await seedCandidate(tenantA, strong);
      vectors.down = true;
      try {
        expect(await worker.drain()).toBe(0);
        const { rows } = await db.owner.query<{ attempts: number }>(
          'SELECT attempts FROM match_work WHERE subject_id = $1',
          [id],
        );
        expect(rows).toEqual([{ attempts: 1 }]); // put back, not lost
        for (let i = 0; i < 4; i++) await worker.drain();
        const gone = await db.owner.query('SELECT 1 FROM match_work WHERE subject_id = $1', [id]);
        expect(gone.rows).toEqual([]); // dropped after MAX_ATTEMPTS, and logged
        expect(logs.lines.some((l) => l['msg'] === 'rescoring dropped')).toBe(true);
      } finally {
        vectors.down = false;
      }
      const again = await seedCandidate(tenantA, strong, id); // the next event re-queues it
      expect(again).toBe(id);
      expect(await worker.drainAll()).toBeGreaterThan(0);
      const scored = await db.owner.query('SELECT 1 FROM match_scores WHERE candidate_id = $1', [
        id,
      ]);
      expect(scored.rows.length).toBeGreaterThan(0);
    });
  });

  describe('data protection', () => {
    it('erases a candidate’s scores and features and acknowledges', async () => {
      const id = await seedCandidate(tenantA, strong);
      const reqId = await createRequisition(recruiterA);
      await calibrate(recruiterA, reqId);
      await worker.drainAll();
      const requestId = newId();
      await emit(ErasureRequested.topic, tenantA, requestId, {
        tenant_id: tenantA,
        request_id: requestId,
        candidate_id: id,
        reason: 'data_subject',
        ack_required_from: ['matching-svc', 'parsing-svc'],
        due_at: NOW.toISOString(),
        occurred_at: NOW.toISOString(),
      });
      for (const table of ['match_scores', 'candidate_features', 'match_work']) {
        const { rows } = await db.owner.query(
          `SELECT 1 FROM ${table} WHERE ${table === 'match_work' ? 'subject_id' : 'candidate_id'} = $1`,
          [id],
        );
        expect(rows, table).toEqual([]);
      }
      const acks = await db.owner.query<{ payload: { service: string } }>(
        `SELECT payload FROM outbox_events WHERE topic = 'privacy.erasure.acknowledged.v1' AND aggregate_id = $1`,
        [requestId],
      );
      expect(acks.rows.map((r) => r.payload.service)).toEqual(['matching-svc']);
    });

    it('purges a tenant', async () => {
      await emit(TenantPurged.topic, tenantB, tenantB, {
        tenant_id: tenantB,
        from_status: 'offboarding',
        to_status: 'purged',
        reason: null,
        actor: 'staff',
        occurred_at: NOW.toISOString(),
      });
      for (const table of ['job_requisitions', 'candidate_features', 'match_scores']) {
        const { rows } = await db.owner.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [
          tenantB,
        ]);
        expect(rows, table).toEqual([]);
      }
    });
  });

  it('reports health and keeps PII out of logs', async () => {
    expect((await http.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await http.get('/readyz')).body).toEqual({ status: 'ready' });
    expect(JSON.stringify(logs.lines)).not.toContain('Emily Carter');
  });
});

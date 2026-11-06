/**
 * Acceptance tests 1–6 from docs/prompts/04-profile-svc.md §8, against the real HTTP stack, real
 * field encryption (TenantKeyCache unwrapping DEKs exactly as tenant-svc wraps them) and Postgres
 * (PGlite) running as the RLS-bound atlas_app role.
 */
import { createHash, randomBytes } from 'node:crypto';
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssessmentSessionEvaluated,
  ErasureAcknowledged,
  FileQuarantined,
  ResumeParsed,
  ResumeParseFailed,
  TenantPurged,
} from '@atlas/contracts';
import {
  type Consumer,
  configureHttpApp,
  createConsumer,
  createLogger,
  FixedClock,
  JwtVerifier,
  LocalKeyEncryption,
  newId,
  TENANT_DEK_CONTEXT,
  TenantKeyCache,
  type WrappedTenantKey,
} from '@atlas/platform';
import {
  createTestDatabase,
  MemoryLogStream,
  signTestToken,
  TEST_AUTH,
  type TestDatabase,
} from '@atlas/platform/testing';
import { AppModule } from '../../src/app.module';
import { PROFILE_CONSUMER, ProfileEventHandlers } from '../../src/application/event-handlers';
import { DEFAULT_POLICY } from '../../src/domain/fusion';
import { StaticSkillCatalog } from '../../src/infrastructure/skill-catalog';
import { MemoryObjectStorage } from '../../src/infrastructure/storage';

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-05T10:00:00.000Z');

describe('profile-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  let consumer: Consumer;
  const clock = new FixedClock(NOW);
  const kek = new LocalKeyEncryption('dev', randomBytes(32));
  const storage = new MemoryObjectStorage();
  const logs = new MemoryLogStream();
  const tenantA = newId();
  const tenantB = newId();
  const skill = { python: newId(), sql: newId(), legacy: newId(), unknown: newId() };

  // What tenant-svc would serve: wrapped DEK versions per tenant.
  const wrapped = new Map<string, WrappedTenantKey[]>();
  async function addKey(tenantId: string): Promise<void> {
    const list = wrapped.get(tenantId) ?? [];
    for (const k of list) k.active = false;
    list.unshift({
      version: list.length + 1,
      kmsKeyRef: kek.keyRef,
      wrappedKey: await kek.encrypt(randomBytes(32), TENANT_DEK_CONTEXT),
      active: true,
    });
    wrapped.set(tenantId, list);
  }
  const keyCache = new TenantKeyCache(
    { fetch: (t) => Promise.resolve(wrapped.get(t) ?? []) },
    kek,
    { clock },
  );

  let recruiterA: string;
  let reviewerA: string;
  let managerA: string;
  let adminA: string;
  let adminB: string;
  let service: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const createCandidate = (token: string, body: Record<string, unknown>, key = `idem-${newId()}`) =>
    http.post('/v1/candidates').set(auth(token)).set('Idempotency-Key', key).send(body);

  async function newCandidate(
    token: string,
    pii: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const res = await createCandidate(token, { source: 'external_applicant', pii, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.candidate_id as string;
  }

  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  /** A PDF document that finished uploading (S3 notification applied). */
  async function uploadedDocument(candidateId: string): Promise<string> {
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(300)]);
    const init = await http
      .post('/v1/documents:initiateUpload')
      .set(auth(recruiterA))
      .send({
        candidate_id: candidateId,
        mime_type: 'application/pdf',
        byte_size: bytes.length,
        sha256: sha(bytes),
      });
    const docId = init.body.document_id as string;
    storage.put(`t/${tenantA}/resumes/${docId}`, bytes);
    const event = { Records: [{ s3: { object: { key: `t/${tenantA}/resumes/${docId}` } } }] };
    await http.post('/v1/internal/storage-events').set(auth(service)).send(event);
    return docId;
  }

  const emit = (
    topic: string,
    tenantId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) => consumer.handle({ eventId: newId(), topic, tenantId, aggregateId, payload });

  beforeAll(async () => {
    await addKey(tenantA);
    await addKey(tenantB);
    db = await createTestDatabase();
    const logger = createLogger({ service: 'profile-svc', level: 'info', destination: logs });
    app = await NestFactory.create(
      AppModule.register({
        db,
        clock,
        verifier: new JwtVerifier({ ...TEST_AUTH }),
        keys: keyCache,
        storage,
        skills: new StaticSkillCatalog(
          new Set([skill.python, skill.sql]),
          new Map([[skill.legacy, skill.sql]]),
        ),
        settings: {
          erasureConsumers: ['matching-svc', 'parsing-svc'],
          retentionInactiveDays: 730,
          fusionPolicy: DEFAULT_POLICY,
        },
        logger,
      }),
      { logger: false },
    );
    configureHttpApp(app, logger);
    await app.init();
    http = request(app.getHttpServer());
    consumer = createConsumer({
      name: PROFILE_CONSUMER,
      db,
      handlers: app.get(ProfileEventHandlers).handlers(),
    });
    recruiterA = await signTestToken({ sub: 'rec-a', tid: tenantA, roles: ['recruiter'] });
    reviewerA = await signTestToken({ sub: 'rev-a', tid: tenantA, roles: ['reviewer'] });
    managerA = await signTestToken({ sub: 'mgr-a', tid: tenantA, roles: ['hiring_manager'] });
    adminA = await signTestToken({ sub: 'adm-a', tid: tenantA, roles: ['tenant_admin'] });
    adminB = await signTestToken({ sub: 'adm-b', tid: tenantB, roles: ['tenant_admin'] });
    service = await signTestToken({
      sub: 'svc_storage',
      roles: ['service'],
      scopes: ['storage-events:write'],
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('AT1: encrypted PII, blind index, redaction', () => {
    it('stores ciphertext, finds by email and redacts for roles without pii:read', async () => {
      const key = `idem-${newId()}`;
      const body = {
        source: 'external_applicant',
        pii: {
          full_name: 'Ada  Lovelace',
          email: 'Ada@Example.COM',
          phone: '+44 20 7946 0958',
          dob: '1815-12-10',
        },
        current_title: 'Analyst',
        location_country: 'gb',
      };
      const created = await createCandidate(recruiterA, body, key);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        pii: null,
        pii_redacted: true,
        location_country: 'GB',
        version: 1,
      });
      const id = created.body.candidate_id as string;

      const replay = await createCandidate(recruiterA, body, key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.candidate_id).toBe(id);

      const { rows } = await db.owner.query<{
        pii_enc: Uint8Array;
        email_bidx: Uint8Array;
        profile: unknown;
      }>('SELECT pii_enc, email_bidx, profile FROM candidates WHERE candidate_id = $1', [id]);
      const raw = Buffer.from(rows[0]!.pii_enc).toString('latin1');
      for (const secret of ['Ada', 'Lovelace', 'example.com', '7946', '1815'])
        expect(raw).not.toContain(secret);
      expect(Buffer.from(rows[0]!.email_bidx)).toHaveLength(32);
      const { rows: idem } = await db.owner.query<{ response_body: unknown }>(
        'SELECT response_body FROM idempotency_keys',
      );
      expect(JSON.stringify(idem)).not.toContain('Lovelace');

      const full = await http.get(`/v1/candidates/${id}`).set(auth(recruiterA));
      expect(full.body.pii).toEqual({
        full_name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+442079460958',
        address: null,
        dob: '1815-12-10',
      });
      expect(full.headers['cache-control']).toBe('no-store');
      const blind = await http.get(`/v1/candidates/${id}`).set(auth(reviewerA));
      expect(blind.body).toMatchObject({ pii: null, pii_redacted: true, current_title: 'Analyst' });

      const found = await http
        .get('/v1/candidates')
        .query({ email: '  ADA@example.com ' })
        .set(auth(recruiterA));
      expect(found.body.items.map((c: { candidate_id: string }) => c.candidate_id)).toEqual([id]);
      expect(
        (await http.get('/v1/candidates').query({ email: 'ada@example.com' }).set(auth(reviewerA)))
          .status,
      ).toBe(403);

      const dupe = await createCandidate(recruiterA, {
        source: 'referral',
        pii: { full_name: 'Someone', email: 'ada@example.com' },
      });
      expect(dupe.status).toBe(409);
      expect(dupe.body).toMatchObject({ code: 'CANDIDATE_EMAIL_TAKEN', candidate_id: id });
    });

    it('patches PII with If-Match and keeps the lookup working; reviewers cannot', async () => {
      const id = await newCandidate(recruiterA, {
        full_name: 'Grace Hopper',
        email: 'grace@navy.test',
      });
      expect(
        (await http.patch(`/v1/candidates/${id}`).set(auth(recruiterA)).send({ department: 'x' }))
          .status,
      ).toBe(428);
      const ok = await http
        .patch(`/v1/candidates/${id}`)
        .set(auth(recruiterA))
        .set('If-Match', '"1"')
        .send({ pii: { phone: '+1 555 0100 222' }, department: 'Navy' });
      expect(ok.status).toBe(200);
      expect(ok.body.pii).toMatchObject({
        full_name: 'Grace Hopper',
        email: 'grace@navy.test',
        phone: '+15550100222',
      });
      const denied = await http
        .patch(`/v1/candidates/${id}`)
        .set(auth(reviewerA))
        .set('If-Match', '"2"')
        .send({ pii: { full_name: 'X' } });
      expect(denied.status).toBe(403);
      const found = await http
        .get('/v1/candidates')
        .query({ email: 'grace@navy.test' })
        .set(auth(recruiterA));
      expect(found.body.items).toHaveLength(1);
      const noProfilePii = await createCandidate(recruiterA, {
        source: 'sourced',
        pii: { full_name: 'X' },
        consent: { email: 'leak@x.test' },
      });
      expect(noProfilePii.body.code).toBe('PII_IN_PROFILE');
    });
  });

  describe('AT4: tenant isolation', () => {
    it('another tenant gets 404, and equal emails never collide across tenants', async () => {
      const a = await newCandidate(recruiterA, {
        full_name: 'Shared Person',
        email: 'shared@corp.test',
      });
      expect((await http.get(`/v1/candidates/${a}`).set(auth(adminB))).status).toBe(404);
      expect(
        (await http.get(`/v1/candidates/${a}`).query({ tenant_id: tenantA }).set(auth(adminB)))
          .status,
      ).toBe(404);
      const b = await newCandidate(adminB, {
        full_name: 'Shared Person',
        email: 'shared@corp.test',
      });
      const { rows } = await db.owner.query<{ email_bidx: Uint8Array }>(
        'SELECT email_bidx FROM candidates WHERE candidate_id = ANY($1::uuid[])',
        [[a, b]],
      );
      expect(Buffer.from(rows[0]!.email_bidx).equals(Buffer.from(rows[1]!.email_bidx))).toBe(false);
      const lookupB = await http
        .get('/v1/candidates')
        .query({ email: 'shared@corp.test' })
        .set(auth(adminB));
      expect(lookupB.body.items.map((c: { candidate_id: string }) => c.candidate_id)).toEqual([b]);
      // A ciphertext copied into another tenant's row does not decrypt (AAD binds tenant and record).
      await db.owner.query(
        `UPDATE candidates SET pii_enc = (SELECT pii_enc FROM candidates WHERE candidate_id = $1) WHERE candidate_id = $2`,
        [a, b],
      );
      expect((await http.get(`/v1/candidates/${b}`).set(auth(adminB))).status).toBe(500);
    });
  });

  describe('AT2: document intake', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(2000)]);

    it('presigns, de-duplicates by sha256, verifies the object and hands it to parsing', async () => {
      const candidateId = await newCandidate(recruiterA, { full_name: 'Doc Owner' });
      const init = (bytes: Buffer, mime = 'application/pdf') =>
        http
          .post('/v1/documents:initiateUpload')
          .set(auth(recruiterA))
          .send({
            candidate_id: candidateId,
            mime_type: mime,
            byte_size: bytes.length,
            sha256: sha(bytes),
          });
      const first = await init(pdf);
      expect(first.status).toBe(201);
      expect(first.body.upload_headers['x-amz-checksum-sha256']).toBe(
        createHash('sha256').update(pdf).digest('base64'),
      );
      const docId = first.body.document_id as string;

      const dupe = await init(pdf);
      expect(dupe.status).toBe(409);
      expect(dupe.body).toMatchObject({ code: 'DOCUMENT_DUPLICATE', document_id: docId });

      storage.put(`t/${tenantA}/resumes/${docId}`, pdf);
      const event = { Records: [{ s3: { object: { key: `t/${tenantA}/resumes/${docId}` } } }] };
      const res = await http.post('/v1/internal/storage-events').set(auth(service)).send(event);
      expect(res.body.results[0].status).toBe('uploaded');
      expect(
        (await http.post('/v1/internal/storage-events').set(auth(service)).send(event)).body
          .results[0].status,
      ).toBe('uploaded');
      const { rows } = await db.owner.query<{ payload: { sha256: string } }>(
        `SELECT payload FROM outbox_events WHERE topic = 'profile.resume.uploaded.v1' AND aggregate_id = $1`,
        [docId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.sha256).toBe(sha(pdf));

      // Declared PDF, actually a ZIP of something else → quarantined.
      const fake = Buffer.concat([Buffer.from('PK\u0003\u0004'), randomBytes(500)]);
      const second = await init(fake);
      storage.put(`t/${tenantA}/resumes/${second.body.document_id}`, fake);
      const q = await http
        .post('/v1/internal/storage-events')
        .set(auth(service))
        .send({ keys: [`t/${tenantA}/resumes/${second.body.document_id}`] });
      expect(q.body.results[0].status).toBe('quarantined');
      const doc = await http.get(`/v1/documents/${second.body.document_id}`).set(auth(recruiterA));
      expect(doc.body).toMatchObject({ parse_status: 'quarantined', error_code: 'mime_mismatch' });

      expect((await init(randomBytes(10), 'application/x-msdownload')).body.code).toBe(
        'UNSUPPORTED_MIME_TYPE',
      );
      const big = await http
        .post('/v1/documents:initiateUpload')
        .set(auth(recruiterA))
        .send({
          candidate_id: candidateId,
          mime_type: 'application/pdf',
          byte_size: 10 * 1024 * 1024 + 1,
          sha256: sha(Buffer.from('x')),
        });
      expect(big.body.code).toBe('DOCUMENT_TOO_LARGE');
      expect(
        (
          await http
            .post('/v1/internal/storage-events')
            .set(auth(recruiterA))
            .send({ keys: ['x'] })
        ).status,
      ).toBe(403);
    });

    it('applies a parsed résumé, and refuses a profile that still contains PII', async () => {
      const candidateId = await newCandidate(recruiterA, { full_name: 'Parsed Person' });
      const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(300)]);
      const init = await http
        .post('/v1/documents:initiateUpload')
        .set(auth(recruiterA))
        .send({
          candidate_id: candidateId,
          mime_type: 'application/pdf',
          byte_size: bytes.length,
          sha256: sha(bytes),
        });
      const docId = init.body.document_id as string;
      const parsed = (profile: Record<string, unknown>) => ({
        tenant_id: tenantA,
        candidate_id: candidateId,
        document_id: docId,
        parser_version: 'v3.1',
        language: 'en',
        page_count: 2,
        flags: [],
        profile,
        current_title: 'Data Engineer',
        total_experience_months: 60,
        skills: [{ skill_id: skill.python, proficiency: 3.5, confidence: 0.8 }],
        occurred_at: NOW.toISOString(),
      });
      await emit(
        ResumeParsed.topic,
        tenantA,
        docId,
        parsed({ experience: [{ title: 'Engineer', years: 5 }], email: 'x@y.z' }),
      );
      const failed = await http.get(`/v1/documents/${docId}`).set(auth(recruiterA));
      expect(failed.body).toMatchObject({ parse_status: 'failed', error_code: 'pii_in_profile' });

      await emit(
        ResumeParsed.topic,
        tenantA,
        docId,
        parsed({ experience: [{ title: 'Engineer', years: 5 }] }),
      );
      const candidate = await http.get(`/v1/candidates/${candidateId}`).set(auth(recruiterA));
      expect(candidate.body).toMatchObject({
        current_title: 'Data Engineer',
        total_experience_months: 60,
        profile_version: 1,
      });
      const skills = await http.get(`/v1/candidates/${candidateId}/skills`).set(auth(recruiterA));
      expect(skills.body.skills).toEqual([
        expect.objectContaining({ skill_id: skill.python, proficiency: 3.5, is_validated: false }),
      ]);
    });
  });

  describe('assessment evidence validity', () => {
    it('stores the skill validity window sent with an evaluated session', async () => {
      const candidateId = await newCandidate(adminA, { full_name: 'Validity Person' });
      const session = newId();
      const validUntil = new Date(NOW.getTime() + 24 * MONTH_MS).toISOString();
      await emit(AssessmentSessionEvaluated.topic, tenantA, session, {
        tenant_id: tenantA,
        candidate_id: candidateId,
        session_id: session,
        skills: [{ skill_id: skill.sql, score: 3.5, confidence: 0.8 }],
        valid_until: validUntil,
        evaluated_at: NOW.toISOString(),
      });
      const { rows } = await db.owner.query<{ valid_until: Date }>(
        `SELECT valid_until FROM candidate_skill_evidence WHERE source_ref = $1`,
        [session],
      );
      expect(rows.map((r) => new Date(r.valid_until).toISOString())).toEqual([validUntil]);
    });
  });

  describe('parsing-svc outcomes', () => {
    it('marks failed and quarantined documents, but never un-parses a parsed one', async () => {
      const candidateId = await newCandidate(adminA, { full_name: 'Outcome Person' });
      const failedDoc = await uploadedDocument(candidateId);
      const failure = (docId: string, retryable: boolean) => ({
        tenant_id: tenantA,
        candidate_id: candidateId,
        document_id: docId,
        job_id: newId(),
        error_code: retryable ? 'LLM_UNAVAILABLE' : 'ENCRYPTED_DOCUMENT',
        retryable,
        attempts: 3,
        occurred_at: NOW.toISOString(),
      });
      await emit(ResumeParseFailed.topic, tenantA, failedDoc, failure(failedDoc, true));
      const retryable = await http.get(`/v1/documents/${failedDoc}`).set(auth(recruiterA));
      expect(retryable.body).toMatchObject({
        parse_status: 'failed_retryable',
        error_code: 'LLM_UNAVAILABLE',
      });

      const badDoc = await uploadedDocument(candidateId);
      await emit(FileQuarantined.topic, tenantA, badDoc, {
        tenant_id: tenantA,
        candidate_id: candidateId,
        document_id: badDoc,
        quarantine_key: `quarantine/t/${tenantA}/${badDoc}`,
        reason: 'malware',
        signature: 'Eicar-Test-Signature',
        detected_by: 'clamav',
        occurred_at: NOW.toISOString(),
      });
      const quarantined = await http.get(`/v1/documents/${badDoc}`).set(auth(recruiterA));
      expect(quarantined.body).toMatchObject({
        parse_status: 'quarantined',
        error_code: 'MALICIOUS_FILE',
      });
      await emit(ResumeParseFailed.topic, tenantA, badDoc, failure(badDoc, false));
      const still = await http.get(`/v1/documents/${badDoc}`).set(auth(recruiterA));
      expect(still.body.parse_status).toBe('quarantined');
    });
  });

  describe('AT3: proficiency fusion', () => {
    it('fuses assessment, manager and self evidence to the golden value', async () => {
      const userId = newId();
      const candidateId = await newCandidate(
        adminA,
        { full_name: 'Fusion Person' },
        { source: 'employee', user_id: userId },
      );
      const self = await signTestToken({ sub: userId, tid: tenantA, roles: ['employee'] });

      await emit(AssessmentSessionEvaluated.topic, tenantA, newId(), {
        tenant_id: tenantA,
        candidate_id: candidateId,
        session_id: newId(),
        skills: [{ skill_id: skill.python, score: 4.0, confidence: 0.9 }],
        evaluated_at: new Date(NOW.getTime() - 12 * MONTH_MS).toISOString(),
      });
      const manager = await http
        .post(`/v1/candidates/${candidateId}/skill-evidence`)
        .set(auth(managerA))
        .send({
          evidence: [
            {
              skill_id: skill.python,
              source: 'manager',
              proficiency: 3.0,
              confidence: 0.8,
              observed_at: new Date(NOW.getTime() - 6 * MONTH_MS).toISOString(),
            },
          ],
        });
      expect(manager.status).toBe(201);
      const noReason = await http
        .post(`/v1/candidates/${candidateId}/skill-evidence`)
        .set(auth(self))
        .send({ evidence: [{ skill_id: skill.python, source: 'self', proficiency: 5 }] });
      expect(noReason.body.code).toBe('REASON_REQUIRED');
      const selfRated = await http
        .post(`/v1/candidates/${candidateId}/skill-evidence`)
        .set(auth(self))
        .send({
          evidence: [
            { skill_id: skill.python, source: 'self', proficiency: 5, reason: 'Led the migration' },
          ],
        });
      expect(selfRated.status).toBe(201);

      // (1.0·0.9·0.5^(12/24)·4 + 0.7·0.8·0.5^(6/12)·3 + 0.3·1·1·5) / (1.0·0.9·0.7071 + 0.7·0.8·0.7071 + 0.3) = 3.93
      expect(selfRated.body.skills).toEqual([
        expect.objectContaining({
          skill_id: skill.python,
          proficiency: 3.93,
          is_validated: true,
          calibration_needed: false,
          evidence_count: 3,
        }),
      ]);
      const view = await http
        .get(`/v1/candidates/${candidateId}/skills`)
        .query({ include: 'evidence' })
        .set(auth(self));
      expect(view.body.evidence.map((e: { source: string }) => e.source).sort()).toEqual([
        'assessment',
        'manager',
        'self',
      ]);
      const { rows } = await db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'profile.candidate.skills_updated.v1' AND aggregate_id = $1`,
        [candidateId],
      );
      expect(rows[0]!.n).toBe(3);
    });

    it('flags calibration, enforces sources, resolves deprecated skills and skips redeliveries', async () => {
      const userId = newId();
      const candidateId = await newCandidate(
        adminA,
        { full_name: 'Calib Person' },
        { source: 'employee', user_id: userId },
      );
      const self = await signTestToken({ sub: userId, tid: tenantA, roles: ['employee'] });
      const session = newId();
      const assessment = {
        tenant_id: tenantA,
        candidate_id: candidateId,
        session_id: session,
        skills: [{ skill_id: skill.sql, score: 1.5, confidence: 1 }],
        evaluated_at: NOW.toISOString(),
      };
      expect(await emit(AssessmentSessionEvaluated.topic, tenantA, session, assessment)).toBe(
        'processed',
      );
      await emit(AssessmentSessionEvaluated.topic, tenantA, session, assessment); // new event id, same session
      const calib = await http
        .post(`/v1/candidates/${candidateId}/skill-evidence`)
        .set(auth(self))
        .send({
          evidence: [
            { skill_id: skill.legacy, source: 'self', proficiency: 4, reason: 'I use it daily' },
          ],
        });
      expect(calib.body.skills).toEqual([
        expect.objectContaining({
          skill_id: skill.sql,
          calibration_needed: true,
          evidence_count: 2,
        }),
      ]);
      const forged = await http
        .post(`/v1/candidates/${candidateId}/skill-evidence`)
        .set(auth(managerA))
        .send({ evidence: [{ skill_id: skill.sql, source: 'assessment', proficiency: 5 }] });
      expect(forged.status).toBe(403);
      expect(forged.body.code).toBe('SOURCE_NOT_ALLOWED');
      expect(
        (
          await http
            .post(`/v1/candidates/${candidateId}/skill-evidence`)
            .set(auth(reviewerA))
            .send({
              evidence: [{ skill_id: skill.sql, source: 'manager', proficiency: 5 }],
            })
        ).status,
      ).toBe(403);
      const unknown = await http
        .post(`/v1/candidates/${candidateId}/skill-evidence`)
        .set(auth(managerA))
        .send({ evidence: [{ skill_id: skill.unknown, source: 'manager', proficiency: 3 }] });
      expect(unknown.body.code).toBe('SKILL_NOT_FOUND');
      // Employees see only themselves.
      const other = await newCandidate(adminA, { full_name: 'Someone Else' });
      expect((await http.get(`/v1/candidates/${other}`).set(auth(self))).status).toBe(404);
      expect(
        (await http.get(`/v1/candidates/${candidateId}`).set(auth(self))).body.pii.full_name,
      ).toBe('Calib Person');
    });
  });

  describe('AT5: data-subject requests', () => {
    it('erases rows and objects, fans out, and completes with a certificate after every ACK', async () => {
      const candidateId = await newCandidate(recruiterA, {
        full_name: 'Erase Me',
        email: 'erase@me.test',
      });
      const bytes = Buffer.concat([Buffer.from('%PDF-1.5\n'), randomBytes(100)]);
      const init = await http
        .post('/v1/documents:initiateUpload')
        .set(auth(recruiterA))
        .send({
          candidate_id: candidateId,
          mime_type: 'application/pdf',
          byte_size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      const key = `t/${tenantA}/resumes/${init.body.document_id}`;
      storage.put(key, bytes);
      await http
        .post(`/v1/candidates/${candidateId}/skill-evidence`)
        .set(auth(managerA))
        .send({
          evidence: [{ skill_id: skill.python, source: 'manager', proficiency: 3 }],
        });

      expect(
        (
          await http
            .post('/v1/privacy/requests')
            .set(auth(recruiterA))
            .send({ type: 'erasure', candidate_id: candidateId })
        ).status,
      ).toBe(403);
      const res = await http
        .post('/v1/privacy/requests')
        .set(auth(adminA))
        .send({ type: 'erasure', candidate_id: candidateId });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'awaiting_acks',
        ack_required_from: ['matching-svc', 'parsing-svc'],
      });
      expect(res.body.certificate).toMatchObject({
        objects_deleted: 1,
        rows_deleted: {
          candidates: 1,
          candidate_skill_evidence: 1,
          candidate_skill_current: 1,
          resume_documents: 1,
        },
        completed_at: null,
      });
      expect(storage.objects.has(key)).toBe(false);
      for (const table of [
        'candidates',
        'candidate_skill_evidence',
        'candidate_skill_current',
        'resume_documents',
      ]) {
        const { rows } = await db.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE candidate_id = $1`,
          [candidateId],
        );
        expect(rows[0]!.n, table).toBe(0);
      }
      expect(
        (await http.get('/v1/candidates').query({ email: 'erase@me.test' }).set(auth(recruiterA)))
          .body.items,
      ).toEqual([]);

      const requestId = res.body.request_id as string;
      const ack = (svc: string) =>
        emit(ErasureAcknowledged.topic, tenantA, requestId, {
          tenant_id: tenantA,
          request_id: requestId,
          service: svc,
          occurred_at: NOW.toISOString(),
        });
      await ack('matching-svc');
      await ack('matching-svc'); // repeat is harmless
      await ack('unknown-svc'); // not registered: ignored
      expect(
        (await http.get(`/v1/privacy/requests/${requestId}`).set(auth(adminA))).body.status,
      ).toBe('awaiting_acks');
      await ack('parsing-svc');
      const done = await http.get(`/v1/privacy/requests/${requestId}`).set(auth(adminA));
      expect(done.body.status).toBe('completed');
      expect(done.body.certificate.acks.map((a: { service: string }) => a.service)).toEqual([
        'matching-svc',
        'parsing-svc',
      ]);
      expect(done.body.certificate.completed_at).not.toBeNull();
      const { rows: events } = await db.owner.query<{
        topic: string;
        payload: Record<string, unknown>;
      }>(`SELECT topic, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at`, [
        requestId,
      ]);
      expect(events.map((e) => e.topic).sort()).toEqual([
        'privacy.erasure.completed.v1',
        'privacy.erasure.requested.v1',
      ]);
      expect(JSON.stringify(events)).not.toContain('Erase Me');
    });

    it('exports everything for access requests (encrypted at rest) and respects legal holds', async () => {
      const candidateId = await newCandidate(recruiterA, {
        full_name: 'Access Person',
        email: 'access@me.test',
      });
      const res = await http
        .post('/v1/privacy/requests')
        .set(auth(adminA))
        .send({ type: 'access', candidate_id: candidateId });
      expect(res.body).toMatchObject({
        status: 'completed',
        export: { personal_data: { full_name: 'Access Person' } },
      });
      const { rows } = await db.owner.query<{ export_enc: Uint8Array }>(
        'SELECT export_enc FROM privacy_requests WHERE request_id = $1',
        [res.body.request_id],
      );
      expect(Buffer.from(rows[0]!.export_enc).toString('latin1')).not.toContain('Access Person');
      expect(
        (await http.get(`/v1/privacy/requests/${res.body.request_id}`).set(auth(adminA))).body
          .export.personal_data.email,
      ).toBe('access@me.test');

      const held = await newCandidate(recruiterA, { full_name: 'Held Person' });
      const hold = await http
        .patch(`/v1/candidates/${held}`)
        .set(auth(adminA))
        .set('If-Match', '"1"')
        .send({ legal_hold: true });
      expect(hold.body.legal_hold).toBe(true);
      const refused = await http
        .post('/v1/privacy/requests')
        .set(auth(adminA))
        .send({ type: 'erasure', candidate_id: held });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('LEGAL_HOLD');
      expect(
        (
          await http
            .patch(`/v1/candidates/${held}`)
            .set(auth(recruiterA))
            .set('If-Match', '"2"')
            .send({ legal_hold: false })
        ).status,
      ).toBe(403);
    });

    it('sweeps candidates past retention (not employees or holds) and flags overdue ACKs', async () => {
      const old = await newCandidate(recruiterA, { full_name: 'Old Applicant' });
      const staff = await newCandidate(
        adminA,
        { full_name: 'Old Employee' },
        { source: 'employee' },
      );
      await db.owner.query(
        `UPDATE candidates SET last_activity_at = now() - interval '800 days' WHERE candidate_id = ANY($1::uuid[])`,
        [[old, staff]],
      );
      const sweeper = await signTestToken({ sub: 'svc_scheduler', roles: ['service'] });
      const swept = await http
        .post('/v1/privacy:sweepRetention')
        .query({ tenant_id: tenantA })
        .set(auth(sweeper));
      expect(swept.body.erased).toEqual([old]);

      clock.advanceBy(8 * 24 * 60 * 60 * 1000);
      const overdue = await http
        .post('/v1/privacy:sweepOverdue')
        .query({ tenant_id: tenantA })
        .set(auth(sweeper));
      expect(overdue.body.overdue.length).toBeGreaterThanOrEqual(1);
      clock.set(NOW);
    });
  });

  describe('key rotation', () => {
    it('keeps old ciphertexts readable and blind indexes stable after the DEK rotates', async () => {
      const before = await newCandidate(adminB, {
        full_name: 'Before Rotation',
        email: 'before@rot.test',
      });
      await addKey(tenantB);
      keyCache.evict(tenantB);
      const after = await newCandidate(adminB, {
        full_name: 'After Rotation',
        email: 'after@rot.test',
      });
      const { rows } = await db.owner.query<{ candidate_id: string; v: number }>(
        `SELECT candidate_id, get_byte(pii_enc, 1) * 256 + get_byte(pii_enc, 2) AS v FROM candidates WHERE candidate_id = ANY($1::uuid[])`,
        [[before, after]],
      );
      expect(Object.fromEntries(rows.map((r) => [r.candidate_id, Number(r.v)]))).toEqual({
        [before]: 1,
        [after]: 2,
      });
      expect(
        (await http.get(`/v1/candidates/${before}`).set(auth(adminB))).body.pii.full_name,
      ).toBe('Before Rotation');
      expect(
        (await http.get('/v1/candidates').query({ email: 'before@rot.test' }).set(auth(adminB)))
          .body.items,
      ).toHaveLength(1);
    });
  });

  describe('tenant purge', () => {
    it('removes every row and object of the tenant', async () => {
      const id = await newCandidate(adminB, { full_name: 'Purge Me' });
      storage.put(`t/${tenantB}/resumes/${newId()}`, Buffer.from('%PDF-'));
      await emit(TenantPurged.topic, tenantB, tenantB, {
        tenant_id: tenantB,
        from_status: 'offboarding',
        to_status: 'purged',
        reason: null,
        actor: 'staff-1',
        occurred_at: NOW.toISOString(),
      });
      const { rows } = await db.owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM candidates WHERE tenant_id = $1',
        [tenantB],
      );
      expect(rows[0]!.n).toBe(0);
      expect([...storage.objects.keys()].some((k) => k.startsWith(`t/${tenantB}/`))).toBe(false);
      expect(
        (
          await db.owner.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM candidates WHERE tenant_id = $1',
            [tenantA],
          )
        ).rows[0]!.n,
      ).toBeGreaterThan(0);
      expect(id).toBeTruthy();
    });
  });

  it('AT6: logs contain no PII (including query strings)', () => {
    const text = JSON.stringify(logs.lines);
    expect(logs.lines.length).toBeGreaterThan(20);
    for (const secret of [
      'Lovelace',
      'ada@example.com',
      'ADA@example.com',
      '7946',
      'grace@navy.test',
      'Erase Me',
      'shared@corp.test',
      'Access Person',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    const lookup = logs.lines.find((l) => l['path'] === '/v1/candidates' && l['method'] === 'GET');
    expect(lookup).toBeDefined();
  });
});

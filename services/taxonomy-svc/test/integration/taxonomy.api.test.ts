/**
 * Acceptance tests 1–6 from docs/prompts/03-taxonomy-svc.md §8, against the real HTTP stack and
 * Postgres (PGlite with ltree + pgvector) running as the RLS-bound atlas_app role.
 */
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantPurged } from '@atlas/contracts';
import {
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
import { TAXONOMY_CONSUMER, TenantEventHandlers } from '../../src/application/tenant-events';
import { FixtureEmbeddings } from './fixture-embeddings';

describe('taxonomy-svc API', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let http: ReturnType<typeof request>;
  const clock = new FixedClock(new Date('2026-11-05T09:00:00Z'));
  const embeddings = new FixtureEmbeddings();
  const tenantA = newId();
  const tenantB = newId();
  let curator: string;
  let adminA: string;
  let adminB: string;
  let recruiterA: string;
  const ids: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function curate(body: Record<string, unknown>): Promise<string> {
    const res = await http.post('/v1/skills').set(auth(curator)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.skill_id as string;
  }

  const normalize = (token: string, terms: string[]) =>
    http.post('/v1/skills:normalize').set(auth(token)).send({ terms });

  const csv = (rows: string[]) => Buffer.from(rows.join('\n'));
  const upload = (token: string, content: Buffer, name = 'skills.csv') =>
    http.post('/v1/taxonomy-imports').set(auth(token)).attach('file', content, name);

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await NestFactory.create(
      AppModule.register({ db, clock, verifier: new JwtVerifier({ ...TEST_AUTH }), embeddings }),
      { logger: false },
    );
    configureHttpApp(
      app,
      createLogger({ service: 'taxonomy-svc', level: 'info', destination: new MemoryLogStream() }),
    );
    await app.init();
    http = request(app.getHttpServer());
    curator = await signTestToken({ sub: 'curator-1', roles: ['super_admin'] });
    adminA = await signTestToken({ sub: 'admin-a', tid: tenantA, roles: ['tenant_admin'] });
    adminB = await signTestToken({ sub: 'admin-b', tid: tenantB, roles: ['tenant_admin'] });
    recruiterA = await signTestToken({ sub: 'rec-a', tid: tenantA, roles: ['recruiter'] });

    // Global taxonomy, built by the curator through the API.
    ids['tech'] = await curate({ node_type: 'domain', path: 'technology', name: 'Technology' });
    ids['software'] = await curate({
      node_type: 'subdomain',
      path: 'technology.software',
      name: 'Software',
    });
    ids['data'] = await curate({
      node_type: 'cluster',
      path: 'technology.software.data',
      name: 'Data engineering',
    });
    ids['web'] = await curate({
      node_type: 'cluster',
      path: 'technology.software.web',
      name: 'Web development',
    });
    ids['kafka'] = await curate({
      node_type: 'skill',
      path: 'technology.software.data.kafka',
      name: 'Kafka',
      description: 'Distributed event streaming platform',
      classification: 'tool',
      aliases: ['Apache Kafka'],
    });
    ids['rabbitmq'] = await curate({
      node_type: 'skill',
      path: 'technology.software.data.rabbitmq',
      name: 'RabbitMQ',
      classification: 'tool',
    });
    ids['python'] = await curate({
      node_type: 'skill',
      path: 'technology.software.data.python',
      name: 'Python',
      classification: 'technical',
    });
    ids['pandas'] = await curate({
      node_type: 'skill',
      path: 'technology.software.data.pandas',
      name: 'Pandas',
      classification: 'tool',
    });
    ids['numpy'] = await curate({
      node_type: 'skill',
      path: 'technology.software.data.numpy',
      name: 'NumPy',
      classification: 'tool',
    });
    ids['javascript'] = await curate({
      node_type: 'skill',
      path: 'technology.software.web.javascript',
      name: 'JavaScript',
      aliases: ['JS', 'ECMAScript'],
      classification: 'technical',
    });
    ids['typescript'] = await curate({
      node_type: 'skill',
      path: 'technology.software.web.typescript',
      name: 'TypeScript',
    });
    ids['jquery'] = await curate({
      node_type: 'skill',
      path: 'technology.software.web.jquery',
      name: 'jQuery',
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('hierarchy and browsing', () => {
    it('enforces one level per node type and a parent that exists', async () => {
      const deep = await http
        .post('/v1/skills')
        .set(auth(curator))
        .send({ node_type: 'cluster', path: 'technology.software', name: 'x' });
      expect(deep.body.code).toBe('PATH_DEPTH_MISMATCH');
      const orphan = await http
        .post('/v1/skills')
        .set(auth(curator))
        .send({ node_type: 'skill', path: 'nowhere.a.b.c', name: 'x' });
      expect(orphan.body.code).toBe('PARENT_NOT_FOUND');
      const dupe = await http
        .post('/v1/skills')
        .set(auth(curator))
        .send({ node_type: 'skill', path: 'technology.software.data.kafka', name: 'Kafka 2' });
      expect(dupe.status).toBe(409);
    });

    it('lists a subtree, searches and returns ancestors and related skills', async () => {
      const data = await http
        .get('/v1/skills')
        .query({ path: 'technology.software.data', node_type: 'skill' })
        .set(auth(recruiterA));
      expect(data.status).toBe(200);
      expect(data.body.items.map((s: { name: string }) => s.name)).toEqual([
        'Kafka',
        'NumPy',
        'Pandas',
        'Python',
        'RabbitMQ',
      ]);

      const search = await http
        .get('/v1/skills')
        .query({ q: 'apache kafka' })
        .set(auth(recruiterA));
      expect(search.body.items.map((s: { name: string }) => s.name)).toEqual(['Kafka']);

      const page1 = await http
        .get('/v1/skills')
        .query({ node_type: 'skill', limit: 3 })
        .set(auth(recruiterA));
      const page2 = await http
        .get('/v1/skills')
        .query({ node_type: 'skill', limit: 3, cursor: page1.body.next_cursor })
        .set(auth(recruiterA));
      const names = [...page1.body.items, ...page2.body.items].map((s: { name: string }) => s.name);
      expect(new Set(names).size).toBe(6);

      await http
        .post('/v1/skill-edges')
        .set(auth(curator))
        .send({ src: ids['rabbitmq'], dst: ids['kafka'], edge_type: 'RELATED_TO', weight: 0.6 });
      const kafka = await http.get(`/v1/skills/${ids['kafka']}`).set(auth(recruiterA));
      expect(kafka.headers['etag']).toBe('"1"');
      expect(kafka.body.ancestors.map((a: { path: string }) => a.path)).toEqual([
        'technology',
        'technology.software',
        'technology.software.data',
      ]);
      expect(kafka.body.related).toEqual([
        expect.objectContaining({
          name: 'RabbitMQ',
          edge_type: 'RELATED_TO',
          direction: 'both',
          weight: 0.6,
        }),
      ]);
    });
  });

  describe('AT2: prerequisite cycles', () => {
    it('rejects a prerequisite that would close a cycle; RELATED_TO is stored once', async () => {
      const edge = (src: string, dst: string, edge_type = 'PREREQUISITE_OF') =>
        http
          .post('/v1/skill-edges')
          .set(auth(curator))
          .send({ src: ids[src], dst: ids[dst], edge_type, weight: 0.8 });
      expect((await edge('python', 'numpy')).status).toBe(201);
      expect((await edge('numpy', 'pandas')).status).toBe(201);
      const direct = await edge('numpy', 'python');
      expect(direct.status).toBe(422);
      expect(direct.body.code).toBe('PREREQUISITE_CYCLE');
      expect((await edge('pandas', 'python')).body.code).toBe('PREREQUISITE_CYCLE'); // 3-hop cycle

      // Symmetric edge already exists as rabbitmq–kafka; the reverse is the same edge.
      expect((await edge('kafka', 'rabbitmq', 'RELATED_TO')).status).toBe(409);
      const { rows } = await db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM skill_edges WHERE edge_type = 'RELATED_TO'`,
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('a tenant edge cannot close a cycle through global edges either', async () => {
      const res = await http.post('/v1/skill-edges').set(auth(adminA)).send({
        src: ids['pandas'],
        dst: ids['python'],
        edge_type: 'PREREQUISITE_OF',
        weight: 0.5,
      });
      expect(res.body.code).toBe('PREREQUISITE_CYCLE');
    });
  });

  describe('AT3: normalisation', () => {
    it('maps aliases, nearest neighbours and nothing, with confidence and method', async () => {
      embeddings.pin('event streaming', 'Kafka: Distributed event streaming platform', 0.9);
      const res = await normalize(recruiterA, [
        'JS',
        'event streaming',
        'qwzxv blorft',
        '  apache   KAFKA ',
        '',
      ]);
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        { term: 'JS', skill_id: ids['javascript'], confidence: 1, method: 'alias' },
        { term: 'event streaming', skill_id: ids['kafka'], confidence: 0.9, method: 'ann' },
        expect.objectContaining({ term: 'qwzxv blorft', skill_id: null, method: 'none' }),
        { term: '  apache   KAFKA ', skill_id: ids['kafka'], confidence: 1, method: 'alias' },
        { term: '', skill_id: null, confidence: 0, method: 'none' },
      ]);
      expect(res.body.results[2].confidence).toBeLessThan(0.7);
    });

    it('queues 0.70–0.82 matches as suggestions for the tenant and returns null', async () => {
      embeddings.pin('message brokering', 'Kafka: Distributed event streaming platform', 0.75);
      const res = await normalize(recruiterA, ['message brokering']);
      expect(res.body.results[0]).toEqual({
        term: 'message brokering',
        skill_id: null,
        confidence: 0.75,
        method: 'none',
      });
      await normalize(recruiterA, ['message brokering']);
      const queue = await http.get('/v1/skill-suggestions').set(auth(adminA));
      expect(queue.body.items).toEqual([
        expect.objectContaining({
          term: 'message brokering',
          best_skill_id: ids['kafka'],
          occurrences: 2,
        }),
      ]);
      expect((await http.get('/v1/skill-suggestions').set(auth(adminB))).body.items).toEqual([]);
    });

    it('accepts at most 100 terms and reports an embedding outage as 503', async () => {
      expect(
        (
          await normalize(
            recruiterA,
            Array.from({ length: 101 }, () => 'x'),
          )
        ).status,
      ).toBe(400);
      embeddings.failing = true;
      const down = await normalize(recruiterA, ['unknown thing']);
      embeddings.failing = false;
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('EMBEDDINGS_UNAVAILABLE');
      // Alias hits need no embedding call at all.
      const before = embeddings.calls;
      expect((await normalize(recruiterA, ['JS'])).body.results[0].method).toBe('alias');
      expect(embeddings.calls).toBe(before);
    });
  });

  describe('AT4: tenant overlays', () => {
    it('hides a global skill for that tenant only, and applies renames and aliases', async () => {
      const hide = await http
        .put(`/v1/skills/${ids['jquery']}/override`)
        .set(auth(adminA))
        .send({ hidden: true });
      expect(hide.status).toBe(200);
      const listA = await http
        .get('/v1/skills')
        .query({ path: 'technology.software.web' })
        .set(auth(recruiterA));
      expect(listA.body.items.map((s: { name: string }) => s.name)).not.toContain('jQuery');
      expect((await http.get(`/v1/skills/${ids['jquery']}`).set(auth(recruiterA))).status).toBe(
        404,
      );
      expect((await normalize(recruiterA, ['jquery'])).body.results[0].skill_id).toBeNull();

      const listB = await http
        .get('/v1/skills')
        .query({ path: 'technology.software.web' })
        .set(auth(adminB));
      expect(listB.body.items.map((s: { name: string }) => s.name)).toContain('jQuery');
      expect((await normalize(adminB, ['jquery'])).body.results[0].skill_id).toBe(ids['jquery']);

      const rename = await http
        .put(`/v1/skills/${ids['typescript']}/override`)
        .set(auth(adminA))
        .send({ adopted: true, display_name: 'TS (typed JavaScript)', aliases: ['TS'] });
      expect(rename.body).toMatchObject({
        name: 'TS (typed JavaScript)',
        canonical_name: 'TypeScript',
        override: { adopted: true },
      });
      expect((await normalize(recruiterA, ['TS'])).body.results[0].skill_id).toBe(
        ids['typescript'],
      );
      expect((await normalize(adminB, ['TS'])).body.results[0].method).not.toBe('alias');

      // Tenants cannot edit global skills directly.
      const patch = await http
        .patch(`/v1/skills/${ids['kafka']}`)
        .set(auth(adminA))
        .set('If-Match', '"1"')
        .send({ name: 'Mine' });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('GLOBAL_SKILL_READ_ONLY');
      expect(
        (
          await http
            .put(`/v1/skills/${ids['jquery']}/override`)
            .set(auth(recruiterA))
            .send({ hidden: false })
        ).status,
      ).toBe(403);
    });
  });

  describe('AT5: cross-tenant isolation', () => {
    it('tenant B never sees, finds or edits tenant A’s custom skills (leak test)', async () => {
      const created = await http
        .post('/v1/skills')
        .set(auth(adminA))
        .send({
          node_type: 'skill',
          path: 'technology.software.data.acme_ledger_dsl',
          name: 'Acme Ledger DSL',
          aliases: ['ALD'],
        });
      expect(created.status).toBe(201);
      expect(created.body.scope).toBe('tenant');
      const id = created.body.skill_id as string;

      expect((await http.get(`/v1/skills/${id}`).set(auth(recruiterA))).status).toBe(200);
      expect((await http.get(`/v1/skills/${id}`).set(auth(adminB))).status).toBe(404);
      expect(
        (await http.get(`/v1/skills/${id}`).query({ tenant_id: tenantA }).set(auth(adminB))).status,
      ).toBe(404);
      const listB = await http
        .get('/v1/skills')
        .query({ path: 'technology.software.data' })
        .set(auth(adminB));
      expect(listB.body.items.map((s: { skill_id: string }) => s.skill_id)).not.toContain(id);
      expect((await normalize(adminB, ['ALD'])).body.results[0].skill_id).toBeNull();
      expect((await normalize(recruiterA, ['ALD'])).body.results[0].skill_id).toBe(id);
      const patchB = await http
        .patch(`/v1/skills/${id}`)
        .set(auth(adminB))
        .set('If-Match', '"1"')
        .send({ name: 'x' });
      expect(patchB.status).toBe(404);

      // The global view (curator without tenant_id) excludes tenant skills too.
      const global = await http
        .get('/v1/skills')
        .query({ path: 'technology.software.data' })
        .set(auth(curator));
      expect(global.body.items.map((s: { skill_id: string }) => s.skill_id)).not.toContain(id);

      // Readers cannot write.
      expect(
        (
          await http
            .post('/v1/skills')
            .set(auth(recruiterA))
            .send({ node_type: 'domain', path: 'x', name: 'x' })
        ).status,
      ).toBe(403);
    });
  });

  describe('AT6: deprecation', () => {
    it('emits an event, keeps the row and resolves old ids and aliases to the successor', async () => {
      const legacy = await curate({
        node_type: 'skill',
        path: 'technology.software.web.ecmascript5',
        name: 'ES5',
        aliases: ['ECMAScript 5'],
      });
      const res = await http
        .post(`/v1/skills/${legacy}:deprecate`)
        .set(auth(curator))
        .send({ replaced_by: ids['javascript'] });
      expect(res.status).toBe(200);
      expect(res.body.deprecated_at).not.toBeNull();
      expect(res.body.successor).toMatchObject({ skill_id: ids['javascript'], name: 'JavaScript' });

      const old = await http.get(`/v1/skills/${legacy}`).set(auth(recruiterA));
      expect(old.status).toBe(200);
      expect(old.body.successor.skill_id).toBe(ids['javascript']);
      expect(old.body.related).toEqual([
        expect.objectContaining({
          skill_id: ids['javascript'],
          edge_type: 'REPLACES',
          direction: 'out',
        }),
      ]);

      expect((await normalize(recruiterA, ['ECMAScript 5'])).body.results[0]).toMatchObject({
        skill_id: ids['javascript'],
        method: 'alias',
      });
      const { rows } = await db.owner.query<{
        payload: { replaced_by: string; tenant_id: string | null };
      }>(
        `SELECT payload FROM outbox_events WHERE topic = 'taxonomy.skill.deprecated.v1' AND aggregate_id = $1`,
        [legacy],
      );
      expect(rows[0]!.payload).toMatchObject({ replaced_by: ids['javascript'], tenant_id: null });

      const again = await http.post(`/v1/skills/${legacy}:deprecate`).set(auth(curator)).send({});
      expect(again.body.code).toBe('SKILL_DEPRECATED');
      const wrongType = await http
        .post(`/v1/skills/${ids['jquery']}:deprecate`)
        .set(auth(curator))
        .send({ replaced_by: ids['web'] });
      expect(wrongType.body.code).toBe('INVALID_SUCCESSOR');
    });
  });

  describe('AT1: bulk import', () => {
    it('shows a correct dry-run diff, refuses errors, and commits atomically', async () => {
      const file = csv([
        'path,node_type,name,description,classification,aliases',
        'technology.software.ml,cluster,Machine learning,,,',
        'technology.software.ml.pytorch,skill,PyTorch,Deep learning framework,tool,Torch;PT',
        'technology.software.data.acme_ledger_dsl,skill,Acme Ledger DSL,Internal ledger language,technical,ALD',
        'technology.software.data.kafka,skill,Kafka,,tool,',
        'technology.software.nope.x,skill,Orphan,,,',
        'technology.software.ml.pytorch,skill,PyTorch again,,,',
      ]);
      const dry = await upload(adminA, file);
      expect(dry.status).toBe(201);
      expect(dry.body.summary).toEqual({ create: 2, update: 1, unchanged: 0, error: 3 });
      const byLine = Object.fromEntries(dry.body.entries.map((e: { line: number }) => [e.line, e]));
      expect(byLine[2]).toMatchObject({ action: 'create' });
      expect(byLine[4]).toMatchObject({
        action: 'update',
        changed: ['description', 'classification'],
      });
      expect(byLine[5].errors).toEqual([
        'this path is a global skill; change it with an override instead',
      ]);
      expect(byLine[6].errors[0]).toMatch(/parent "technology.software.nope" does not exist/);
      expect(byLine[7].errors[0]).toMatch(/duplicate of line 3/);

      const refused = await http
        .post(`/v1/taxonomy-imports/${dry.body.import_id}:commit`)
        .set(auth(adminA));
      expect(refused.body.code).toBe('IMPORT_HAS_ERRORS');

      const good = await upload(
        adminA,
        csv([
          'path,node_type,name,description,classification,aliases',
          'technology.software.ml,cluster,Machine learning,,,',
          'technology.software.ml.pytorch,skill,PyTorch,Deep learning framework,tool,Torch;PT',
          'technology.software.data.acme_ledger_dsl,skill,Acme Ledger DSL,Internal ledger language,technical,ALD',
        ]),
      );
      expect(good.body.summary).toEqual({ create: 2, update: 1, unchanged: 0, error: 0 });
      // B cannot see or commit A's import.
      expect(
        (await http.post(`/v1/taxonomy-imports/${good.body.import_id}:commit`).set(auth(adminB)))
          .status,
      ).toBe(404);

      const committed = await http
        .post(`/v1/taxonomy-imports/${good.body.import_id}:commit`)
        .set(auth(adminA));
      expect(committed.status).toBe(200);
      expect(committed.body.status).toBe('committed');
      expect((await normalize(recruiterA, ['Torch'])).body.results[0].method).toBe('alias');
      const ledger = await http.get('/v1/skills').query({ q: 'acme ledger' }).set(auth(recruiterA));
      expect(ledger.body.items[0]).toMatchObject({
        description: 'Internal ledger language',
        classification: 'technical',
      });
      expect(
        (await http.post(`/v1/taxonomy-imports/${good.body.import_id}:commit`).set(auth(adminA)))
          .body.code,
      ).toBe('IMPORT_ALREADY_COMMITTED');
    });

    it('refuses a stale plan and applies nothing', async () => {
      const dry = await upload(
        adminA,
        csv([
          'path,node_type,name',
          'technology.software.ml.jax,skill,JAX',
          'technology.software.ml.keras,skill,Keras',
        ]),
      );
      // Someone changes the taxonomy after the dry run.
      await http
        .post('/v1/skills')
        .set(auth(adminA))
        .send({ node_type: 'skill', path: 'technology.software.ml.onnx', name: 'ONNX' });
      const stale = await http
        .post(`/v1/taxonomy-imports/${dry.body.import_id}:commit`)
        .set(auth(adminA));
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('IMPORT_STALE');
      const { rows } = await db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM skills WHERE path::text IN ('technology.software.ml.jax', 'technology.software.ml.keras')`,
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('reads .xlsx workbooks and rejects other file types', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('skills');
      sheet.addRow(['Path', 'Node_Type', 'Name', 'Aliases']);
      sheet.addRow(['technology.software.ml.scikit_learn', 'skill', 'scikit-learn', 'sklearn']);
      const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
      const dry = await upload(adminB, xlsx, 'skills.xlsx');
      // technology.software.ml is tenant A's cluster: invisible to B, so the parent is missing.
      expect(dry.body.entries[0].errors[0]).toMatch(
        /parent "technology.software.ml" does not exist/,
      );
      const curatorDry = await upload(
        curator,
        csv(['path,node_type,name', 'technology.software.data.sklearn2,skill,scikit-learn']),
      );
      expect(curatorDry.body.summary.create).toBe(1);

      expect((await upload(adminA, Buffer.from('hello'), 'notes.txt')).body.code).toBe(
        'UNSUPPORTED_FILE_TYPE',
      );
      expect((await upload(adminA, csv(['name', 'x']))).body.code).toBe('IMPORT_MISSING_COLUMNS');
    });
  });

  describe('versioned publishing', () => {
    it('publishes pending changes as the next version, per scope', async () => {
      const before = await http.get('/v1/taxonomy/version').set(auth(adminA));
      expect(before.body).toMatchObject({ tenant_id: tenantA, published_version: 0 });
      expect(before.body.pending_changes).toBeGreaterThan(0);
      const published = await http.post('/v1/taxonomy:publish').set(auth(adminA));
      expect(published.body).toEqual({ version: 1, changed_skills: before.body.pending_changes });
      expect((await http.post('/v1/taxonomy:publish').set(auth(adminA))).body.code).toBe(
        'NOTHING_TO_PUBLISH',
      );

      const global = await http.post('/v1/taxonomy:publish').set(auth(curator));
      expect(global.body.version).toBe(1);
      const { rows } = await db.owner.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM outbox_events WHERE topic = 'taxonomy.version.published.v1' ORDER BY created_at`,
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([tenantA, null]);
    });
  });

  describe('job profiles', () => {
    it('validates required skills, publishes and emits job_profile.updated', async () => {
      const family = await http
        .post('/v1/job-families')
        .set(auth(adminA))
        .send({ name: 'Engineering' });
      const role = await http
        .post('/v1/job-roles')
        .set(auth(adminA))
        .send({ job_family_id: family.body.job_family_id, name: 'Data Engineer', level: 'L3' });
      expect(role.status).toBe(201);
      const created = await http
        .post('/v1/job-profiles')
        .set(auth(adminA))
        .send({ title: 'Senior Data Engineer', job_role_id: role.body.job_role_id });
      expect(created.status).toBe(201);
      const id = created.body.job_profile_id as string;

      expect((await http.post(`/v1/job-profiles/${id}:publish`).set(auth(adminA))).body.code).toBe(
        'SKILLS_REQUIRED',
      );

      const put = (version: string, skills: object[]) =>
        http
          .put(`/v1/job-profiles/${id}/skills`)
          .set(auth(adminA))
          .set('If-Match', version)
          .send({ skills });
      expect(
        (await put('"1"', [{ skill_id: ids['kafka'], weight: 0, target_proficiency: 3 }])).body
          .code,
      ).toBe('INVALID_WEIGHT');
      expect(
        (await put('"1"', [{ skill_id: ids['kafka'], weight: 0.5, target_proficiency: 3.3 }])).body
          .code,
      ).toBe('INVALID_TARGET_PROFICIENCY');
      expect(
        (await put('"1"', [{ skill_id: ids['jquery'], weight: 0.5, target_proficiency: 3 }]))
          .status,
      ).toBe(404); // hidden for A
      expect(
        (await put('"1"', [{ skill_id: ids['data'], weight: 0.5, target_proficiency: 3 }])).body
          .code,
      ).toBe('INVALID_PROFILE_SKILL');

      const ok = await put('"1"', [
        { skill_id: ids['kafka'], weight: 0.6, target_proficiency: 4, must_have: true },
        { skill_id: ids['python'], weight: 0.4, target_proficiency: 3.5 },
      ]);
      expect(ok.status).toBe(200);
      expect(ok.headers['etag']).toBe('"2"');
      const published = await http
        .post(`/v1/job-profiles/${id}:publish`)
        .set(auth(adminA))
        .set('If-Match', '"2"');
      expect(published.body).toMatchObject({ status: 'published', version: 3 });

      const { rows } = await db.owner.query<{
        payload: { status: string; skills: { skill_id: string; must_have: boolean }[] };
      }>(
        `SELECT payload FROM outbox_events WHERE topic = 'taxonomy.job_profile.updated.v1' AND aggregate_id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.status).toBe('published');
      expect(rows[0]!.payload.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ skill_id: ids['kafka'], must_have: true }),
        ]),
      );

      expect((await put('"3"', [])).body.code).toBe('SKILLS_REQUIRED');
      expect((await http.get(`/v1/job-profiles/${id}`).set(auth(adminB))).status).toBe(404);
      const list = await http
        .get('/v1/job-profiles')
        .query({ status: 'published' })
        .set(auth(recruiterA));
      expect(list.body.items).toHaveLength(1);
    });
  });

  describe('tenant purge', () => {
    it('removes everything tenant A owns and nothing global', async () => {
      const consumer = createConsumer({
        name: TAXONOMY_CONSUMER,
        db,
        handlers: app.get(TenantEventHandlers).handlers(),
      });
      const globalBefore = await db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM skills WHERE tenant_id IS NULL`,
      );
      await consumer.handle({
        eventId: newId(),
        topic: TenantPurged.topic,
        tenantId: tenantA,
        aggregateId: tenantA,
        payload: {
          tenant_id: tenantA,
          from_status: 'offboarding',
          to_status: 'purged',
          reason: null,
          actor: 'staff-1',
          occurred_at: clock.now().toISOString(),
        },
      });
      for (const table of [
        'skills',
        'tenant_skill_overrides',
        'job_profiles',
        'skill_edges',
        'taxonomy_import_batches',
        'unmapped_skill_suggestions',
      ]) {
        const { rows } = await db.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
          [tenantA],
        );
        expect(rows[0]!.n, table).toBe(0);
      }
      const globalAfter = await db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM skills WHERE tenant_id IS NULL`,
      );
      expect(globalAfter.rows[0]!.n).toBe(globalBefore.rows[0]!.n);
    });
  });
});

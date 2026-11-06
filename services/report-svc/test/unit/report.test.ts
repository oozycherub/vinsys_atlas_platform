import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { chromium } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import { UpstreamError } from '../../src/application/ports';
import { loadReportSvcConfig } from '../../src/config';
import { overallScore, type SessionFacts, status } from '../../src/domain/facts';
import { bindGallery, GALLERY, galleryReport } from '../../src/domain/gallery';
import { signLink, verifyLink } from '../../src/domain/links';
import { defaultSections, effectiveSections, normaliseSections } from '../../src/domain/sections';
import {
  ChromiumPdfRenderer,
  FsArtifactStore,
  HttpDirectory,
  HttpProctoringEvidence,
  S3ArtifactStore,
  TrinoLakehouse,
  trinoLiteral,
} from '../../src/infrastructure/adapters';
import { esc, renderCandidateReport } from '../../src/templates/candidate-report';

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: '0194f1b2-0000-7000-8000-000000000001',
  assessmentId: null,
  assessmentVersion: null,
  candidateId: null,
  attemptNo: null,
  startedAt: null,
  deadlineAt: null,
  submittedAt: null,
  outcome: null,
  terminatedReason: null,
  skills: null,
  evaluatedAt: null,
  trustScore: null,
  trustBand: null,
  trustBreakdown: null,
  trustReview: null,
  interview: null,
  ...over,
});

describe('sections', () => {
  it('forces mandatory sections on and drops unknown keys', () => {
    expect(normaliseSections({ summary: false, integrity: false, bogus: true } as never)).toEqual({
      summary: true,
      skill_scores: true,
      integrity: false,
      proctoring_evidence: false,
      ai_interview: true,
    });
    expect(normaliseSections(null)).toEqual(defaultSections());
  });

  it('a request narrows optional sections only', () => {
    const tenant = { ...defaultSections(), proctoring_evidence: false };
    expect(effectiveSections(tenant, ['proctoring_evidence'])).toMatchObject({
      summary: true,
      skill_scores: true,
      integrity: false,
      proctoring_evidence: false,
      ai_interview: false,
    });
    expect(effectiveSections(tenant, null)).toEqual(tenant);
  });
});

describe('facts', () => {
  it('weights the overall score by confidence', () => {
    expect(overallScore(null)).toBeNull();
    expect(overallScore([])).toBeNull();
    expect(
      overallScore([
        { skillId: 'a', score: 4, confidence: 1 },
        { skillId: 'b', score: 2, confidence: 0 },
      ]),
    ).toBe(4);
    expect(
      overallScore([
        { skillId: 'a', score: 4, confidence: 0 },
        { skillId: 'b', score: 2, confidence: 0 },
      ]),
    ).toBe(3);
  });

  it('derives a status', () => {
    expect(status(facts())).toBe('unknown');
    expect(status(facts({ startedAt: new Date() }))).toBe('in_progress');
    expect(status(facts({ submittedAt: new Date() }))).toBe('submitted');
    expect(status(facts({ submittedAt: new Date(), outcome: 'expired' }))).toBe('expired');
    expect(status(facts({ terminatedReason: 'x' }))).toBe('terminated');
  });
});

describe('the report template', () => {
  it('escapes everything and shows placeholders for missing data', () => {
    const html = renderCandidateReport({
      tenantName: '<Corp>',
      candidateName: null,
      facts: facts({
        candidateId: '12345678-aaaa-7000-8000-000000000000',
        terminatedReason: '<b>left</b>',
        trustBand: 'weird"',
        trustScore: 50,
        trustBreakdown: { a: 0 },
      }),
      sections: { ...defaultSections(), proctoring_evidence: true },
      skillNames: new Map(),
      evidence: [],
      generatedAt: new Date('2026-11-06T09:00:00Z'),
    });
    expect(html).toContain('&lt;Corp&gt;');
    expect(html).toContain('Candidate 12345678');
    expect(html).toContain('terminated — &lt;b&gt;left&lt;/b&gt;');
    expect(html).toContain('class="band band-yellow"');
    expect(html).toContain('Not evaluated yet.');
    expect(html).toContain('No flagged frames.');
    expect(html).toContain('No AI interview.');
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    const noTrust = renderCandidateReport({
      tenantName: null,
      candidateName: 'x',
      facts: facts(),
      sections: defaultSections(),
      skillNames: new Map(),
      evidence: [],
      generatedAt: new Date(),
    });
    expect(noTrust).toContain('No proctoring result.');
  });
});

describe('signed links', () => {
  const key = Buffer.alloc(32, 7);
  it('verifies, expires and refuses over-long or forged links', () => {
    const now = 1_800_000_000_000;
    const exp = Math.floor((now + 900_000) / 1000);
    const sig = signLink(key, 't', 'a', exp);
    expect(verifyLink(key, 't', 'a', exp, sig, now, 900_000)).toBe('ok');
    expect(verifyLink(key, 't', 'a', exp, sig, exp * 1000, 900_000)).toBe('expired');
    expect(verifyLink(key, 't', 'b', exp, sig, now, 900_000)).toBe('invalid');
    expect(verifyLink(key, 'other-tenant', 'a', exp, sig, now, 900_000)).toBe('invalid');
    expect(verifyLink(key, 't', 'a', exp, 'short', now, 900_000)).toBe('invalid');
    const far = exp + 7200;
    expect(verifyLink(key, 't', 'a', far, signLink(key, 't', 'a', far), now, 900_000)).toBe(
      'invalid',
    );
  });
});

describe('gallery', () => {
  it('every query is tenant-scoped with one placeholder per parameter', () => {
    for (const g of GALLERY) {
      expect(g.sql).toContain('tenant_id = ?');
      expect(g.sql.split('?').length - 1).toBe(1 + g.params.length);
    }
    expect(galleryReport('nope')).toBeUndefined();
  });

  it('binds dates only', () => {
    const r = galleryReport('assessment_outcomes');
    expect(r).toBeDefined();
    if (!r) return;
    expect(bindGallery(r, 'T', { from: '2026-01-01', to: '2026-02-30x' }).problems).toEqual([
      'to: a date (YYYY-MM-DD) is required',
    ]);
    expect(bindGallery(r, 'T', { from: '2026-01-01', to: '2026-02-01', x: 1 }).problems).toEqual([
      'x: not a parameter of this report',
    ]);
  });
});

describe('Trino', () => {
  it('quotes literals', () => {
    expect(trinoLiteral({ kind: 'varchar', value: "a'b" })).toBe("'a''b'");
    expect(trinoLiteral({ kind: 'date', value: '2026-01-01' })).toBe("DATE '2026-01-01'");
    expect(() => trinoLiteral({ kind: 'date', value: "2026-01-01' OR 1=1" })).toThrow(
      'invalid date',
    );
  });

  it('binds with EXECUTE IMMEDIATE and follows nextUri pages', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const pages = [
      { nextUri: 'https://trino.test/v1/statement/q/1' },
      {
        nextUri: 'https://trino.test/v1/statement/q/2',
        columns: [{ name: 'a' }, { name: 'b' }],
        data: [[1, 'x']],
      },
      { data: [[2, 'y']] },
    ];
    const fake = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(pages.shift()), { status: 200 }));
    }) as unknown as typeof fetch;
    const t = new TrinoLakehouse({
      baseUrl: 'https://trino.test/',
      user: 'report-svc',
      catalog: 'lake',
      fetch: fake,
    });
    const r = await t.query("SELECT a, b FROM t WHERE tenant_id = ? AND name = 'it''s'", [
      { kind: 'varchar', value: "o'neil" },
    ]);
    expect(r.columns).toEqual(['a', 'b']);
    const rows: unknown[][] = [];
    for await (const row of r.rows) rows.push(row);
    expect(rows).toEqual([
      [1, 'x'],
      [2, 'y'],
    ]);
    expect(calls[0]?.url).toBe('https://trino.test/v1/statement');
    expect(calls[0]?.init.body).toBe(
      "EXECUTE IMMEDIATE 'SELECT a, b FROM t WHERE tenant_id = ? AND name = ''it''''s''' USING 'o''neil'",
    );
    expect((calls[0]?.init.headers as Record<string, string>)['X-Trino-Catalog']).toBe('lake');
  });

  it('surfaces errors: query errors are permanent, overload is transient', async () => {
    const respond = (status: number, body: unknown) =>
      new TrinoLakehouse({
        baseUrl: 'https://t.test',
        user: 'u',
        catalog: 'c',
        fetch: (() =>
          Promise.resolve(
            new Response(JSON.stringify(body), { status }),
          )) as unknown as typeof fetch,
      });
    await expect(
      respond(200, { error: { errorName: 'SYNTAX_ERROR', message: 'bad' } }).query('x', []),
    ).rejects.toThrow('SYNTAX_ERROR: bad');
    await expect(respond(503, {}).query('x', [])).rejects.toBeInstanceOf(UpstreamError);
    await expect(respond(400, {}).query('x', [])).rejects.toThrow('HTTP 400');
    const down = new TrinoLakehouse({
      baseUrl: 'https://t.test',
      user: 'u',
      catalog: 'c',
      fetch: (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch,
    });
    await expect(down.query('x', [])).rejects.toBeInstanceOf(UpstreamError);
    const noData = respond(200, { columns: [{ name: 'a' }] });
    const r = await noData.query('x', []);
    const rows: unknown[] = [];
    for await (const row of r.rows) rows.push(row);
    expect(rows).toEqual([]);
  });
});

describe('storage', () => {
  let dir = '';
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('disk: streams in, hashes, reads back, deletes; keys cannot escape the root', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'atlas-reports-'));
    const s = new FsArtifactStore(dir);
    const stored = await s.put('t1/r1/a.pdf', Readable.from([Buffer.from('ab'), Buffer.from('c')]));
    expect(stored).toEqual({
      sizeBytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    const chunks: Buffer[] = [];
    for await (const c of await s.get('t1/r1/a.pdf')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abc');
    await expect(s.put('../evil', Readable.from(['x']))).rejects.toThrow('invalid storage key');
    await s.delete(['t1/r1/a.pdf', 't1/r1/missing.pdf']);
    await expect(readFile(path.join(dir, 't1/r1/a.pdf'))).rejects.toThrow();
    await s.put('t2/r/b.xlsx', Readable.from(['x']));
    await s.deletePrefix('t2/');
    expect(existsSync(path.join(dir, 't2'))).toBe(false);
  });

  it('S3: uploads, reads, batch-deletes and deletes by prefix', async () => {
    const s3 = mockClient(S3Client);
    s3.on(PutObjectCommand).resolves({});
    s3.on(GetObjectCommand).resolves({ Body: Readable.from(['x']) as never });
    s3.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'p/1' }, { Key: 'p/2' }],
        IsTruncated: true,
        NextContinuationToken: 'n',
      })
      .resolvesOnce({ Contents: [], IsTruncated: false });
    s3.on(DeleteObjectsCommand).resolves({});
    const store = new S3ArtifactStore(new S3Client({ region: 'eu-west-1' }), 'bucket', 'kms-1');
    expect(
      await store.put('k', Readable.from([Buffer.from('hello')]), 'application/pdf'),
    ).toMatchObject({ sizeBytes: 5 });
    expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'k',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'kms-1',
    });
    expect(await store.get('k')).toBeDefined();
    await store.delete(Array.from({ length: 1001 }, (_, i) => `k${i}`));
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(2);
    await store.deletePrefix('p/');
    expect(s3.commandCalls(ListObjectsV2Command)[1]?.args[0].input).toMatchObject({
      ContinuationToken: 'n',
    });
    s3.restore();
  });
});

describe('directory and evidence clients', () => {
  const token = () => Promise.resolve('t');
  it('reads names and tolerates missing ones', async () => {
    const fake = ((url: string) => {
      if (url.includes('/v1/candidates/c1'))
        return Promise.resolve(new Response(JSON.stringify({ full_name: 'Ada' })));
      if (url.includes('/v1/candidates/'))
        return Promise.resolve(new Response('{}', { status: 404 }));
      if (url.includes('/v1/skills/s1'))
        return Promise.resolve(new Response(JSON.stringify({ name: 'Java' })));
      if (url.includes('/v1/skills/boom'))
        return Promise.resolve(new Response('{}', { status: 503 }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    }) as unknown as typeof fetch;
    const d = new HttpDirectory(
      { baseUrl: 'https://p.test/', token, fetch: fake },
      { baseUrl: 'https://t.test', token, fetch: fake },
    );
    expect(await d.candidateName('T', 'c1')).toBe('Ada');
    expect(await d.candidateName('T', 'c2')).toBeNull();
    expect(await d.skillNames('T', ['s1', 's2'])).toEqual(new Map([['s1', 'Java']]));
    await expect(d.skillNames('T', ['boom'])).rejects.toBeInstanceOf(UpstreamError);
    const down = new HttpDirectory(
      {
        baseUrl: 'https://p.test',
        token,
        fetch: (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch,
      },
      { baseUrl: 'https://t.test', token },
    );
    await expect(down.candidateName('T', 'c1')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('fetches flagged frames, keeping only small raster images', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fake = ((url: string) => {
      if (url.includes('/timeline'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              entries: [
                {
                  event_type: 'second_face',
                  severity: 3,
                  occurred_at: '2026-11-06T09:00:00Z',
                  frame_url: 'https://s3.test/f1',
                },
                { event_type: 'tab_switch', severity: 1, occurred_at: '2026-11-06T09:01:00Z' },
                {
                  event_type: 'gaze',
                  severity: 0,
                  occurred_at: '2026-11-06T09:02:00Z',
                  frame_url: 'https://s3.test/f0',
                },
                {
                  event_type: 'html',
                  severity: 2,
                  occurred_at: '2026-11-06T09:03:00Z',
                  frame_url: 'https://s3.test/f2',
                },
                {
                  event_type: 'huge',
                  severity: 2,
                  occurred_at: '2026-11-06T09:04:00Z',
                  frame_url: 'https://s3.test/f3',
                },
              ],
            }),
          ),
        );
      if (url.endsWith('/f1'))
        return Promise.resolve(
          new Response(png, { headers: { 'content-type': 'image/png; x=1' } }),
        );
      if (url.endsWith('/f2'))
        return Promise.resolve(
          new Response('<html>', { headers: { 'content-type': 'text/html' } }),
        );
      return Promise.resolve(
        new Response(Buffer.alloc(20), { headers: { 'content-type': 'image/jpeg' } }),
      );
    }) as unknown as typeof fetch;
    const e = new HttpProctoringEvidence({ baseUrl: 'https://pr.test', token, fetch: fake }, 10);
    const frames = await e.flaggedFrames('T', 'S', 10);
    expect(frames).toEqual([
      {
        label: 'second face',
        capturedAt: '2026-11-06T09:00:00Z',
        contentType: 'image/png',
        data: png,
      },
    ]);
    const missing = new HttpProctoringEvidence({
      baseUrl: 'https://pr.test',
      token,
      fetch: (() =>
        Promise.resolve(new Response('{}', { status: 404 }))) as unknown as typeof fetch,
    });
    expect(await missing.flaggedFrames('T', 'S', 10)).toEqual([]);
    const forbidden = new HttpProctoringEvidence({
      baseUrl: 'https://pr.test',
      token,
      fetch: (() =>
        Promise.resolve(new Response('{}', { status: 403 }))) as unknown as typeof fetch,
    });
    await expect(forbidden.flaggedFrames('T', 'S', 10)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('ChromiumPdfRenderer', () => {
  const hasChromium = (() => {
    try {
      return existsSync(chromium.executablePath());
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasChromium)(
    'prints the report to a real PDF, without running scripts or fetching anything',
    async () => {
      const renderer = new ChromiumPdfRenderer(
        () => chromium.launch({ headless: true }),
        2,
        10_000,
      );
      try {
        const html = renderCandidateReport({
          tenantName: 'Corp',
          candidateName: 'Ada',
          facts: facts({
            skills: [{ skillId: 's', score: 4, confidence: 1 }],
            submittedAt: new Date(),
          }),
          sections: defaultSections(),
          skillNames: new Map([['s', 'Java']]),
          evidence: [],
          generatedAt: new Date(),
        });
        const started = Date.now();
        const [a, b, c] = await Promise.all([
          renderer.render(html),
          renderer.render(html),
          renderer.render(
            `${html}<img src="https://example.com/x.png"><script>document.title='ran'</script>`,
          ),
        ]);
        expect(Date.now() - started).toBeLessThan(10_000);
        for (const pdf of [a, b, c]) expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        expect((a as Buffer).length).toBeGreaterThan(1000);
      } finally {
        await renderer.close();
      }
    },
    60_000,
  );

  it('a failed launch is retried on the next render', async () => {
    let launches = 0;
    const renderer = new ChromiumPdfRenderer(() => {
      launches += 1;
      return Promise.reject(new Error('no browser'));
    }, 1);
    await expect(renderer.render('<p>x</p>')).rejects.toThrow('no browser');
    await expect(renderer.render('<p>x</p>')).rejects.toThrow('no browser');
    expect(launches).toBe(2);
    await renderer.close();
  });
});

describe('config', () => {
  const base = {
    ATLAS_DATABASE_URL: 'postgres://u:p@localhost:5432/atlas',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas',
    ATLAS_AUTH_SHARED_SECRET: 'x'.repeat(32),
    ATLAS_REPORT_PUBLIC_URL: 'https://reports.atlas.test',
    ATLAS_REPORT_LINK_KEY: Buffer.alloc(32, 2).toString('base64'),
    ATLAS_IDENTITY_TOKEN_URL: 'https://id.atlas.test/token',
    ATLAS_REPORT_CLIENT_ID: 'report-svc',
    ATLAS_REPORT_CLIENT_SECRET: 's',
    ATLAS_PROFILE_SVC_URL: 'http://profile:8084',
    ATLAS_TAXONOMY_SVC_URL: 'http://taxonomy:8083',
    ATLAS_PROCTORING_SVC_URL: 'http://proctoring:8090',
  };
  it('defaults to local storage on 8094', () => {
    expect(loadReportSvcConfig(base)).toMatchObject({
      ATLAS_REPORT_PORT: 8094,
      ATLAS_REPORT_STORAGE: 'fs',
      ATLAS_REPORT_RETENTION_DAYS: 30,
    });
  });
  it('refuses incomplete or unsafe settings', () => {
    expect(() => loadReportSvcConfig({ ...base, ATLAS_REPORT_STORAGE: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => loadReportSvcConfig({ ...base, ATLAS_REPORT_EVENT_SOURCE: 'kafka' })).toThrow(
      /KAFKA/,
    );
    expect(() => loadReportSvcConfig({ ...base, ATLAS_AUTH_SHARED_SECRET: undefined })).toThrow(
      /JWKS/,
    );
    expect(() => loadReportSvcConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /shared-secret|local disk|Trino|without events/,
    );
    expect(
      loadReportSvcConfig({
        ...base,
        NODE_ENV: 'production',
        ATLAS_AUTH_SHARED_SECRET: undefined,
        ATLAS_AUTH_JWKS_URL: 'https://id.atlas.test/jwks',
        ATLAS_REPORT_STORAGE: 's3',
        ATLAS_REPORT_S3_BUCKET: 'b',
        ATLAS_REPORT_S3_REGION: 'eu-west-1',
        ATLAS_TRINO_URL: 'https://trino.test',
        ATLAS_REPORT_EVENT_SOURCE: 'kafka',
        ATLAS_KAFKA_BROKERS: 'k:9092',
      }).ATLAS_KAFKA_BROKERS,
    ).toEqual(['k:9092']);
  });
});

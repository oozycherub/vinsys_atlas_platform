import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  FieldCipher,
  FixedClock,
  HttpWrappedKeySource,
  LocalKeyEncryption,
  TENANT_DEK_CONTEXT,
  TenantKeyCache,
  TenantKeysUnavailableError,
  type WrappedTenantKey,
} from '@atlas/platform';
import { loadProfileSvcConfig } from '../../src/config';
import { HttpSkillCatalog, StaticSkillCatalog } from '../../src/infrastructure/skill-catalog';
import { MemoryObjectStorage, S3ObjectStorage } from '../../src/infrastructure/storage';

const T1 = '0192f0c4-0000-7000-8000-0000000000a1';
const T2 = '0192f0c4-0000-7000-8000-0000000000a2';

describe('FieldCipher + TenantKeyCache', () => {
  const kek = new LocalKeyEncryption('dev', randomBytes(32));
  const store = new Map<string, WrappedTenantKey[]>();
  let fetches = 0;
  const clock = new FixedClock(new Date('2026-11-05T00:00:00Z'));
  const cache = new TenantKeyCache(
    { fetch: (t) => (fetches++, Promise.resolve(store.get(t) ?? [])) },
    kek,
    { clock },
  );
  const cipher = new FieldCipher(cache);

  async function rotate(tenant: string): Promise<void> {
    const list = store.get(tenant) ?? [];
    for (const k of list) k.active = false;
    list.unshift({
      version: list.length + 1,
      kmsKeyRef: kek.keyRef,
      wrappedKey: await kek.encrypt(randomBytes(32), TENANT_DEK_CONTEXT),
      active: true,
    });
    store.set(tenant, list);
  }

  beforeAll(async () => {
    await rotate(T1);
    await rotate(T2);
  });

  it('round-trips, binds AAD, versions ciphertexts and caches keys for 15 minutes', async () => {
    const blob = await cipher.encrypt(T1, ['cand-1', 'pii'], 'Ada');
    expect(FieldCipher.keyVersion(blob)).toBe(1);
    expect((await cipher.decrypt(T1, ['cand-1', 'pii'], blob)).toString()).toBe('Ada');
    await expect(cipher.decrypt(T1, ['cand-2', 'pii'], blob)).rejects.toThrow();
    await expect(cipher.decrypt(T2, ['cand-1', 'pii'], blob)).rejects.toThrow();
    await expect(cipher.decrypt(T1, ['cand-1', 'pii'], Buffer.from([9, 9, 9]))).rejects.toThrow(
      /format/,
    );
    expect(
      await cipher.decryptJson(T1, ['x'], await cipher.encryptJson(T1, ['x'], { a: 1 })),
    ).toEqual({ a: 1 });

    const before = fetches;
    await cipher.encrypt(T1, ['a'], 'x');
    expect(fetches).toBe(before);
    clock.advanceBy(15 * 60 * 1000);
    await cipher.encrypt(T1, ['a'], 'x');
    expect(fetches).toBe(before + 1);
  });

  it('decrypts old versions after rotation and keeps blind indexes stable and per tenant', async () => {
    const old = await cipher.encrypt(T1, ['c'], 'old');
    const bidx = await cipher.blindIndex(T1, 'email', 'a@b.co');
    await rotate(T1);
    cache.evict(T1);
    const fresh = await cipher.encrypt(T1, ['c'], 'new');
    expect(FieldCipher.keyVersion(fresh)).toBe(2);
    expect((await cipher.decrypt(T1, ['c'], old)).toString()).toBe('old');
    expect((await cipher.blindIndex(T1, 'email', 'a@b.co')).equals(bidx)).toBe(true);
    expect((await cipher.blindIndex(T2, 'email', 'a@b.co')).equals(bidx)).toBe(false);
    expect((await cipher.blindIndex(T1, 'phone', 'a@b.co')).equals(bidx)).toBe(false);
  });

  it('refuses keys wrapped by another KEK and tenants without keys', async () => {
    await expect(
      cipher.encrypt('0192f0c4-0000-7000-8000-0000000000ff', ['x'], 'y'),
    ).rejects.toBeInstanceOf(TenantKeysUnavailableError);
    const other = new TenantKeyCache(
      { fetch: () => Promise.resolve(store.get(T1) ?? []) },
      new LocalKeyEncryption('prod', randomBytes(32)),
    );
    await expect(other.active(T1)).rejects.toThrow(/wrapped by local:dev/);
  });
});

describe('HTTP adapters', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url ?? '';
      if (url.startsWith(`/v1/tenants/${T1}/data-keys`)) {
        res.end(
          JSON.stringify({
            tenant_id: T1,
            keys: [
              {
                dek_version: 2,
                kms_key_ref: 'local:dev',
                wrapped_key: Buffer.from('w2').toString('base64'),
                active: true,
              },
            ],
          }),
        );
      } else if (url.startsWith('/v1/tenants/')) {
        res.statusCode = 404;
        res.end('{}');
      } else if (url.startsWith('/v1/skills/active')) {
        res.end(
          JSON.stringify({
            skill_id: 'active',
            node_type: 'skill',
            deprecated_at: null,
            successor: null,
          }),
        );
      } else if (url.startsWith('/v1/skills/old')) {
        res.end(
          JSON.stringify({
            skill_id: 'old',
            node_type: 'skill',
            deprecated_at: '2026-01-01T00:00:00Z',
            successor: { skill_id: 'new' },
          }),
        );
      } else if (url.startsWith('/v1/skills/cluster')) {
        res.end(
          JSON.stringify({
            skill_id: 'cluster',
            node_type: 'cluster',
            deprecated_at: null,
            successor: null,
          }),
        );
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reads wrapped keys from tenant-svc', async () => {
    const source = new HttpWrappedKeySource({ baseUrl: base, token: () => Promise.resolve('t') });
    expect(await source.fetch(T1)).toEqual([
      { version: 2, kmsKeyRef: 'local:dev', wrappedKey: Buffer.from('w2'), active: true },
    ]);
    expect(await source.fetch(T2)).toEqual([]);
  });

  it('resolves skills through taxonomy-svc', async () => {
    const catalog = new HttpSkillCatalog({ baseUrl: base, token: () => Promise.resolve('t') });
    const out = await catalog.resolve(T1, ['active', 'old', 'cluster', 'missing']);
    expect(Object.fromEntries(out)).toEqual({
      active: 'active',
      old: 'new',
      cluster: null,
      missing: null,
    });
    const fixed = await new StaticSkillCatalog(new Set(['a']), new Map([['b', 'a']])).resolve(T1, [
      'a',
      'b',
      'c',
    ]);
    expect(Object.fromEntries(fixed)).toEqual({ a: 'a', b: 'a', c: null });
  });
});

describe('object storage', () => {
  it('presigns S3 uploads bound to type, length and SHA-256', async () => {
    const s3 = new S3Client({
      region: 'eu-central-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    const storage = new S3ObjectStorage(s3, 'atlas-resumes');
    const sha = createHash('sha256').update('hello').digest();
    const { url, headers } = await storage.presignUpload({
      key: `t/${T1}/resumes/x`,
      contentType: 'application/pdf',
      byteSize: 5,
      sha256: sha,
      expiresInSec: 900,
    });
    const signed = new URL(url);
    expect(signed.pathname).toContain(`/t/${T1}/resumes/x`);
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(signed.searchParams.get('X-Amz-SignedHeaders')).toContain('x-amz-checksum-sha256');
    expect(signed.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(headers['x-amz-checksum-sha256']).toBe(sha.toString('base64'));
  });

  it('deletes by key and by prefix, and maps a missing object to null', async () => {
    const mock = mockClient(S3Client);
    mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'a' }, { Key: 'b' }],
        IsTruncated: true,
        NextContinuationToken: 'n',
      })
      .resolvesOnce({ Contents: [{ Key: 'c' }] });
    mock.on(DeleteObjectsCommand).resolves({});
    mock.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
    const storage = new S3ObjectStorage(new S3Client({ region: 'eu-central-1' }), 'b');
    expect(await storage.deletePrefix(`t/${T1}/`)).toBe(3);
    expect(await storage.head('x')).toBeNull();
    expect(await storage.delete([])).toBe(0);
    mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'a' }] });
    await expect(storage.delete(['a'])).rejects.toThrow(/could not delete/);
    mock.restore();

    const memory = new MemoryObjectStorage();
    memory.put('t/1/a', Buffer.from('hello'));
    expect(await memory.head('t/1/a')).toEqual({ size: 5 });
    expect((await memory.readHead('t/1/a', 2)).toString()).toBe('he');
    expect(await memory.deletePrefix('t/1/')).toBe(1);
  });
});

describe('profile-svc config', () => {
  const base = {
    ATLAS_DATABASE_URL: 'postgres://atlas_app:pw@localhost:6432/atlas',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas-api',
    ATLAS_AUTH_JWKS_URL: 'https://id.atlas.test/.well-known/jwks.json',
    ATLAS_IDENTITY_TOKEN_URL: 'https://id.atlas.test/v1/oauth/token',
    ATLAS_PROFILE_CLIENT_ID: 'svc_profile',
    ATLAS_PROFILE_CLIENT_SECRET: 's',
    ATLAS_TENANT_SVC_URL: 'http://tenant-svc:8081',
    ATLAS_TAXONOMY_SVC_URL: 'http://taxonomy-svc:8083',
    ATLAS_PROFILE_LOCAL_KEK: randomBytes(32).toString('base64'),
  };
  const problems = (env: Record<string, string>): string[] => {
    try {
      loadProfileSvcConfig(env);
      return [];
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as ConfigError).problems;
    }
  };

  it('loads development defaults and refuses shortcuts in production', () => {
    expect(loadProfileSvcConfig(base)).toMatchObject({
      ATLAS_PROFILE_STORAGE: 'memory',
      ATLAS_PROFILE_RETENTION_DAYS: 730,
      ATLAS_PROFILE_ERASURE_CONSUMERS: [],
    });
    const prod = problems({ ...base, NODE_ENV: 'production' });
    for (const key of [
      'ATLAS_PROFILE_KEK_MODE',
      'ATLAS_PROFILE_STORAGE',
      'ATLAS_PROFILE_EVENT_SOURCE',
    ]) {
      expect(
        prod.some((p) => p.startsWith(key)),
        key,
      ).toBe(true);
    }
    expect(problems({ ...base, ATLAS_PROFILE_STORAGE: 's3' })[0]).toMatch(/S3_BUCKET/);
    expect(problems({ ...base, ATLAS_PROFILE_KEK_MODE: 'aws' })[0]).toMatch(/KMS_KEY_ID/);
    expect(
      loadProfileSvcConfig({
        ...base,
        ATLAS_PROFILE_ERASURE_CONSUMERS: 'matching-svc, parsing-svc',
      }).ATLAS_PROFILE_ERASURE_CONSUMERS,
    ).toEqual(['matching-svc', 'parsing-svc']);
  });
});

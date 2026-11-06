import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AnyOfVerifier,
  FixedClock,
  hashRequest,
  hashSecret,
  MemoryRateLimiter,
  openSecret,
  parseOutboxRecord,
  PoisonEventError,
  type Principal,
  randomToken,
  sealSecret,
  sha256,
  TooManyRequestsError,
  UnauthorizedError,
  verifySecret,
} from '../../src';

describe('secrets', () => {
  it('generates 256-bit url-safe tokens and stable hashes', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256(token).equals(sha256(token))).toBe(true);
    expect(sha256(token)).toHaveLength(32);
  });

  it('seals with AES-256-GCM bound to its purpose', () => {
    const kek = randomBytes(32);
    const sealed = sealSecret(kek, Buffer.from('private-jwk'), 'kid-1');
    expect(openSecret(kek, sealed, 'kid-1').toString()).toBe('private-jwk');
    expect(() => openSecret(kek, sealed, 'kid-2')).toThrow();
    expect(() => openSecret(randomBytes(32), sealed, 'kid-1')).toThrow();
    expect(() => sealSecret(randomBytes(16), Buffer.from('x'), 'a')).toThrow(/32 bytes/);
    expect(() => openSecret(kek, Buffer.from([9, 9]), 'kid-1')).toThrow(/format/);
  });

  it('hashes client secrets with argon2id and verifies in constant time', async () => {
    const phc = await hashSecret('s3cret');
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifySecret('s3cret', phc)).toBe(true);
    expect(await verifySecret('wrong', phc)).toBe(false);
    expect(await verifySecret('s3cret', 'not-a-phc')).toBe(false);
  });

  it('hashes requests independently of key order and locale', () => {
    expect(hashRequest('post', '/x', { b: 1, a: { d: 2, c: 3 } })).toBe(
      hashRequest('POST', '/x', { a: { c: 3, d: 2 }, b: 1 }),
    );
    // Code-unit order: uppercase sorts before lowercase regardless of the server's locale.
    expect(hashRequest('POST', '/x', { a: 1, B: 2 })).toBe(
      hashRequest('POST', '/x', { B: 2, a: 1 }),
    );
  });
});

describe('rate limiting', () => {
  it('allows `limit` hits per window, then reports Retry-After', async () => {
    const clock = new FixedClock(new Date('2026-11-01T00:00:00Z'));
    const limiter = new MemoryRateLimiter(clock);
    for (let i = 0; i < 3; i += 1) expect((await limiter.consume('k', 3, 60)).allowed).toBe(true);
    const denied = await limiter.consume('k', 3, 60);
    expect(denied).toEqual({ allowed: false, retryAfterSec: 60 });
    clock.advanceBy(45_000);
    expect((await limiter.consume('k', 3, 60)).retryAfterSec).toBe(15);
    clock.advanceBy(15_000);
    expect((await limiter.consume('k', 3, 60)).allowed).toBe(true);
    expect((await limiter.consume('other', 3, 60)).allowed).toBe(true);
  });

  it('maps to a 429 problem with a Retry-After header', () => {
    const error = new TooManyRequestsError('RATE_LIMITED', 'slow down', 12.2);
    expect(error.status).toBe(429);
    expect(error.headers).toEqual({ 'Retry-After': '13' });
  });
});

describe('AnyOfVerifier', () => {
  const ok: Principal = { subject: 's', tenantId: null, roles: ['service'], scopes: [] };
  const fails = { verify: () => Promise.reject(new UnauthorizedError('nope')) };
  const passes = { verify: () => Promise.resolve(ok) };

  it('returns the first success and rethrows the last failure', async () => {
    await expect(new AnyOfVerifier([fails, passes]).verify('t')).resolves.toBe(ok);
    await expect(new AnyOfVerifier([fails, fails]).verify('t')).rejects.toThrow('nope');
    expect(() => new AnyOfVerifier([])).toThrow();
  });
});

describe('parseOutboxRecord', () => {
  const eventId = '0192f0c4-0000-7000-8000-0000000000aa';
  const tenantId = '0192f0c4-0000-7000-8000-0000000000bb';

  it('reads the Debezium outbox router layout', () => {
    const event = parseOutboxRecord({
      topic: 'tenant.tenant.activated.v1',
      key: Buffer.from(tenantId),
      value: JSON.stringify(JSON.stringify({ tenant_id: tenantId })),
      headers: { event_id: Buffer.from(eventId), tenant_id: tenantId },
    });
    expect(event).toEqual({
      eventId,
      topic: 'tenant.tenant.activated.v1',
      tenantId,
      aggregateId: tenantId,
      payload: { tenant_id: tenantId },
    });
  });

  it('rejects records it cannot trust as poison', () => {
    const base = { topic: 't.t.t.v1', key: tenantId, value: '{}', headers: { event_id: eventId } };
    expect(() => parseOutboxRecord({ ...base, headers: {} })).toThrow(PoisonEventError);
    expect(() => parseOutboxRecord({ ...base, key: 'nope' })).toThrow(/key/);
    expect(() => parseOutboxRecord({ ...base, value: 'not json' })).toThrow(/JSON/);
    expect(() => parseOutboxRecord({ ...base, value: null })).toThrow(/empty/);
    expect(() =>
      parseOutboxRecord({ ...base, headers: { event_id: eventId, tenant_id: 'x' } }),
    ).toThrow(/tenant_id/);
  });
});

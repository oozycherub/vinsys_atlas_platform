import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import {
  assertIdempotencyKey,
  canAccessTenant,
  ConfigError,
  configFields,
  createLogger,
  DomainRuleError,
  FixedClock,
  isUuid,
  JwtVerifier,
  loadConfig,
  newId,
  parseInput,
  ProblemDetailsFilter,
  requestContext,
  UnauthorizedError,
} from '@atlas/platform';
import { MemoryLogStream, signTestToken, TEST_AUTH } from '@atlas/platform/testing';

describe('newId (UUIDv7)', () => {
  it('produces RFC 9562 version-7 UUIDs', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is time-ordered', () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(a < b).toBe(true);
  });
});

describe('loadConfig', () => {
  const schema = z.object({ PORT: configFields.port, SECRET: z.string().min(10) });

  it('parses and coerces valid env', () => {
    expect(loadConfig(schema, { PORT: '8080', SECRET: 'abcdefghijk' })).toEqual({
      PORT: 8080,
      SECRET: 'abcdefghijk',
    });
  });

  it('reports every problem without echoing values', () => {
    try {
      loadConfig(schema, { PORT: '99999', SECRET: 'short-secret'.slice(0, 5) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect((error as ConfigError).problems).toHaveLength(2);
      expect(message).not.toContain('short');
    }
  });
});

describe('JwtVerifier', () => {
  const verifier = new JwtVerifier({ ...TEST_AUTH });

  it('maps verified claims to a principal', async () => {
    const tid = newId();
    const token = await signTestToken({ sub: 'user-1', tid, roles: ['tenant_admin'] });
    await expect(verifier.verify(token)).resolves.toEqual({
      subject: 'user-1',
      tenantId: tid,
      roles: ['tenant_admin'],
      scopes: [],
    });
  });

  it('rejects a token signed with another key', async () => {
    const token = await signTestToken(
      { sub: 'x', roles: ['super_admin'] },
      'another-secret-that-is-long-enough-123',
    );
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects expired tokens', async () => {
    const token = await signTestToken({ sub: 'x', roles: ['super_admin'], expiresIn: '-2m' });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects unknown roles', async () => {
    const token = await signTestToken({ sub: 'x', roles: ['root' as never] });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses to start with a weak shared secret', () => {
    expect(() => new JwtVerifier({ issuer: 'i', audience: 'a', sharedSecret: 'short' })).toThrow();
  });
});

describe('canAccessTenant', () => {
  const tid = newId();
  it('allows members and platform staff only', () => {
    expect(
      canAccessTenant({ subject: 's', tenantId: tid, roles: ['tenant_admin'], scopes: [] }, tid),
    ).toBe(true);
    expect(
      canAccessTenant(
        { subject: 's', tenantId: newId(), roles: ['tenant_admin'], scopes: [] },
        tid,
      ),
    ).toBe(false);
    expect(
      canAccessTenant({ subject: 's', tenantId: null, roles: ['super_admin'], scopes: [] }, tid),
    ).toBe(true);
  });
});

describe('ProblemDetailsFilter.toProblem', () => {
  const filter = new ProblemDetailsFilter(
    createLogger({ service: 'test', destination: new MemoryLogStream() }),
  );

  it('renders AppErrors with their stable code', () => {
    const problem = requestContext.run({ requestId: 'req-12345678' }, () =>
      filter.toProblem(new DomainRuleError('TENANT_NOT_ACTIVE', 'Tenant is suspended.'), '/v1/x'),
    );
    expect(problem).toMatchObject({
      type: 'https://errors.atlas.dev/tenant-not-active',
      status: 422,
      code: 'TENANT_NOT_ACTIVE',
      detail: 'Tenant is suspended.',
      instance: '/v1/x',
      request_id: 'req-12345678',
    });
  });

  it('hides internals of unexpected errors', () => {
    const problem = filter.toProblem(new Error('db password is hunter2'), '/v1/x');
    expect(problem.status).toBe(500);
    expect(JSON.stringify(problem)).not.toContain('hunter2');
  });

  it('maps framework 404s', () => {
    expect(filter.toProblem(new HttpException('Cannot GET /nope', 404), '/nope').code).toBe(
      'ROUTE_NOT_FOUND',
    );
  });
});

describe('parseInput', () => {
  it('raises a 400 with field paths', () => {
    expect(() => parseInput(z.object({ slug: z.string().min(3) }), { slug: 'a' })).toThrow(
      expect.objectContaining({
        status: 400,
        issues: [expect.objectContaining({ path: 'body.slug' })],
      }),
    );
  });
});

describe('assertIdempotencyKey', () => {
  it('requires a well-formed key', () => {
    expect(() => assertIdempotencyKey(undefined)).toThrow(/required/);
    expect(() => assertIdempotencyKey('bad key!')).toThrow(/8–128/);
    expect(assertIdempotencyKey('2c7b1f0e-key')).toBe('2c7b1f0e-key');
  });
});

describe('logger', () => {
  it('redacts PII and credentials and adds request context', () => {
    const stream = new MemoryLogStream();
    const logger = createLogger({ service: 'test', destination: stream });
    requestContext.run({ requestId: 'req-abcdefgh', tenantId: 't-1' }, () => {
      logger.info(
        { candidate: { email: 'a@b.com', phone: '+1555' }, headers: { authorization: 'Bearer x' } },
        'hi',
      );
    });
    const line = stream.lines[0]!;
    expect(JSON.stringify(line)).not.toMatch(/a@b\.com|\+1555|Bearer x/);
    expect(line).toMatchObject({
      service: 'test',
      request_id: 'req-abcdefgh',
      tenant_id: 't-1',
      level: 'info',
    });
  });
});

describe('FixedClock', () => {
  it('only moves when advanced', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    clock.advanceBy(1000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });
});

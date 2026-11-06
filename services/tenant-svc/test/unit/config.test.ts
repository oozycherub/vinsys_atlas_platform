import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@atlas/platform';
import { loadTenantSvcConfig } from '../../src/config';

const base = {
  ATLAS_DATABASE_URL: 'postgres://atlas_app:pw@localhost:6432/atlas',
  ATLAS_AUTH_ISSUER: 'https://identity.atlas.test',
  ATLAS_AUTH_AUDIENCE: 'atlas-api',
  ATLAS_AUTH_SHARED_SECRET: 'x'.repeat(40),
  ATLAS_TENANT_CELLS: '{"eu-central-1":{"pooled":["eu-pool-01"]}}',
  ATLAS_TENANT_LOCAL_KEK: randomBytes(32).toString('base64'),
};

function problems(env: Record<string, string>): string[] {
  try {
    loadTenantSvcConfig(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

describe('tenant-svc config', () => {
  it('loads a valid development config with defaults', () => {
    const config = loadTenantSvcConfig(base);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      ATLAS_TENANT_PORT: 8081,
      ATLAS_TENANT_PURGE_GRACE_DAYS: 30,
      ATLAS_TENANT_CELLS: { 'eu-central-1': { pooled: ['eu-pool-01'] } },
    });
  });

  it('rejects malformed cell topology', () => {
    expect(problems({ ...base, ATLAS_TENANT_CELLS: 'not json' })).toEqual([
      'ATLAS_TENANT_CELLS: must be valid JSON',
    ]);
    expect(
      problems({ ...base, ATLAS_TENANT_CELLS: '{"eu-central-1":{"pooled":[]}}' }),
    ).toHaveLength(1);
  });

  it('requires a 32-byte local KEK', () => {
    expect(problems({ ...base, ATLAS_TENANT_LOCAL_KEK: 'c2hvcnQ=' })[0]).toMatch(
      /ATLAS_TENANT_LOCAL_KEK/,
    );
  });

  it('refuses development shortcuts in production', () => {
    const found = problems({ ...base, NODE_ENV: 'production' });
    expect(found.some((p) => p.startsWith('ATLAS_AUTH_SHARED_SECRET'))).toBe(true);
    expect(found.some((p) => p.startsWith('ATLAS_TENANT_KMS_MODE'))).toBe(true);
  });

  it('accepts AWS KMS mode with a key id, and requires one', () => {
    const aws = { ...base, ATLAS_TENANT_KMS_MODE: 'aws' };
    expect(problems(aws)[0]).toMatch(/ATLAS_TENANT_KMS_KEY_ID/);
    expect(problems({ ...aws, ATLAS_TENANT_KMS_KEY_ID: 'alias/atlas-tenants' })).toEqual([]);
  });

  it('requires some token verification method', () => {
    const env: Record<string, string> = { ...base };
    delete env['ATLAS_AUTH_SHARED_SECRET'];
    expect(problems(env)[0]).toMatch(/ATLAS_AUTH_JWKS_URL/);
  });
});

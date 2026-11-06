import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@atlas/platform';
import { loadIdentitySvcConfig } from '../../src/config';

const base = {
  ATLAS_DATABASE_URL: 'postgres://atlas_app:pw@localhost:6432/atlas',
  ATLAS_AUTH_ISSUER: 'https://identity.atlas.test',
  ATLAS_AUTH_AUDIENCE: 'atlas-api',
  ATLAS_IDENTITY_APP_BASE_URL: 'https://{slug}.atlas.test',
  ATLAS_IDENTITY_LOCAL_KEK: randomBytes(32).toString('base64'),
};

function problems(env: Record<string, string>): string[] {
  try {
    loadIdentitySvcConfig(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

describe('identity-svc config', () => {
  it('loads a valid development config with defaults', () => {
    expect(loadIdentitySvcConfig(base)).toMatchObject({
      NODE_ENV: 'development',
      ATLAS_IDENTITY_PORT: 8082,
      ATLAS_IDENTITY_RATE_LIMITER: 'memory',
      ATLAS_IDENTITY_LINK_DELIVERY: 'log',
    });
  });

  it('requires {slug} in the app URL and a 32-byte KEK', () => {
    expect(problems({ ...base, ATLAS_IDENTITY_APP_BASE_URL: 'https://atlas.test' })[0]).toMatch(
      /APP_BASE_URL/,
    );
    expect(problems({ ...base, ATLAS_IDENTITY_LOCAL_KEK: 'c2hvcnQ=' })[0]).toMatch(/LOCAL_KEK/);
  });

  it('refuses every development shortcut in production', () => {
    const found = problems({
      ...base,
      NODE_ENV: 'production',
      ATLAS_AUTH_SHARED_SECRET: 'x'.repeat(40),
      ATLAS_IDENTITY_ALLOW_INSECURE_IDP: 'true',
    });
    for (const key of [
      'ATLAS_AUTH_SHARED_SECRET',
      'ATLAS_IDENTITY_KEK_MODE',
      'ATLAS_IDENTITY_RATE_LIMITER',
      'ATLAS_IDENTITY_LINK_DELIVERY',
      'ATLAS_IDENTITY_EVENT_SOURCE',
      'ATLAS_IDENTITY_ALLOW_INSECURE_IDP',
    ]) {
      expect(found.some((p) => p.startsWith(key))).toBe(true);
    }
  });

  it('requires the settings each production adapter needs', () => {
    const missing = (env: Record<string, string>) => problems({ ...base, ...env })[0];
    expect(missing({ ATLAS_IDENTITY_RATE_LIMITER: 'redis' })).toMatch(/ATLAS_REDIS_URL/);
    expect(missing({ ATLAS_IDENTITY_LINK_DELIVERY: 'notification' })).toMatch(
      /ATLAS_NOTIFICATION_URL/,
    );
    expect(missing({ ATLAS_IDENTITY_EVENT_SOURCE: 'kafka' })).toMatch(/ATLAS_KAFKA_BROKERS/);
    expect(missing({ ATLAS_IDENTITY_KEK_MODE: 'aws' })).toMatch(/ATLAS_IDENTITY_KMS_KEY_ID/);
    expect(missing({ ATLAS_IDENTITY_STAFF_OIDC_ISSUER: 'https://idp.test' })).toMatch(/together/);
  });

  it('accepts a complete production configuration', () => {
    const config = loadIdentitySvcConfig({
      ATLAS_DATABASE_URL: base.ATLAS_DATABASE_URL,
      ATLAS_AUTH_ISSUER: base.ATLAS_AUTH_ISSUER,
      ATLAS_AUTH_AUDIENCE: base.ATLAS_AUTH_AUDIENCE,
      ATLAS_IDENTITY_APP_BASE_URL: base.ATLAS_IDENTITY_APP_BASE_URL,
      NODE_ENV: 'production',
      ATLAS_IDENTITY_KEK_MODE: 'aws',
      ATLAS_IDENTITY_KMS_KEY_ID: 'alias/atlas-identity',
      ATLAS_IDENTITY_RATE_LIMITER: 'redis',
      ATLAS_REDIS_URL: 'rediss://redis:6380',
      ATLAS_IDENTITY_LINK_DELIVERY: 'notification',
      ATLAS_NOTIFICATION_URL: 'http://notification-svc:8093',
      ATLAS_IDENTITY_EVENT_SOURCE: 'kafka',
      ATLAS_KAFKA_BROKERS: 'k1:9092, k2:9092',
      ATLAS_IDENTITY_OAUTH_CLIENTS:
        '{"atlas-web":{"redirect_uris":["https://{slug}.atlas.app/auth/callback"]}}',
      ATLAS_IDENTITY_STAFF_OIDC_ISSUER: 'https://login.workforce.test',
      ATLAS_IDENTITY_STAFF_OIDC_CLIENT_ID: 'atlas',
      ATLAS_IDENTITY_STAFF_OIDC_CLIENT_SECRET: 's',
      ATLAS_IDENTITY_STAFF_ALLOWED_DOMAINS: 'Atlas.dev',
    });
    expect(config.ATLAS_KAFKA_BROKERS).toEqual(['k1:9092', 'k2:9092']);
    expect(config.ATLAS_IDENTITY_STAFF_ALLOWED_DOMAINS).toEqual(['atlas.dev']);
    expect(config.ATLAS_IDENTITY_OAUTH_CLIENTS['atlas-web']?.redirect_uris).toHaveLength(1);
  });
});

import { configFields, loadConfig } from '@atlas/platform';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ATLAS_GATEWAY_PORT: configFields.port.default(8080),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_GATEWAY_BASE_DOMAIN: z.string().min(3),
    ATLAS_GATEWAY_ROUTES: z.string().default('routes.yaml'),
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),
    ATLAS_TENANT_SVC_URL: z.string().url(),
    ATLAS_IDENTITY_TOKEN_URL: z.string().url(),
    ATLAS_GATEWAY_CLIENT_ID: z.string().min(1),
    ATLAS_GATEWAY_CLIENT_SECRET: z.string().min(1),
    ATLAS_REDIS_URL: z.string().url().optional(),
    ATLAS_GATEWAY_RPM_POOLED: z.coerce.number().int().positive().default(1200),
    ATLAS_GATEWAY_RPM_DEDICATED: z.coerce.number().int().positive().default(6000),
    ATLAS_GATEWAY_RPM_ANONYMOUS: z.coerce.number().int().positive().default(120),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string): void =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (!env.ATLAS_AUTH_JWKS_URL && !env.ATLAS_AUTH_SHARED_SECRET)
      issue(
        'ATLAS_AUTH_JWKS_URL',
        'set ATLAS_AUTH_JWKS_URL (or a shared secret outside production)',
      );
    if (env.NODE_ENV === 'production') {
      if (env.ATLAS_AUTH_SHARED_SECRET)
        issue('ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens are not allowed in production');
      if (!env.ATLAS_REDIS_URL)
        issue(
          'ATLAS_REDIS_URL',
          'per-tenant limits must be shared across replicas (Redis) in production',
        );
    }
  });

export type GatewayConfig = z.output<typeof schema>;

export function loadGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  return loadConfig(schema, env);
}

import { configFields, loadConfig } from '@atlas/platform';
import { z } from 'zod';

const cellTopology = z.record(
  z.string().regex(/^[a-z]{2}-[a-z]+-\d$/, 'region must look like eu-central-1'),
  z.object({ pooled: z.array(z.string().regex(/^[a-z0-9-]{3,63}$/)).min(1) }),
);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ATLAS_TENANT_PORT: configFields.port.default(8081),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),
    /** JSON, e.g. {"eu-central-1":{"pooled":["eu-pool-01","eu-pool-02"]}} */
    ATLAS_TENANT_CELLS: z
      .string()
      .transform((raw, ctx) => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
          return z.NEVER;
        }
      })
      .pipe(cellTopology),
    ATLAS_TENANT_KMS_MODE: z.enum(['local', 'aws']).default('local'),
    ATLAS_TENANT_KMS_KEY_NAME: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .default('dev'),
    /** aws mode: KMS key ARN or alias/<name>; region from AWS_REGION. */
    ATLAS_TENANT_KMS_KEY_ID: z
      .string()
      .regex(/^(arn:aws[a-z-]*:kms:|alias\/)/, 'must be a KMS key ARN or alias/<name>')
      .optional(),
    /** base64-encoded 32-byte key-encryption key for the local KMS adapter. */
    ATLAS_TENANT_LOCAL_KEK: z.string().optional(),
    ATLAS_TENANT_PURGE_GRACE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  })
  .superRefine((env, ctx) => {
    if (!env.ATLAS_AUTH_JWKS_URL && !env.ATLAS_AUTH_SHARED_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['ATLAS_AUTH_JWKS_URL'],
        message: 'set ATLAS_AUTH_JWKS_URL (or a shared secret outside production)',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (env.ATLAS_AUTH_SHARED_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['ATLAS_AUTH_SHARED_SECRET'],
          message: 'shared-secret tokens are not allowed in production',
        });
      }
      if (env.ATLAS_TENANT_KMS_MODE === 'local') {
        ctx.addIssue({
          code: 'custom',
          path: ['ATLAS_TENANT_KMS_MODE'],
          message: 'the local KMS adapter is not allowed in production',
        });
      }
    }
    if (env.ATLAS_TENANT_KMS_MODE === 'aws' && !env.ATLAS_TENANT_KMS_KEY_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['ATLAS_TENANT_KMS_KEY_ID'],
        message: 'required when ATLAS_TENANT_KMS_MODE=aws',
      });
    }
    if (env.ATLAS_TENANT_KMS_MODE === 'local') {
      const key = env.ATLAS_TENANT_LOCAL_KEK
        ? Buffer.from(env.ATLAS_TENANT_LOCAL_KEK, 'base64')
        : undefined;
      if (!key || key.length !== 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['ATLAS_TENANT_LOCAL_KEK'],
          message: 'must be a base64-encoded 32-byte key',
        });
      }
    }
  });

export type TenantSvcConfig = z.output<typeof schema>;

export function loadTenantSvcConfig(
  env: Record<string, string | undefined> = process.env,
): TenantSvcConfig {
  return loadConfig(schema, env);
}

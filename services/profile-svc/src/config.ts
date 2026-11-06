import { configFields, loadConfig } from '@atlas/platform';
import { z } from 'zod';

const csv = z.string().transform((raw) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ATLAS_PROFILE_PORT: configFields.port.default(8084),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),

    /** Service credentials at identity-svc (scopes tenant-keys:read, plus taxonomy reads). */
    ATLAS_IDENTITY_TOKEN_URL: z.string().url(),
    ATLAS_PROFILE_CLIENT_ID: z.string().min(1),
    ATLAS_PROFILE_CLIENT_SECRET: z.string().min(1),
    ATLAS_TENANT_SVC_URL: z.string().url(),
    ATLAS_TAXONOMY_SVC_URL: z.string().url(),

    /** Must be the same KEK tenant-svc wraps DEKs with (`local` dev KEK or the KMS key). */
    ATLAS_PROFILE_KEK_MODE: z.enum(['local', 'aws']).default('local'),
    ATLAS_PROFILE_KEK_NAME: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .default('dev'),
    ATLAS_PROFILE_LOCAL_KEK: z.string().optional(),
    ATLAS_PROFILE_KMS_KEY_ID: z
      .string()
      .regex(/^(arn:aws[a-z-]*:kms:|alias\/)/)
      .optional(),

    ATLAS_PROFILE_STORAGE: z.enum(['memory', 's3']).default('memory'),
    ATLAS_PROFILE_S3_BUCKET: z.string().min(3).optional(),
    /** MinIO / LocalStack endpoint; omit for AWS. */
    ATLAS_PROFILE_S3_ENDPOINT: z.string().url().optional(),

    ATLAS_PROFILE_ERASURE_CONSUMERS: csv.default(''),
    ATLAS_PROFILE_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(730),
    ATLAS_PROFILE_EVENT_SOURCE: z.enum(['none', 'kafka']).default('none'),
    ATLAS_KAFKA_BROKERS: csv.optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string): void =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (!env.ATLAS_AUTH_JWKS_URL && !env.ATLAS_AUTH_SHARED_SECRET) {
      issue(
        'ATLAS_AUTH_JWKS_URL',
        'set ATLAS_AUTH_JWKS_URL (or a shared secret outside production)',
      );
    }
    if (env.ATLAS_PROFILE_KEK_MODE === 'aws' && !env.ATLAS_PROFILE_KMS_KEY_ID) {
      issue('ATLAS_PROFILE_KMS_KEY_ID', 'required when ATLAS_PROFILE_KEK_MODE=aws');
    }
    if (env.ATLAS_PROFILE_KEK_MODE === 'local') {
      const key = env.ATLAS_PROFILE_LOCAL_KEK
        ? Buffer.from(env.ATLAS_PROFILE_LOCAL_KEK, 'base64')
        : undefined;
      if (key?.length !== 32)
        issue('ATLAS_PROFILE_LOCAL_KEK', 'must be a base64-encoded 32-byte key');
    }
    if (env.ATLAS_PROFILE_STORAGE === 's3' && !env.ATLAS_PROFILE_S3_BUCKET) {
      issue('ATLAS_PROFILE_S3_BUCKET', 'required when ATLAS_PROFILE_STORAGE=s3');
    }
    if (env.ATLAS_PROFILE_EVENT_SOURCE === 'kafka' && !env.ATLAS_KAFKA_BROKERS?.length) {
      issue('ATLAS_KAFKA_BROKERS', 'required when ATLAS_PROFILE_EVENT_SOURCE=kafka');
    }
    if (env.NODE_ENV === 'production') {
      const refuse: [boolean, string, string][] = [
        [Boolean(env.ATLAS_AUTH_SHARED_SECRET), 'ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens'],
        [env.ATLAS_PROFILE_KEK_MODE === 'local', 'ATLAS_PROFILE_KEK_MODE', 'the local KEK'],
        [
          env.ATLAS_PROFILE_STORAGE === 'memory',
          'ATLAS_PROFILE_STORAGE',
          'in-memory document storage',
        ],
        [
          env.ATLAS_PROFILE_EVENT_SOURCE === 'none',
          'ATLAS_PROFILE_EVENT_SOURCE',
          'running without events',
        ],
      ];
      for (const [bad, path, what] of refuse)
        if (bad) issue(path, `${what} are not allowed in production`);
    }
  });

export type ProfileSvcConfig = z.output<typeof schema>;

export function loadProfileSvcConfig(
  env: Record<string, string | undefined> = process.env,
): ProfileSvcConfig {
  return loadConfig(schema, env);
}

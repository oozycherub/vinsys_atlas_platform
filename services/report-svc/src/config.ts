import { configFields, loadConfig } from '@atlas/platform';
import { z } from 'zod';

const csv = z.string().transform((raw) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, '32 bytes, base64-encoded');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ATLAS_REPORT_PORT: configFields.port.default(8094),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),

    /** Public URL of report-svc behind the gateway (signed links point here). */
    ATLAS_REPORT_PUBLIC_URL: z.string().url(),
    ATLAS_REPORT_LINK_KEY: key32,
    ATLAS_REPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

    ATLAS_REPORT_STORAGE: z.enum(['s3', 'fs']).default('fs'),
    ATLAS_REPORT_FS_ROOT: z.string().default('./var/reports'),
    ATLAS_REPORT_S3_BUCKET: z.string().optional(),
    ATLAS_REPORT_S3_REGION: z.string().optional(),
    ATLAS_REPORT_S3_ENDPOINT: z.string().url().optional(),
    ATLAS_REPORT_S3_KMS_KEY_ID: z.string().optional(),

    ATLAS_CHROMIUM_PATH: z.string().optional(),
    ATLAS_PDF_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

    ATLAS_TRINO_URL: z.string().url().optional(),
    ATLAS_TRINO_CATALOG: z.string().default('lakehouse'),

    ATLAS_IDENTITY_TOKEN_URL: z.string().url(),
    ATLAS_REPORT_CLIENT_ID: z.string().min(1),
    ATLAS_REPORT_CLIENT_SECRET: z.string().min(1),
    ATLAS_PROFILE_SVC_URL: z.string().url(),
    ATLAS_TAXONOMY_SVC_URL: z.string().url(),
    ATLAS_PROCTORING_SVC_URL: z.string().url(),

    ATLAS_REPORT_EVENT_SOURCE: z.enum(['none', 'kafka']).default('none'),
    ATLAS_KAFKA_BROKERS: csv.optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string): void =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (!env.ATLAS_AUTH_JWKS_URL && !env.ATLAS_AUTH_SHARED_SECRET)
      issue(
        'ATLAS_AUTH_JWKS_URL',
        'set ATLAS_AUTH_JWKS_URL (or a shared secret outside production)',
      );
    if (
      env.ATLAS_REPORT_STORAGE === 's3' &&
      (!env.ATLAS_REPORT_S3_BUCKET || !env.ATLAS_REPORT_S3_REGION)
    )
      issue(
        'ATLAS_REPORT_S3_BUCKET',
        'bucket and region are required when ATLAS_REPORT_STORAGE=s3',
      );
    if (env.ATLAS_REPORT_EVENT_SOURCE === 'kafka' && !env.ATLAS_KAFKA_BROKERS?.length)
      issue('ATLAS_KAFKA_BROKERS', 'required when ATLAS_REPORT_EVENT_SOURCE=kafka');
    if (env.NODE_ENV === 'production') {
      if (env.ATLAS_AUTH_SHARED_SECRET)
        issue('ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens are not allowed in production');
      if (env.ATLAS_REPORT_STORAGE === 'fs')
        issue('ATLAS_REPORT_STORAGE', 'local disk is not allowed in production');
      if (!env.ATLAS_TRINO_URL)
        issue('ATLAS_TRINO_URL', 'the report gallery needs Trino in production');
      if (env.ATLAS_REPORT_EVENT_SOURCE === 'none')
        issue('ATLAS_REPORT_EVENT_SOURCE', 'running without events is not allowed in production');
    }
  });

export type ReportSvcConfig = z.output<typeof schema>;

export function loadReportSvcConfig(
  env: Record<string, string | undefined> = process.env,
): ReportSvcConfig {
  return loadConfig(schema, env);
}

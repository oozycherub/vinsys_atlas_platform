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
    ATLAS_NOTIFICATION_PORT: configFields.port.default(8093),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),

    /** `ses`, `sendgrid`, or `log` (development: nothing leaves the process). */
    ATLAS_EMAIL_PROVIDER: z.enum(['ses', 'sendgrid', 'log']).default('log'),
    ATLAS_SES_REGION: z.string().optional(),
    ATLAS_SES_CONFIGURATION_SET: z.string().optional(),
    ATLAS_SENDGRID_API_KEY: z.string().optional(),
    ATLAS_EMAIL_DEFAULT_FROM: z.string().min(3).default('Atlas <no-reply@mail.atlas.example>'),
    ATLAS_EMAIL_SPF_INCLUDE: z.string().min(3).default('spf.mail.atlas.example'),
    ATLAS_EMAIL_DKIM_TARGET: z.string().min(3).default('dkim.mail.atlas.example'),
    /** 32 bytes, base64: seals webhook secrets. */
    ATLAS_NOTIFICATION_SECRET_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, '32 bytes, base64-encoded'),

    ATLAS_NOTIFICATION_EVENT_SOURCE: z.enum(['none', 'kafka']).default('none'),
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
    if (env.ATLAS_EMAIL_PROVIDER === 'ses' && !env.ATLAS_SES_REGION)
      issue('ATLAS_SES_REGION', 'required when ATLAS_EMAIL_PROVIDER=ses');
    if (env.ATLAS_EMAIL_PROVIDER === 'sendgrid' && !env.ATLAS_SENDGRID_API_KEY)
      issue('ATLAS_SENDGRID_API_KEY', 'required when ATLAS_EMAIL_PROVIDER=sendgrid');
    if (env.ATLAS_NOTIFICATION_EVENT_SOURCE === 'kafka' && !env.ATLAS_KAFKA_BROKERS?.length)
      issue('ATLAS_KAFKA_BROKERS', 'required when ATLAS_NOTIFICATION_EVENT_SOURCE=kafka');
    if (env.NODE_ENV === 'production') {
      if (env.ATLAS_AUTH_SHARED_SECRET)
        issue('ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens are not allowed in production');
      if (env.ATLAS_EMAIL_PROVIDER === 'log')
        issue('ATLAS_EMAIL_PROVIDER', 'the log provider is not allowed in production');
      if (env.ATLAS_NOTIFICATION_EVENT_SOURCE === 'none')
        issue(
          'ATLAS_NOTIFICATION_EVENT_SOURCE',
          'running without events is not allowed in production',
        );
    }
  });

export type NotificationSvcConfig = z.output<typeof schema>;

export function loadNotificationSvcConfig(
  env: Record<string, string | undefined> = process.env,
): NotificationSvcConfig {
  return loadConfig(schema, env);
}

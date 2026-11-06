import { configFields, loadConfig } from '@atlas/platform';
import { z } from 'zod';

const json = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);

const csv = z.string().transform((raw) =>
  raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** {"atlas-web":{"redirect_uris":["https://{slug}.atlas.app/auth/callback"]}} */
const oauthClients = z.record(
  z.string().regex(/^[a-z0-9-]{3,60}$/),
  z.object({ redirect_uris: z.array(z.string().min(8).max(500)).min(1) }).strict(),
);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ATLAS_IDENTITY_PORT: configFields.port.default(8082),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    /** This service's public URL; the `iss` of every token it signs. */
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    /** Development only: HS256 staff tokens (same secret as other services' dev config). */
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),
    /** Where links point, e.g. https://{slug}.atlas.app */
    ATLAS_IDENTITY_APP_BASE_URL: z
      .string()
      .url()
      .refine((v) => v.includes('{slug}'), 'must contain {slug}'),

    ATLAS_IDENTITY_KEK_MODE: z.enum(['local', 'aws']).default('local'),
    ATLAS_IDENTITY_KEK_NAME: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .default('dev'),
    /** base64-encoded 32-byte key (local mode). */
    ATLAS_IDENTITY_LOCAL_KEK: z.string().optional(),
    /** aws mode: KMS key ARN or alias/<name>; region from AWS_REGION. */
    ATLAS_IDENTITY_KMS_KEY_ID: z
      .string()
      .regex(/^(arn:aws[a-z-]*:kms:|alias\/)/, 'must be a KMS key ARN or alias/<name>')
      .optional(),

    ATLAS_IDENTITY_RATE_LIMITER: z.enum(['memory', 'redis']).default('memory'),
    ATLAS_REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\//, 'must be redis:// or rediss://')
      .optional(),

    ATLAS_IDENTITY_LINK_DELIVERY: z.enum(['log', 'notification']).default('log'),
    ATLAS_NOTIFICATION_URL: z.string().url().optional(),

    ATLAS_IDENTITY_EVENT_SOURCE: z.enum(['none', 'kafka']).default('none'),
    /** Comma-separated host:port list. */
    ATLAS_KAFKA_BROKERS: csv.optional(),

    ATLAS_IDENTITY_OAUTH_CLIENTS: json(oauthClients).default('{}'),

    ATLAS_IDENTITY_STAFF_OIDC_ISSUER: z.string().url().optional(),
    ATLAS_IDENTITY_STAFF_OIDC_CLIENT_ID: z.string().min(1).optional(),
    ATLAS_IDENTITY_STAFF_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    /** Comma-separated email domains the workforce IdP may sign in. */
    ATLAS_IDENTITY_STAFF_ALLOWED_DOMAINS: csv.optional(),
    /** Created as an active staff account on startup if missing (first super_admin). */
    ATLAS_IDENTITY_STAFF_BOOTSTRAP_EMAIL: z.string().email().optional(),

    /** Development only: IdP URLs may be http or localhost. */
    ATLAS_IDENTITY_ALLOW_INSECURE_IDP: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string): void =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const staff = [
      env.ATLAS_IDENTITY_STAFF_OIDC_ISSUER,
      env.ATLAS_IDENTITY_STAFF_OIDC_CLIENT_ID,
      env.ATLAS_IDENTITY_STAFF_OIDC_CLIENT_SECRET,
      env.ATLAS_IDENTITY_STAFF_ALLOWED_DOMAINS,
    ];
    if (staff.some(Boolean) && !staff.every(Boolean)) {
      issue(
        'ATLAS_IDENTITY_STAFF_OIDC_ISSUER',
        'set issuer, client id, client secret and allowed domains together',
      );
    }
    if (env.ATLAS_IDENTITY_KEK_MODE === 'aws' && !env.ATLAS_IDENTITY_KMS_KEY_ID) {
      issue('ATLAS_IDENTITY_KMS_KEY_ID', 'required when ATLAS_IDENTITY_KEK_MODE=aws');
    }
    if (env.ATLAS_IDENTITY_KEK_MODE === 'local') {
      const key = env.ATLAS_IDENTITY_LOCAL_KEK
        ? Buffer.from(env.ATLAS_IDENTITY_LOCAL_KEK, 'base64')
        : undefined;
      if (!key || key.length !== 32) {
        issue('ATLAS_IDENTITY_LOCAL_KEK', 'must be a base64-encoded 32-byte key');
      }
    }
    if (env.ATLAS_IDENTITY_RATE_LIMITER === 'redis' && !env.ATLAS_REDIS_URL) {
      issue('ATLAS_REDIS_URL', 'required when ATLAS_IDENTITY_RATE_LIMITER=redis');
    }
    if (env.ATLAS_IDENTITY_LINK_DELIVERY === 'notification' && !env.ATLAS_NOTIFICATION_URL) {
      issue('ATLAS_NOTIFICATION_URL', 'required when ATLAS_IDENTITY_LINK_DELIVERY=notification');
    }
    if (env.ATLAS_IDENTITY_EVENT_SOURCE === 'kafka' && !env.ATLAS_KAFKA_BROKERS?.length) {
      issue('ATLAS_KAFKA_BROKERS', 'required when ATLAS_IDENTITY_EVENT_SOURCE=kafka');
    }
    if (env.NODE_ENV === 'production') {
      const refuse: [boolean, string, string][] = [
        [Boolean(env.ATLAS_AUTH_SHARED_SECRET), 'ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens'],
        [env.ATLAS_IDENTITY_KEK_MODE === 'local', 'ATLAS_IDENTITY_KEK_MODE', 'the local KEK'],
        [
          env.ATLAS_IDENTITY_RATE_LIMITER === 'memory',
          'ATLAS_IDENTITY_RATE_LIMITER',
          'per-replica rate limits',
        ],
        [
          env.ATLAS_IDENTITY_LINK_DELIVERY === 'log',
          'ATLAS_IDENTITY_LINK_DELIVERY',
          'logging login links',
        ],
        [
          env.ATLAS_IDENTITY_EVENT_SOURCE === 'none',
          'ATLAS_IDENTITY_EVENT_SOURCE',
          'running without tenant events',
        ],
        [
          env.ATLAS_IDENTITY_ALLOW_INSECURE_IDP,
          'ATLAS_IDENTITY_ALLOW_INSECURE_IDP',
          'insecure IdP URLs',
        ],
      ];
      for (const [bad, path, what] of refuse)
        if (bad) issue(path, `${what} are not allowed in production`);
    }
  });

export type IdentitySvcConfig = z.output<typeof schema>;

export function loadIdentitySvcConfig(
  env: Record<string, string | undefined> = process.env,
): IdentitySvcConfig {
  return loadConfig(schema, env);
}

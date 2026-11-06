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
    ATLAS_ASSESSMENT_PORT: configFields.port.default(8088),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),
    /** Service credentials (scope pii:read) for open-link candidates at profile-svc. */
    ATLAS_IDENTITY_TOKEN_URL: z.string().url(),
    ATLAS_ASSESSMENT_CLIENT_ID: z.string().min(1),
    ATLAS_ASSESSMENT_CLIENT_SECRET: z.string().min(1),
    ATLAS_PROFILE_SVC_URL: z.string().url(),
    /** sandbox-svc (brick 9): coding runs, submissions and test-case verification. */
    ATLAS_SANDBOX_SVC_URL: z.string().url(),
    /** proctoring-svc (brick 10): starts proctoring after the candidate's pre-check. */
    ATLAS_PROCTORING_SVC_URL: z.string().url(),
    /** interview-svc (brick 11): starts AI interview questions. */
    ATLAS_INTERVIEW_SVC_URL: z.string().url(),
    ATLAS_ASSESSMENT_INVITE_BASE_URL: z.string().url().default('https://assess.atlas.example/t'),
    ATLAS_ASSESSMENT_SESSION_RPS: z.coerce.number().int().min(1).max(1000).default(20),
    /** Per-session rate limits need shared counters across replicas in production. */
    ATLAS_REDIS_URL: z.string().url().optional(),
    ATLAS_ASSESSMENT_EVENT_SOURCE: z.enum(['none', 'kafka']).default('none'),
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
    if (env.ATLAS_ASSESSMENT_EVENT_SOURCE === 'kafka' && !env.ATLAS_KAFKA_BROKERS?.length) {
      issue('ATLAS_KAFKA_BROKERS', 'required when ATLAS_ASSESSMENT_EVENT_SOURCE=kafka');
    }
    if (env.NODE_ENV === 'production') {
      const refuse: [boolean, string, string][] = [
        [Boolean(env.ATLAS_AUTH_SHARED_SECRET), 'ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens'],
        [
          env.ATLAS_ASSESSMENT_EVENT_SOURCE === 'none',
          'ATLAS_ASSESSMENT_EVENT_SOURCE',
          'running without events',
        ],
        [!env.ATLAS_REDIS_URL, 'ATLAS_REDIS_URL', 'per-replica rate limit counters'],
      ];
      for (const [bad, path, what] of refuse)
        if (bad) issue(path, `${what} are not allowed in production`);
    }
  });

export type AssessmentSvcConfig = z.output<typeof schema>;

export function loadAssessmentSvcConfig(
  env: Record<string, string | undefined> = process.env,
): AssessmentSvcConfig {
  return loadConfig(schema, env);
}

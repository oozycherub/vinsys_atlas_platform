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
    ATLAS_MATCHING_PORT: configFields.port.default(8087),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),

    /** Service credentials (scopes embeddings:create, embeddings:search, tenant-settings:read). */
    ATLAS_IDENTITY_TOKEN_URL: z.string().url(),
    ATLAS_MATCHING_CLIENT_ID: z.string().min(1),
    ATLAS_MATCHING_CLIENT_SECRET: z.string().min(1),
    ATLAS_TENANT_SVC_URL: z.string().url(),
    ATLAS_TAXONOMY_SVC_URL: z.string().url(),
    ATLAS_PARSING_SVC_URL: z.string().url(),
    ATLAS_LLM_GATEWAY_URL: z.string().url(),

    /** BM25: OpenSearch in production; Postgres full-text ranking for development. */
    ATLAS_MATCHING_LEXICAL: z.enum(['postgres', 'opensearch']).default('postgres'),
    ATLAS_OPENSEARCH_URL: z.string().url().optional(),
    ATLAS_MATCHING_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(600),
    ATLAS_MATCHING_EVENT_SOURCE: z.enum(['none', 'kafka']).default('none'),
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
    if (env.ATLAS_MATCHING_LEXICAL === 'opensearch' && !env.ATLAS_OPENSEARCH_URL) {
      issue('ATLAS_OPENSEARCH_URL', 'required when ATLAS_MATCHING_LEXICAL=opensearch');
    }
    if (env.ATLAS_MATCHING_EVENT_SOURCE === 'kafka' && !env.ATLAS_KAFKA_BROKERS?.length) {
      issue('ATLAS_KAFKA_BROKERS', 'required when ATLAS_MATCHING_EVENT_SOURCE=kafka');
    }
    if (env.NODE_ENV === 'production') {
      const refuse: [boolean, string, string][] = [
        [Boolean(env.ATLAS_AUTH_SHARED_SECRET), 'ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens'],
        [
          env.ATLAS_MATCHING_EVENT_SOURCE === 'none',
          'ATLAS_MATCHING_EVENT_SOURCE',
          'running without events',
        ],
      ];
      for (const [bad, path, what] of refuse)
        if (bad) issue(path, `${what} are not allowed in production`);
    }
  });

export type MatchingSvcConfig = z.output<typeof schema>;

export function loadMatchingSvcConfig(
  env: Record<string, string | undefined> = process.env,
): MatchingSvcConfig {
  return loadConfig(schema, env);
}

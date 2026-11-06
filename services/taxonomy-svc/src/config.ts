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
    ATLAS_TAXONOMY_PORT: configFields.port.default(8083),
    ATLAS_LOG_LEVEL: configFields.logLevel,
    ATLAS_DATABASE_URL: configFields.databaseUrl,
    ATLAS_AUTH_ISSUER: z.string().url(),
    ATLAS_AUTH_AUDIENCE: z.string().min(1),
    /** identity-svc JWKS, e.g. https://id.atlas.app/.well-known/jwks.json */
    ATLAS_AUTH_JWKS_URL: z.string().url().optional(),
    ATLAS_AUTH_SHARED_SECRET: z.string().min(32).optional(),

    /** `stub` (lexical, dev only) or `gateway` (bge-m3 via llm-gateway). */
    ATLAS_TAXONOMY_EMBEDDINGS: z.enum(['stub', 'gateway']).default('stub'),
    ATLAS_LLM_GATEWAY_URL: z.string().url().optional(),
    /** Client credentials at identity-svc for calling the gateway (scope embeddings:create). */
    ATLAS_TAXONOMY_CLIENT_ID: z.string().min(1).optional(),
    ATLAS_TAXONOMY_CLIENT_SECRET: z.string().min(1).optional(),
    ATLAS_IDENTITY_TOKEN_URL: z.string().url().optional(),

    ATLAS_TAXONOMY_EVENT_SOURCE: z.enum(['none', 'kafka']).default('none'),
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
    if (env.ATLAS_TAXONOMY_EMBEDDINGS === 'gateway') {
      for (const key of [
        'ATLAS_LLM_GATEWAY_URL',
        'ATLAS_TAXONOMY_CLIENT_ID',
        'ATLAS_TAXONOMY_CLIENT_SECRET',
        'ATLAS_IDENTITY_TOKEN_URL',
      ] as const) {
        if (!env[key]) issue(key, 'required when ATLAS_TAXONOMY_EMBEDDINGS=gateway');
      }
    }
    if (env.ATLAS_TAXONOMY_EVENT_SOURCE === 'kafka' && !env.ATLAS_KAFKA_BROKERS?.length) {
      issue('ATLAS_KAFKA_BROKERS', 'required when ATLAS_TAXONOMY_EVENT_SOURCE=kafka');
    }
    if (env.NODE_ENV === 'production') {
      if (env.ATLAS_AUTH_SHARED_SECRET) {
        issue('ATLAS_AUTH_SHARED_SECRET', 'shared-secret tokens are not allowed in production');
      }
      if (env.ATLAS_TAXONOMY_EMBEDDINGS === 'stub') {
        issue('ATLAS_TAXONOMY_EMBEDDINGS', 'the lexical stub is not allowed in production');
      }
      if (env.ATLAS_TAXONOMY_EVENT_SOURCE === 'none') {
        issue(
          'ATLAS_TAXONOMY_EVENT_SOURCE',
          'running without tenant events is not allowed in production',
        );
      }
    }
  });

export type TaxonomySvcConfig = z.output<typeof schema>;

export function loadTaxonomySvcConfig(
  env: Record<string, string | undefined> = process.env,
): TaxonomySvcConfig {
  return loadConfig(schema, env);
}

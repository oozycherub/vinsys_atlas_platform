import { z } from 'zod';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses environment variables with a zod schema (12-factor config, §4.10).
 * Problems name the variable and the rule, never the value, so secrets are not logged.
 */
export function loadConfig<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  env: Record<string, string | undefined> = process.env,
): z.output<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Common building blocks for service config schemas. */
export const configFields = {
  port: z.coerce.number().int().min(1).max(65535),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.string().url().startsWith('postgres'),
  booleanFlag: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
};

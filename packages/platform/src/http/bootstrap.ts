import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { type Logger } from 'pino';
import { type ZodTypeAny, type z } from 'zod';
import { ValidationError } from '../errors';
import { requestContext } from '../logging';
import { ProblemDetailsFilter } from './problem.filter';

interface MiddlewareRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl?: string;
}
interface MiddlewareResponse {
  setHeader(name: string, value: string): void;
  on(event: 'finish', listener: () => void): void;
  statusCode: number;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Applies the cross-cutting HTTP policy every Atlas service shares: request ids, structured
 * access logs, the problem+json error filter, body size limits and shutdown hooks.
 */
export function configureHttpApp(
  app: INestApplication,
  logger: Logger,
  options: { bodyLimit?: string } = {},
): void {
  const express = app.getHttpAdapter().getInstance() as {
    disable(setting: string): void;
    use(fn: (req: MiddlewareRequest, res: MiddlewareResponse, next: () => void) => void): void;
  };
  express.disable('x-powered-by');

  app.use((req: MiddlewareRequest, res: MiddlewareResponse, next: () => void) => {
    const incoming = req.headers['x-request-id'];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
    res.setHeader('x-request-id', requestId);
    const started = process.hrtime.bigint();
    requestContext.run({ requestId }, () => {
      const ctx = requestContext.getStore();
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        logger.info(
          {
            request_id: requestId,
            ...(ctx?.tenantId ? { tenant_id: ctx.tenantId } : {}),
            method: req.method,
            // Path only: query strings can carry PII or secrets (?email=, ?code=, ?token=).
            path: (req.originalUrl ?? '').split('?')[0],
            status: res.statusCode,
            duration_ms: Math.round(durationMs * 10) / 10,
          },
          'http request',
        );
      });
      next();
    });
  });

  // Nest's built-in body parser (enabled by default) honours this limit.
  (
    app as unknown as { useBodyParser?: (type: string, opts: { limit: string }) => void }
  ).useBodyParser?.('json', {
    limit: options.bodyLimit ?? '1mb',
  });
  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();
}

/** Parses untrusted input with a zod schema, raising a 400 problem on failure (§4 rule 6). */
export function parseInput<TSchema extends ZodTypeAny>(
  schema: TSchema,
  input: unknown,
  where = 'body',
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      `The request ${where} is invalid.`,
      result.error.issues.map((issue) => ({
        path: [where, ...issue.path].join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

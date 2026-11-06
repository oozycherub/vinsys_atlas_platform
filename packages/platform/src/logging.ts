import { AsyncLocalStorage } from 'node:async_hooks';
import { type LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';

/** Per-request context propagated through async calls (request id, tenant, principal). */
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  subject?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Paths redacted from every log line. PII and credentials must never reach log storage
 * (MASTER_ORCHESTRATION_PROMPT §4.11).
 */
export const REDACT_PATHS = [
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'password',
  '*.password',
  'token',
  '*.token',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'pii',
  '*.pii',
];

export interface LoggerOptions {
  service: string;
  level?: string;
  /** Destination stream; tests pass an in-memory stream. */
  destination?: pino.DestinationStream;
}

export function createLogger({ service, level = 'info', destination }: LoggerOptions): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const ctx = requestContext.getStore();
      if (!ctx) return {};
      return {
        request_id: ctx.requestId,
        ...(ctx.tenantId ? { tenant_id: ctx.tenantId } : {}),
        ...(ctx.subject ? { subject: ctx.subject } : {}),
      };
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Routes NestJS framework logs through pino so every line is structured JSON. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}

export const LOGGER = Symbol('LOGGER');

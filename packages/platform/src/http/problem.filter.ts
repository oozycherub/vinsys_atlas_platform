import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { type Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { currentRequestContext } from '../logging';

interface HttpRequestLike {
  originalUrl?: string;
  url?: string;
}

interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  request_id?: string;
  [extension: string]: unknown;
}

const ERROR_TYPE_BASE = 'https://errors.atlas.dev/';

function typeUri(code: string): string {
  return ERROR_TYPE_BASE + code.toLowerCase().replace(/_/g, '-');
}

/** Converts every thrown error into RFC 9457 problem+json (§4.6). Never leaks stack traces. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const problem = this.toProblem(exception, request.originalUrl ?? request.url ?? '');

    if (problem.status >= 500) {
      this.logger.error({ err: exception, code: problem.code }, 'request failed');
    } else {
      this.logger.info({ code: problem.code, status: problem.status }, 'request rejected');
    }
    if (exception instanceof AppError) {
      for (const [name, value] of Object.entries(exception.headers))
        response.setHeader(name, value);
    }
    response.setHeader('Content-Type', 'application/problem+json');
    response.status(problem.status).json(problem);
  }

  toProblem(exception: unknown, instance: string): ProblemDocument {
    const requestId = currentRequestContext()?.requestId;
    const base = { instance, ...(requestId ? { request_id: requestId } : {}) };

    if (exception instanceof AppError) {
      return {
        type: typeUri(exception.code),
        title: exception.title,
        status: exception.status,
        detail: exception.message,
        code: exception.code,
        ...exception.extensions,
        ...base,
      };
    }
    if (exception instanceof ZodError) {
      return {
        type: typeUri('VALIDATION_FAILED'),
        title: 'Request validation failed',
        status: 400,
        detail: 'One or more fields are invalid.',
        code: 'VALIDATION_FAILED',
        errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ...base,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? 'ROUTE_NOT_FOUND' : `HTTP_${status}`;
      return {
        type: typeUri(code),
        title: exception.name.replace(/Exception$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
        status,
        detail: status >= 500 ? 'An unexpected error occurred.' : exception.message,
        code,
        ...base,
      };
    }
    return {
      type: typeUri('INTERNAL'),
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected error occurred.',
      code: 'INTERNAL',
      ...base,
    };
  }
}

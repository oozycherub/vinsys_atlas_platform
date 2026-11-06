/**
 * Typed application errors. Each carries a stable machine-readable `code` and an HTTP status;
 * the problem-details filter turns them into RFC 9457 responses (MASTER_ORCHESTRATION_PROMPT §4.6).
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly title: string;

  /** Response headers the problem filter adds, e.g. Retry-After. */
  readonly headers: Readonly<Record<string, string>> = {};

  constructor(
    readonly code: string,
    detail: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly title = 'Request validation failed';

  constructor(
    detail: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super('VALIDATION_FAILED', detail, { errors: issues });
  }
}

/** A semantically invalid request with a domain-specific code (e.g. INVALID_SETTINGS). */
export class BadRequestError extends AppError {
  readonly status = 400;
  readonly title = 'Bad request';
}

export class UnauthorizedError extends AppError {
  readonly status = 401;
  readonly title = 'Authentication required';

  constructor(
    detail = 'A valid bearer token is required.',
    code = 'UNAUTHENTICATED',
    extensions: Record<string, unknown> = {},
  ) {
    super(code, detail, extensions);
  }
}

export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly title = 'Forbidden';

  constructor(detail = 'You do not have permission to perform this action.', code = 'FORBIDDEN') {
    super(code, detail);
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly title = 'Resource not found';
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly title = 'Conflict';
}

export class PreconditionFailedError extends AppError {
  readonly status = 412;
  readonly title = 'Precondition failed';
}

export class PreconditionRequiredError extends AppError {
  readonly status = 428;
  readonly title = 'Precondition required';
}

/** A business rule rejected an otherwise well-formed request. */
export class DomainRuleError extends AppError {
  readonly status = 422;
  readonly title = 'Business rule violated';
}

export class ServiceUnavailableError extends AppError {
  readonly status = 503;
  readonly title = 'Service unavailable';
}

/** 429 with Retry-After (RFC 9110 §10.2.3). */
export class TooManyRequestsError extends AppError {
  readonly status = 429;
  readonly title = 'Too many requests';
  override readonly headers: Readonly<Record<string, string>>;

  constructor(code: string, detail: string, retryAfterSec: number) {
    super(code, detail, { retry_after: retryAfterSec });
    this.headers = { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) };
  }
}

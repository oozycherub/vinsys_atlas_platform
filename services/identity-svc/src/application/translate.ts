import {
  type AppError,
  BadRequestError,
  ConflictError,
  DomainRuleError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  UnauthorizedError,
} from '@atlas/platform';
import { IdentityDomainError } from '../domain/errors';

/** Maps framework-free domain errors to HTTP-aware platform errors at the application boundary. */
export function toAppError(error: IdentityDomainError): AppError {
  switch (error.kind) {
    case 'validation':
      return new BadRequestError(error.code, error.message);
    case 'unauthorized':
      return new UnauthorizedError(error.message, error.code);
    case 'forbidden':
      return new ForbiddenError(error.message, error.code);
    case 'not_found':
      return new NotFoundError(error.code, error.message);
    case 'conflict':
      return new ConflictError(error.code, error.message);
    case 'rule':
      return new DomainRuleError(error.code, error.message);
    case 'precondition_failed':
      return new PreconditionFailedError(error.code, error.message);
  }
}

export async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof IdentityDomainError) throw toAppError(error);
    throw error;
  }
}

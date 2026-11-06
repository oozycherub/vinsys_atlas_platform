import { type Role } from '@atlas/contracts';
import {
  BadRequestError,
  ConflictError,
  DomainRuleError,
  ForbiddenError,
  hasAnyRole,
  isSuperAdmin,
  isUuid,
  NotFoundError,
  type Principal,
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from '@atlas/platform';
import { AssessmentRuleError } from '../domain/assessment';
import { QuestionError } from '../domain/questions';
import { SessionRuleError } from '../domain/session';
import { ServiceRejectedError, UpstreamError } from './ports';

/** Who authors questions and assessments (SMEs write questions too). */
export const AUTHORS: Role[] = ['tenant_admin', 'recruiter', 'sme', 'super_admin', 'service'];
/** Who publishes, invites and manages candidates. */
export const MANAGERS: Role[] = ['tenant_admin', 'recruiter', 'super_admin', 'service'];
/** Who reads results. Candidates and employees never see other people's results. */
export const RESULT_READERS: Role[] = [
  'tenant_admin',
  'recruiter',
  'hiring_manager',
  'reviewer',
  'sme',
  'super_admin',
  'service',
];

export function tenantOf(principal: Principal, requested: string | undefined): string {
  if (principal.tenantId) {
    if (requested !== undefined && requested !== principal.tenantId)
      throw new NotFoundError('NOT_FOUND', 'Not found.');
    return principal.tenantId;
  }
  if (isSuperAdmin(principal) || hasAnyRole(principal, ['service'])) {
    if (!requested || !isUuid(requested)) {
      throw new BadRequestError('TENANT_ID_REQUIRED', 'Platform principals must pass tenant_id.');
    }
    return requested;
  }
  throw new ForbiddenError('This token is not bound to a tenant.');
}

/** Domain failures → RFC 9457 problems. */
export async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof QuestionError) throw new ValidationError(error.message, []);
    if (error instanceof AssessmentRuleError) throw new DomainRuleError(error.code, error.message);
    if (error instanceof SessionRuleError) {
      throw error.kind === 'conflict'
        ? new ConflictError(error.code, error.message)
        : new DomainRuleError(error.code, error.message);
    }
    if (error instanceof UpstreamError)
      throw new ServiceUnavailableError('DEPENDENCY_UNAVAILABLE', error.message);
    if (error instanceof ServiceRejectedError) throw fromService(error);
    throw error;
  }
}

/** Internal services' refusals keep their code (RUN_THROTTLED, CONSENT_REQUIRED, ...). */
function fromService(e: ServiceRejectedError): Error {
  switch (e.status) {
    case 429:
      return new TooManyRequestsError(e.code, e.detail, e.retryAfter ?? 3);
    case 404:
      return new NotFoundError(e.code, e.detail);
    case 409:
      return new ConflictError(e.code, e.detail);
    case 400:
    case 422:
      return new DomainRuleError(e.code, e.detail);
    default:
      // 403 and the like mean this service is misconfigured, not that the caller erred.
      return new ServiceUnavailableError('DEPENDENCY_UNAVAILABLE', `sandbox-svc: ${e.code}`);
  }
}

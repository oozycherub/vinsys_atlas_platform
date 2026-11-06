/** How the outer layers should surface a domain failure. Kept free of HTTP/framework types. */
export type DomainErrorKind =
  'validation' | 'forbidden' | 'not_found' | 'conflict' | 'rule' | 'precondition_failed';

export class TenantDomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantDomainError';
  }
}

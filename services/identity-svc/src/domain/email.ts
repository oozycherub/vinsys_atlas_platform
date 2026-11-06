import { IdentityDomainError } from './errors';

// Pragmatic check (RFC 5321 lengths, one @, a dot in the domain); delivery proves the rest.
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/** Emails are compared case-insensitively, so they are stored lower-cased (see 0004_identity.sql). */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw new IdentityDomainError('validation', 'INVALID_EMAIL', 'The email address is invalid.');
  }
  return email;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

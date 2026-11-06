import { TenantDomainError } from './errors';

/** 3–63 chars, lowercase alphanumerics and single hyphens, alphanumeric at both ends (DNS label). */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/** Subdomains the platform itself uses (`<slug>.atlas.app`). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'login',
  'static',
  'assets',
  'status',
  'docs',
  'help',
  'support',
  'mail',
  'internal',
  'system',
  'platform',
  'atlas',
]);

export function assertValidSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug) || slug.includes('--')) {
    throw new TenantDomainError(
      'validation',
      'TENANT_SLUG_INVALID',
      'Slug must be 3–63 lowercase letters, digits or single hyphens, starting and ending with a letter or digit.',
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new TenantDomainError(
      'rule',
      'TENANT_SLUG_RESERVED',
      `The slug "${slug}" is reserved by the platform.`,
    );
  }
  return slug;
}

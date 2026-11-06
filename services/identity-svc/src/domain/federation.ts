import { emailDomain } from './email';
import { IdentityDomainError } from './errors';

export const FEDERATION_STATE_TTL_MS = 10 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Validates an OAuth client's redirect URI by exact match (RFC 9700 §2.1). A registered URI may
 * contain `{slug}`, which must equal the tenant being signed in to, so one tenant's login can
 * never be redirected to another tenant's subdomain.
 */
export function resolveRedirectUri(
  registered: readonly string[],
  requested: string,
  slug: string | null,
): string {
  const allowed = registered.map((uri) => (slug ? uri.replaceAll('{slug}', slug) : uri));
  if (!allowed.includes(requested) || requested.includes('{slug}')) {
    throw new IdentityDomainError(
      'validation',
      'INVALID_REDIRECT_URI',
      'redirect_uri is not registered for this client.',
    );
  }
  return requested;
}

/** Only S256 PKCE challenges (RFC 7636); `plain` is refused. */
export function assertCodeChallenge(challenge: string, method: string | undefined): void {
  if (method !== 'S256' || !CODE_CHALLENGE.test(challenge)) {
    throw new IdentityDomainError(
      'validation',
      'INVALID_CODE_CHALLENGE',
      'A S256 code_challenge (43 base64url characters) is required.',
    );
  }
}

export interface ExpiringOnce {
  expiresAt: Date;
  consumedAt: Date | null;
}

export function isUsable(item: ExpiringOnce, now: Date): boolean {
  return item.consumedAt === null && now.getTime() < item.expiresAt.getTime();
}

/**
 * An IdP may only sign in addresses from the domains the connection names; otherwise a tenant
 * IdP could assert any address. Empty hints means the tenant has not restricted domains.
 */
export function assertDomainAllowed(email: string, domains: readonly string[], code: string): void {
  if (domains.length > 0 && !domains.includes(emailDomain(email))) {
    throw new IdentityDomainError(
      'forbidden',
      code,
      'The identity provider asserted an email outside the allowed domains.',
    );
  }
}

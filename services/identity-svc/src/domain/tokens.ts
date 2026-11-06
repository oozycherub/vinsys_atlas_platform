import { IdentityDomainError } from './errors';

export const ACCESS_TOKEN_TTL_SEC = 10 * 60;
export const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAGIC_LINK_TTL_MS = 30 * 60 * 1000;

/** One refresh token in a family (one login). */
export interface RefreshTokenRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly amr: readonly string[];
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type RefreshDecision =
  | { kind: 'rotate' }
  /** A token that was already exchanged came back: assume theft, revoke the whole family. */
  | { kind: 'reuse' }
  | { kind: 'invalid'; reason: 'revoked' | 'expired' };

/** Refresh rotation with reuse detection (docs/prompts/02-identity-svc.md §6). */
export function evaluateRefresh(token: RefreshTokenRecord, now: Date): RefreshDecision {
  if (token.revokedAt) return { kind: 'invalid', reason: 'revoked' };
  if (token.usedAt) return { kind: 'reuse' };
  if (now.getTime() >= token.expiresAt.getTime()) return { kind: 'invalid', reason: 'expired' };
  return { kind: 'rotate' };
}

/**
 * Refresh tokens carry their tenant so the lookup can run under that tenant's RLS context:
 * `rt.<tenant uuid>.<256-bit secret>`. Only the SHA-256 of the whole string is stored.
 */
const REFRESH_FORMAT = /^rt\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export function formatRefreshToken(tenantId: string, secret: string): string {
  return `rt.${tenantId}.${secret}`;
}

export function parseRefreshToken(token: string): { tenantId: string } {
  const match = REFRESH_FORMAT.exec(token);
  if (!match?.[1]) {
    throw new IdentityDomainError('unauthorized', 'INVALID_GRANT', 'The refresh token is invalid.');
  }
  return { tenantId: match[1] };
}

/**
 * OAuth scope selection for client credentials: the requested scopes must all be allowed;
 * no request means every allowed scope.
 */
export function grantScopes(allowed: readonly string[], requested: string | undefined): string[] {
  const asked = (requested ?? '').split(' ').filter(Boolean);
  if (asked.length === 0) return [...allowed].sort();
  const denied = asked.filter((s) => !allowed.includes(s));
  if (denied.length > 0) {
    throw new IdentityDomainError(
      'validation',
      'INVALID_SCOPE',
      `The client may not request: ${denied.join(', ')}.`,
    );
  }
  return [...new Set(asked)].sort();
}

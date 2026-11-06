import { describe, expect, it } from 'vitest';
import { IdentityDomainError } from '../../src/domain/errors';
import {
  assertCodeChallenge,
  assertDomainAllowed,
  isUsable,
  resolveRedirectUri,
} from '../../src/domain/federation';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityDomainError);
    return (error as IdentityDomainError).code;
  }
  return 'none';
}

describe('federation rules', () => {
  const registered = ['https://{slug}.atlas.app/auth/callback', 'https://admin.atlas.app/cb'];

  it('matches redirect URIs exactly, with {slug} bound to the tenant', () => {
    expect(resolveRedirectUri(registered, 'https://acme.atlas.app/auth/callback', 'acme')).toBe(
      'https://acme.atlas.app/auth/callback',
    );
    expect(resolveRedirectUri(registered, 'https://admin.atlas.app/cb', null)).toBe(
      'https://admin.atlas.app/cb',
    );
    for (const [uri, slug] of [
      ['https://other.atlas.app/auth/callback', 'acme'],
      ['https://acme.atlas.app/auth/callback/', 'acme'],
      ['https://{slug}.atlas.app/auth/callback', null],
      ['https://acme.atlas.app/auth/callback?x=1', 'acme'],
    ] as const) {
      expect(code(() => resolveRedirectUri(registered, uri, slug))).toBe('INVALID_REDIRECT_URI');
    }
  });

  it('requires S256 PKCE', () => {
    const ok = 'a'.repeat(43);
    expect(code(() => assertCodeChallenge(ok, 'S256'))).toBe('none');
    expect(code(() => assertCodeChallenge(ok, 'plain'))).toBe('INVALID_CODE_CHALLENGE');
    expect(code(() => assertCodeChallenge(ok, undefined))).toBe('INVALID_CODE_CHALLENGE');
    expect(code(() => assertCodeChallenge('short', 'S256'))).toBe('INVALID_CODE_CHALLENGE');
  });

  it('limits IdP-asserted emails to the configured domains', () => {
    expect(code(() => assertDomainAllowed('a@corp.test', ['corp.test'], 'X'))).toBe('none');
    expect(code(() => assertDomainAllowed('a@evil.test', ['corp.test'], 'X'))).toBe('X');
    expect(code(() => assertDomainAllowed('a@any.test', [], 'X'))).toBe('none');
  });

  it('treats states and codes as single use and expiring', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const later = new Date(now.getTime() + 1000);
    expect(isUsable({ expiresAt: later, consumedAt: null }, now)).toBe(true);
    expect(isUsable({ expiresAt: later, consumedAt: now }, now)).toBe(false);
    expect(isUsable({ expiresAt: now, consumedAt: null }, now)).toBe(false);
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed artifact links (ADR-0010 §7): HMAC-SHA256(key, "<tenant>.<artifact>.<exp>"), base64url.
 * The link names its tenant so the download can open the right RLS context without a token.
 */
export function signLink(key: Buffer, tenantId: string, artifactId: string, exp: number): string {
  return createHmac('sha256', key).update(`${tenantId}.${artifactId}.${exp}`).digest('base64url');
}

export function verifyLink(
  key: Buffer,
  tenantId: string,
  artifactId: string,
  exp: number,
  sig: string,
  nowMs: number,
  maxTtlMs: number,
): 'ok' | 'expired' | 'invalid' {
  const expected = Buffer.from(signLink(key, tenantId, artifactId, exp));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  const expMs = exp * 1000;
  if (expMs <= nowMs) return 'expired';
  if (expMs > nowMs + maxTtlMs + 60_000) return 'invalid'; // never longer-lived than issued
  return 'ok';
}

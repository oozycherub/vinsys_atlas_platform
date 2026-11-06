import { ACCESS_TOKEN_TTL_SEC } from './tokens';

/** Metadata of an ES256 signing key; the sealed private key never enters the domain. */
export interface SigningKeyMeta {
  readonly kid: string;
  readonly createdAt: Date;
  /** Signs from here on. */
  readonly activatesAt: Date;
  /** Stops signing here (set when a successor is created). */
  readonly retiresAt: Date | null;
  /** Leaves JWKS here, once every token it signed has expired. */
  readonly publishUntil: Date | null;
}

export const ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A new key is published this long before it signs, so verifiers that cache JWKS (the gateway
 * caches for 5 minutes) already know it when the first token arrives.
 */
export const PREPUBLISH_MS = 10 * 60 * 1000;
/** Clock-skew allowance verifiers apply (JwtVerifier default: 30 s), rounded up. */
const SKEW_MS = 60 * 1000;

/** The key that signs now: the newest one that has activated and not retired. */
export function selectSigningKey(
  keys: readonly SigningKeyMeta[],
  now: Date,
): SigningKeyMeta | null {
  const t = now.getTime();
  const live = keys.filter(
    (k) => k.activatesAt.getTime() <= t && (k.retiresAt === null || k.retiresAt.getTime() > t),
  );
  live.sort((a, b) => b.activatesAt.getTime() - a.activatesAt.getTime());
  return live[0] ?? null;
}

/** Keys in JWKS: every key that has not passed publish_until (including pre-published ones). */
export function publishedKeys<K extends SigningKeyMeta>(keys: readonly K[], now: Date): K[] {
  const t = now.getTime();
  return keys.filter((k) => k.publishUntil === null || k.publishUntil.getTime() > t);
}

export function isRotationDue(keys: readonly SigningKeyMeta[], now: Date): boolean {
  const open = keys.find((k) => k.retiresAt === null);
  return !open || now.getTime() - open.activatesAt.getTime() >= ROTATION_INTERVAL_MS;
}

/**
 * Plans a rotation. With no key at all (first boot) the new key signs immediately; otherwise it
 * is pre-published and the current key keeps signing until the successor activates, then stays
 * in JWKS until its last token expires.
 */
export function planRotation(
  keys: readonly SigningKeyMeta[],
  now: Date,
): { activatesAt: Date; retire: { kid: string; retiresAt: Date; publishUntil: Date } | null } {
  const open = keys.find((k) => k.retiresAt === null);
  if (!open) return { activatesAt: now, retire: null };
  const activatesAt = new Date(now.getTime() + PREPUBLISH_MS);
  return {
    activatesAt,
    retire: {
      kid: open.kid,
      retiresAt: activatesAt,
      publishUntil: new Date(activatesAt.getTime() + ACCESS_TOKEN_TTL_SEC * 1000 + SKEW_MS),
    },
  };
}

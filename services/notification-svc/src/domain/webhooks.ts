import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Webhook signing (Component Prompt 13 §6, ADR-0010 §5). The documented algorithm:
 *
 *   signed  = "<t>.<raw request body>"            t = Unix seconds when the attempt was sent
 *   v1      = hex(HMAC-SHA256(endpoint secret, signed))
 *   header  Atlas-Signature: t=<t>,v1=<v1>
 *
 * Receivers recompute v1 over the raw body, compare in constant time and reject t more than
 * 5 minutes from their clock.
 */
export const SIGNATURE_HEADER = 'Atlas-Signature';
export const SIGNATURE_TOLERANCE_S = 300;

export function signPayload(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export function verifySignature(
  header: string,
  secret: string,
  body: string,
  nowSeconds: number,
  toleranceS = SIGNATURE_TOLERANCE_S,
): boolean {
  const parts = new Map(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1') ?? '';
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceS) return false;
  const expected = Buffer.from(signPayload(secret, t, body).split('v1=')[1] ?? '', 'hex');
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Retries: 1 min, doubling, 8 attempts in all (~4 h), then the delivery is dead (the DLQ). */
export const MAX_DELIVERY_ATTEMPTS = 8;
export const DISABLE_AFTER_FAILURES = 50;

export function retryDelayMs(attempt: number): number {
  return 60_000 * 2 ** Math.max(0, attempt - 1);
}

/** Public webhook event names: the topic without its version. */
export const WEBHOOK_EVENT_TYPES = [
  'assessment.session.submitted',
  'assessment.session.terminated',
  'assessment.session.evaluated',
  'proctoring.session.finalized',
  'interview.session.completed',
  'report.artifact.ready',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function webhookTypeOf(topic: string): WebhookEventType | null {
  const name = topic.replace(/\.v\d+$/, '');
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(name)
    ? (name as WebhookEventType)
    : null;
}

/**
 * Only public unicast addresses may receive webhooks (no SSRF into the cell): loopback, private,
 * link-local (cloud metadata), CGNAT, multicast and reserved ranges are refused.
 */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicV4(address);
  if (kind === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped?.[1]) return isPublicV4(mapped[1]);
    if (a === '::' || a === '::1') return false;
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (a.startsWith('64:ff9b:') || a.startsWith('2001:db8:')) return false;
    return true;
  }
  return false;
}

function isPublicV4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link local, metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Endpoint URLs: https, no credentials, no IP literal outside public space. */
export function checkEndpointUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username || url.password) return 'must not contain credentials';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) return 'must not point at a private address';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return 'must not point at an internal host';
  return null;
}

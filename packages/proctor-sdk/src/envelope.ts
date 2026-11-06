import { type SubtleLike } from './env';

/** Event types the server accepts (proctoring-svc domain.EventTypes). */
export type ProctorEventType =
  | 'tab_hidden'
  | 'fullscreen_exit'
  | 'paste'
  | 'copy'
  | 'cut'
  | 'context_menu'
  | 'multi_monitor'
  | 'face_count'
  | 'frame'
  | 'voice_activity'
  | 'heartbeat'
  | 'automation_suspected'
  | 'network_offline'
  | 'device_lost'
  | 'keystroke_summary';

/** A signed, hash-chained event (PRD §2.3b; ADR-0007). */
export interface ProctorEnvelope {
  session_id: string;
  seq: number;
  type: ProctorEventType;
  client_ts: number;
  key_epoch: number;
  payload: Record<string, unknown>;
  prev_hash: string;
  mac: string;
}

/**
 * Canonical JSON: keys sorted by UTF-16 code units (Array.prototype.sort), no whitespace,
 * primitives exactly as JSON.stringify writes them. The server re-serialises the same way.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

const encoder = new TextEncoder();

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(subtle: SubtleLike, text: string): Promise<string> {
  return toHex(await subtle.digest('SHA-256', encoder.encode(text)));
}

/**
 * Signs events in sequence. Each envelope carries the hash of the previous one, so suppressing,
 * reordering or editing events breaks the chain server-side (tamper_suspected).
 */
export class Signer {
  private key: unknown = null;
  private keyEpoch: number;
  private rawKey: Uint8Array;
  private nextSeq: number;
  private prevHash: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly subtle: SubtleLike,
    private readonly sessionId: string,
    start: { key: Uint8Array; epoch: number; nextSeq: number; prevHash: string },
  ) {
    this.rawKey = start.key;
    this.keyEpoch = start.epoch;
    this.nextSeq = start.nextSeq;
    this.prevHash = start.prevHash;
  }

  /** Switches to a rotated key (the server sends one every 15 minutes). */
  rotate(epoch: number, key: Uint8Array): void {
    if (epoch <= this.keyEpoch) return;
    this.keyEpoch = epoch;
    this.rawKey = key;
    this.key = null;
  }

  get epoch(): number {
    return this.keyEpoch;
  }

  /** Signs one event; calls are serialised so seq and the chain stay in order. */
  sign(
    type: ProctorEventType,
    payload: Record<string, unknown>,
    clientTs: number,
  ): Promise<ProctorEnvelope> {
    const run = this.pending.then(() => this.signNow(type, payload, clientTs));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async signNow(
    type: ProctorEventType,
    payload: Record<string, unknown>,
    clientTs: number,
  ): Promise<ProctorEnvelope> {
    this.key ??= await this.subtle.importKey(
      'raw',
      this.rawKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const unsigned = {
      session_id: this.sessionId,
      seq: this.nextSeq,
      type,
      client_ts: clientTs,
      key_epoch: this.keyEpoch,
      payload,
      prev_hash: this.prevHash,
    };
    const mac = toHex(
      await this.subtle.sign('HMAC', this.key, encoder.encode(canonicalJson(unsigned))),
    );
    const envelope: ProctorEnvelope = { ...unsigned, mac };
    this.prevHash = await sha256Hex(this.subtle, canonicalJson(envelope));
    this.nextSeq += 1;
    return envelope;
  }
}

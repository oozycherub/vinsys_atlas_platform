/** notification-svc's outbound ports and settings (adapters in ../infrastructure). */

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** `permanent`: the provider refused the message (bad address, suppressed); retrying is useless. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export interface EmailSender {
  send(message: OutgoingEmail): Promise<{ messageId: string }>;
}
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface WebhookResponse {
  status: number;
}
/** Network failure, timeout or a refused (non-public) address. */
export class WebhookTransportError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'WebhookTransportError';
  }
}
export interface WebhookTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<WebhookResponse>;
}
export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');

export interface DnsResolver {
  txt(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
}
export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

/** Wakes open SSE streams in this process when a user's inbox changes. */
export class InboxHub {
  private readonly listeners = new Map<string, Set<() => void>>();

  subscribe(tenantId: string, userId: string, listener: () => void): () => void {
    const key = `${tenantId}:${userId}`;
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  publish(tenantId: string, userId: string): void {
    for (const listener of this.listeners.get(`${tenantId}:${userId}`) ?? []) listener();
  }

  get size(): number {
    return this.listeners.size;
  }
}
export const INBOX_HUB = Symbol('INBOX_HUB');

export interface NotificationSettings {
  /** Fallback sender, e.g. `Atlas <no-reply@mail.atlas.example>`. */
  defaultFrom: string;
  /** SPF include a tenant's domain must list, e.g. `spf.mail.atlas.example`. */
  spfInclude: string;
  /** DKIM CNAME target suffix: `<selector>._domainkey.<domain>` → `<selector>.<dkimTarget>`. */
  dkimTarget: string;
  /** 32-byte key sealing webhook secrets. */
  secretKek: Buffer;
  /** Work items claimed per worker pass, and how long a claim lasts. */
  batchSize: number;
  leaseMs: number;
  /** How often an open SSE stream re-reads the inbox (other instances' writes). */
  ssePollMs: number;
}
export const NOTIFICATION_SETTINGS = Symbol('NOTIFICATION_SETTINGS');
export const NOTIFICATION_LOGGER = Symbol('NOTIFICATION_LOGGER');

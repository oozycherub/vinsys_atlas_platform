/** Test doubles for notification-svc's providers: email, webhook receivers and DNS. */
import {
  type DnsResolver,
  EmailSendError,
  type EmailSender,
  type OutgoingEmail,
  WebhookTransportError,
  type WebhookResponse,
  type WebhookTransport,
} from '../../src/application/ports';

export class FakeEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  /** Failures queued per recipient address: 'transient' | 'permanent'. */
  readonly failures = new Map<string, ('transient' | 'permanent')[]>();

  fail(address: string, ...kinds: ('transient' | 'permanent')[]): void {
    this.failures.set(address, [...(this.failures.get(address) ?? []), ...kinds]);
  }

  send(message: OutgoingEmail): Promise<{ messageId: string }> {
    const failure = this.failures.get(message.to)?.shift();
    if (failure)
      return Promise.reject(new EmailSendError(`fake ${failure}`, failure === 'permanent'));
    this.sent.push(message);
    return Promise.resolve({ messageId: `msg-${this.sent.length}` });
  }

  to(address: string): OutgoingEmail[] {
    return this.sent.filter((m) => m.to === address);
  }
}

export interface ReceivedHook {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export class FakeWebhookTransport implements WebhookTransport {
  readonly received: ReceivedHook[] = [];
  /** Status per URL (default 200); 'down' throws a transport error. */
  readonly behaviour = new Map<string, number | 'down'>();

  post(url: string, body: string, headers: Record<string, string>): Promise<WebhookResponse> {
    this.received.push({ url, body, headers });
    const b = this.behaviour.get(url) ?? 200;
    if (b === 'down') return Promise.reject(new WebhookTransportError('connection failed'));
    return Promise.resolve({ status: b });
  }
}

export class FakeDns implements DnsResolver {
  readonly txtRecords = new Map<string, string[]>();
  readonly cnameRecords = new Map<string, string[]>();
  txt(name: string): Promise<string[]> {
    const r = this.txtRecords.get(name);
    return r ? Promise.resolve(r) : Promise.reject(new Error('ENOTFOUND'));
  }
  cname(name: string): Promise<string[]> {
    return Promise.resolve(this.cnameRecords.get(name) ?? []);
  }
}

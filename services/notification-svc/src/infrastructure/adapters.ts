import { lookup } from 'node:dns/promises';
import { Resolver } from 'node:dns/promises';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { type Logger } from 'pino';
import { randomToken } from '@atlas/platform';
import {
  type DnsResolver,
  EmailSendError,
  type EmailSender,
  type OutgoingEmail,
  WebhookTransportError,
  type WebhookResponse,
  type WebhookTransport,
} from '../application/ports';
import { isPublicAddress } from '../domain/webhooks';

/** Amazon SES v2. Throttling and 5xx are transient; rejected messages are permanent. */
export class SesEmailSender implements EmailSender {
  constructor(
    private readonly client: Pick<SESv2Client, 'send'>,
    private readonly configurationSet?: string,
  ) {}

  async send(m: OutgoingEmail): Promise<{ messageId: string }> {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: m.from,
          Destination: { ToAddresses: [m.to] },
          ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
          Content: {
            Simple: {
              Subject: { Data: m.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: m.html, Charset: 'UTF-8' },
                Text: { Data: m.text, Charset: 'UTF-8' },
              },
              Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
            },
          },
        }),
      );
      return { messageId: out.MessageId ?? 'ses' };
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      const status = e.$metadata?.httpStatusCode ?? 0;
      const permanent =
        [
          'MessageRejected',
          'MailFromDomainNotVerifiedException',
          'AccountSuspendedException',
          'BadRequestException',
        ].includes(e.name ?? '') ||
        (status >= 400 && status < 500 && status !== 429);
      throw new EmailSendError(e.name || 'SESError', permanent);
    }
  }
}

export function sesClient(region: string): SESv2Client {
  return new SESv2Client({ region });
}

/** SendGrid v3 mail/send. 4xx (except 429) is permanent. */
export class SendGridEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.sendgrid.com',
  ) {}

  async send(m: OutgoingEmail): Promise<{ messageId: string }> {
    const from = /^(.*)<([^>]+)>\s*$/.exec(m.from);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v3/mail/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: m.to }] }],
          from: from
            ? { email: from[2]?.trim(), name: from[1]?.trim() || undefined }
            : { email: m.from },
          subject: m.subject,
          content: [
            { type: 'text/plain', value: m.text },
            { type: 'text/html', value: m.html },
          ],
          headers: m.headers,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new EmailSendError((error as Error).name, false);
    }
    if (res.ok) return { messageId: res.headers.get('x-message-id') ?? 'sendgrid' };
    throw new EmailSendError(
      `HTTP ${res.status}`,
      res.status >= 400 && res.status < 500 && res.status !== 429,
    );
  }
}

/** Development: logs that an email would be sent, without its body (links are secrets). */
export class LogEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}
  send(m: OutgoingEmail): Promise<{ messageId: string }> {
    this.logger.info(
      { subject: m.subject, notification_id: m.headers['X-Atlas-Notification-Id'] },
      'email (log only)',
    );
    return Promise.resolve({ messageId: `log-${randomToken(8)}` });
  }
}

type Lookup = (host: string) => Promise<{ address: string }[]>;

/**
 * POSTs a webhook after resolving the host and refusing non-public addresses (SSRF). Redirects
 * are not followed: a 3xx counts as a failure.
 */
export class HttpWebhookTransport implements WebhookTransport {
  constructor(
    private readonly timeoutMs = 10_000,
    private readonly resolve: Lookup = (host) => lookup(host, { all: true }),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post(url: string, body: string, headers: Record<string, string>): Promise<WebhookResponse> {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new WebhookTransportError('not https');
    let addresses: { address: string }[];
    try {
      addresses = await this.resolve(target.hostname.replace(/^\[|\]$/g, ''));
    } catch {
      throw new WebhookTransportError('DNS lookup failed');
    }
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address)))
      throw new WebhookTransportError('host resolves to a non-public address');
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.body?.cancel();
      return { status: res.status };
    } catch (error) {
      throw new WebhookTransportError(
        (error as Error).name === 'TimeoutError' ? 'timeout' : 'connection failed',
      );
    }
  }
}

export class NodeDnsResolver implements DnsResolver {
  private readonly resolver = new Resolver({ timeout: 5000, tries: 2 });
  async txt(name: string): Promise<string[]> {
    return (await this.resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  }
  cname(name: string): Promise<string[]> {
    return this.resolver.resolveCname(name);
  }
}

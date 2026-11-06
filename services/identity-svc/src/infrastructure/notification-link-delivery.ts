import { type Logger } from 'pino';
import { randomToken } from '@atlas/platform';
import { type LinkDelivery } from '../application/ports';

type LinkMessage = Parameters<LinkDelivery['send']>[0];

export interface NotificationDeliveryOptions {
  /** notification-svc base URL, e.g. http://notification-svc:8093 */
  baseUrl: string;
  /** Bearer token for notification-svc (scope notifications:send). */
  token: () => Promise<string>;
  logger?: Logger;
  attempts?: number;
  timeoutMs?: number;
  /** Base backoff between attempts; doubles each time. */
  backoffMs?: number;
}

/**
 * Sends invitation and login links through notification-svc (contract in
 * docs/prompts/13-notification-report.md: POST /v1/internal/link-messages). Retries network
 * errors, 429 and 5xx with exponential backoff, reusing one Idempotency-Key so a retry never
 * sends twice. Runs after the database commit, so a final failure is logged, not thrown:
 * the invitation exists and an admin can resend it.
 */
export class NotificationLinkDelivery implements LinkDelivery {
  constructor(private readonly options: NotificationDeliveryOptions) {}

  async send(message: LinkMessage): Promise<void> {
    const attempts = this.options.attempts ?? 3;
    const idempotencyKey = `link-${randomToken(16)}`;
    const body = JSON.stringify({
      kind: message.kind,
      tenant_id: message.tenantId,
      email: message.email,
      url: message.url,
      expires_at: message.expiresAt.toISOString(),
    });
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(
          `${this.options.baseUrl.replace(/\/$/, '')}/v1/internal/link-messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${await this.options.token()}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body,
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
          },
        );
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) break; // not retryable
      } catch (error) {
        lastError = (error as Error).name;
      }
      if (attempt < attempts) {
        await new Promise((r) =>
          setTimeout(r, (this.options.backoffMs ?? 200) * 2 ** (attempt - 1)),
        );
      }
    }
    // Never log the URL: it is a bearer secret.
    this.options.logger?.error(
      { kind: message.kind, tenant_id: message.tenantId, reason: lastError },
      'link delivery failed; the link was not sent',
    );
  }
}

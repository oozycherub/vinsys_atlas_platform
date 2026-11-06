import { type LinkDelivery } from '../application/ports';

type LinkMessage = Parameters<LinkDelivery['send']>[0];

/**
 * Development/test delivery: keeps links in memory instead of emailing them. Refused in
 * production by config; the real adapter calls notification-svc (brick 13).
 */
export class MemoryLinkDelivery implements LinkDelivery {
  readonly sent: LinkMessage[] = [];

  send(message: LinkMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The token from the most recent link sent to `email`. */
  lastToken(email: string): string {
    const message = [...this.sent].reverse().find((m) => m.email === email);
    const token = message ? new URL(message.url).searchParams.get('token') : null;
    if (!token) throw new Error(`No link was sent to ${email}.`);
    return token;
  }
}

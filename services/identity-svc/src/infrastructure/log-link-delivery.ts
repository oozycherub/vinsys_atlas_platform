import { type Logger } from 'pino';
import { type LinkDelivery } from '../application/ports';

/** Development only: writes links to the log so you can click them. Refused in production. */
export class LogLinkDelivery implements LinkDelivery {
  constructor(private readonly logger: Logger) {}

  send(message: Parameters<LinkDelivery['send']>[0]): Promise<void> {
    this.logger.warn(
      { kind: message.kind, tenant_id: message.tenantId, link: message.url },
      'DEV ONLY: login link (not emailed)',
    );
    return Promise.resolve();
  }
}

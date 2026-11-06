import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { type Logger } from 'pino';
import {
  AuthGuard,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '@atlas/platform';
import { AdminService } from './application/admin.service';
import { Dispatcher } from './application/dispatcher';
import { EmailWorker } from './application/email.worker';
import { NotificationEventHandlers } from './application/event-handlers';
import { InboxService } from './application/inbox.service';
import { InternalService } from './application/internal.service';
import {
  DNS_RESOLVER,
  type DnsResolver,
  EMAIL_SENDER,
  type EmailSender,
  INBOX_HUB,
  InboxHub,
  NOTIFICATION_LOGGER,
  NOTIFICATION_SETTINGS,
  type NotificationSettings,
  WEBHOOK_TRANSPORT,
  type WebhookTransport,
} from './application/ports';
import { NOTIFICATION_STORE } from './application/store';
import { WebhooksService } from './application/webhooks.service';
import {
  AdminController,
  HealthController,
  InboxController,
  InternalController,
  WebhooksController,
} from './http/controllers';
import { PgNotificationStore } from './infrastructure/pg.store';

/** Everything that differs between production and tests is passed in (composition root). */
export interface NotificationSvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  email: EmailSender;
  webhooks: WebhookTransport;
  dns: DnsResolver;
  settings: NotificationSettings;
  hub?: InboxHub;
  logger?: Logger;
}

@Module({})
export class AppModule {
  static register(deps: NotificationSvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        InternalController,
        AdminController,
        WebhooksController,
        InboxController,
        HealthController,
      ],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: EMAIL_SENDER, useValue: deps.email },
        { provide: WEBHOOK_TRANSPORT, useValue: deps.webhooks },
        { provide: DNS_RESOLVER, useValue: deps.dns },
        { provide: NOTIFICATION_SETTINGS, useValue: deps.settings },
        { provide: INBOX_HUB, useValue: deps.hub ?? new InboxHub() },
        { provide: NOTIFICATION_LOGGER, useValue: deps.logger ?? null },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: NOTIFICATION_STORE, useClass: PgNotificationStore },
        Dispatcher,
        EmailWorker,
        WebhooksService,
        AdminService,
        InboxService,
        InternalService,
        NotificationEventHandlers,
      ],
      exports: [NotificationEventHandlers, EmailWorker, WebhooksService],
    };
  }
}

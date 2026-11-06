import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Kafka } from 'kafkajs';
import {
  configureHttpApp,
  createConsumer,
  createLogger,
  JwtVerifier,
  type KafkaClientLike,
  PgDatabase,
  PinoNestLogger,
  runKafkaSource,
  systemClock,
} from '@atlas/platform';
import { AppModule } from './app.module';
import { EmailWorker } from './application/email.worker';
import { NOTIFICATION_CONSUMER, NotificationEventHandlers } from './application/event-handlers';
import { type EmailSender } from './application/ports';
import { WebhooksService } from './application/webhooks.service';
import { loadNotificationSvcConfig } from './config';
import {
  HttpWebhookTransport,
  LogEmailSender,
  NodeDnsResolver,
  SendGridEmailSender,
  SesEmailSender,
  sesClient,
} from './infrastructure/adapters';

async function bootstrap(): Promise<void> {
  const config = loadNotificationSvcConfig();
  const logger = createLogger({ service: 'notification-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'notification-svc',
  });
  const verifier = new JwtVerifier({
    issuer: config.ATLAS_AUTH_ISSUER,
    audience: config.ATLAS_AUTH_AUDIENCE,
    ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
    ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
  });
  const email: EmailSender =
    config.ATLAS_EMAIL_PROVIDER === 'ses'
      ? new SesEmailSender(
          sesClient(config.ATLAS_SES_REGION as string),
          config.ATLAS_SES_CONFIGURATION_SET,
        )
      : config.ATLAS_EMAIL_PROVIDER === 'sendgrid'
        ? new SendGridEmailSender(config.ATLAS_SENDGRID_API_KEY as string)
        : new LogEmailSender(logger);

  const app = await NestFactory.create(
    AppModule.register({
      db,
      clock: systemClock,
      verifier,
      email,
      webhooks: new HttpWebhookTransport(),
      dns: new NodeDnsResolver(),
      settings: {
        defaultFrom: config.ATLAS_EMAIL_DEFAULT_FROM,
        spfInclude: config.ATLAS_EMAIL_SPF_INCLUDE,
        dkimTarget: config.ATLAS_EMAIL_DKIM_TARGET,
        secretKek: Buffer.from(config.ATLAS_NOTIFICATION_SECRET_KEY, 'base64'),
        batchSize: 50,
        leaseMs: 120_000,
        ssePollMs: 10_000,
      },
      logger,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger);
  app.enableShutdownHooks();

  const consumer = createConsumer({
    name: NOTIFICATION_CONSUMER,
    db,
    handlers: app.get(NotificationEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_NOTIFICATION_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'notification-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: NOTIFICATION_CONSUMER,
      deadLetterTopic: 'dlq.notification-svc',
      logger,
    });
  } else {
    logger.warn('no event source: only internal and API sends will happen (dev only)');
  }
  const emails = app.get(EmailWorker);
  const webhooks = app.get(WebhooksService);
  let stopped = false;
  void emails.runForever();
  void (async () => {
    while (!stopped) {
      try {
        if ((await webhooks.runOnce()) === 0) await new Promise((r) => setTimeout(r, 2000));
      } catch (error) {
        logger.error({ err: error }, 'webhook worker pass failed');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  process.on('SIGTERM', () => {
    void (async () => {
      stopped = true;
      emails.stop();
      await source?.stop();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_NOTIFICATION_PORT);
  logger.info({ port: config.ATLAS_NOTIFICATION_PORT }, 'notification-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`notification-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

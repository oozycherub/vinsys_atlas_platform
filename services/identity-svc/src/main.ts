import 'reflect-metadata';
import { KMSClient } from '@aws-sdk/client-kms';
import { NestFactory } from '@nestjs/core';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import { type Logger } from 'pino';
import {
  AwsKmsKeyEncryption,
  configureHttpApp,
  createConsumer,
  createLogger,
  JwtVerifier,
  type KafkaClientLike,
  type KeyEncryption,
  LocalKeyEncryption,
  MemoryRateLimiter,
  PgDatabase,
  PinoNestLogger,
  type RateLimiter,
  RedisRateLimiter,
  runKafkaSource,
  systemClock,
  type TokenVerifier,
} from '@atlas/platform';
import { AppModule, type IdentitySvcDependencies } from './app.module';
import { AdminService } from './application/admin.service';
import { SigningKeyService } from './application/signing-key.service';
import { IDENTITY_CONSUMER, TenantEventHandlers } from './application/tenant-events';
import { type IdentitySvcConfig, loadIdentitySvcConfig } from './config';
import { LogLinkDelivery } from './infrastructure/log-link-delivery';
import { NotificationLinkDelivery } from './infrastructure/notification-link-delivery';

function keyEncryption(config: IdentitySvcConfig): KeyEncryption {
  if (config.ATLAS_IDENTITY_KEK_MODE === 'aws') {
    if (!config.ATLAS_IDENTITY_KMS_KEY_ID)
      throw new Error('ATLAS_IDENTITY_KMS_KEY_ID is required.');
    return new AwsKmsKeyEncryption(new KMSClient({}), config.ATLAS_IDENTITY_KMS_KEY_ID);
  }
  if (!config.ATLAS_IDENTITY_LOCAL_KEK) throw new Error('ATLAS_IDENTITY_LOCAL_KEK is required.');
  return new LocalKeyEncryption(
    config.ATLAS_IDENTITY_KEK_NAME,
    Buffer.from(config.ATLAS_IDENTITY_LOCAL_KEK, 'base64'),
  );
}

function rateLimiter(config: IdentitySvcConfig, logger: Logger): RateLimiter {
  if (config.ATLAS_IDENTITY_RATE_LIMITER === 'redis' && config.ATLAS_REDIS_URL) {
    const redis = new Redis(config.ATLAS_REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', (err: Error) => logger.warn({ err }, 'redis connection error'));
    return new RedisRateLimiter(redis, logger);
  }
  return new MemoryRateLimiter(systemClock);
}

function delivery(config: IdentitySvcConfig, logger: Logger): IdentitySvcDependencies['delivery'] {
  const url = config.ATLAS_NOTIFICATION_URL;
  if (config.ATLAS_IDENTITY_LINK_DELIVERY !== 'notification' || !url)
    return new LogLinkDelivery(logger);
  // identity-svc signs its own short-lived service token for notification-svc.
  return (signer: SigningKeyService) => {
    let cached: { token: string; until: number } | null = null;
    return new NotificationLinkDelivery({
      baseUrl: url,
      logger,
      token: async () => {
        if (cached && Date.now() < cached.until) return cached.token;
        const { token, expiresIn } = await signer.sign({
          subject: 'svc_identity',
          tenantId: null,
          roles: ['service'],
          businessUnitIds: [],
          scopes: ['notifications:send'],
          amr: ['client'],
        });
        cached = { token, until: Date.now() + (expiresIn - 60) * 1000 };
        return token;
      },
    });
  };
}

async function bootstrap(): Promise<void> {
  const config = loadIdentitySvcConfig(); // exits below on invalid config (§4.10)
  const logger = createLogger({ service: 'identity-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'identity-svc',
  });

  const staffVerifiers: TokenVerifier[] = config.ATLAS_AUTH_SHARED_SECRET
    ? [
        new JwtVerifier({
          issuer: config.ATLAS_AUTH_ISSUER,
          audience: config.ATLAS_AUTH_AUDIENCE,
          sharedSecret: config.ATLAS_AUTH_SHARED_SECRET,
        }),
      ]
    : [];
  const staffIdp =
    config.ATLAS_IDENTITY_STAFF_OIDC_ISSUER &&
    config.ATLAS_IDENTITY_STAFF_OIDC_CLIENT_ID &&
    config.ATLAS_IDENTITY_STAFF_OIDC_CLIENT_SECRET
      ? {
          issuer: config.ATLAS_IDENTITY_STAFF_OIDC_ISSUER,
          clientId: config.ATLAS_IDENTITY_STAFF_OIDC_CLIENT_ID,
          clientSecret: config.ATLAS_IDENTITY_STAFF_OIDC_CLIENT_SECRET,
          allowedDomains: config.ATLAS_IDENTITY_STAFF_ALLOWED_DOMAINS ?? [],
        }
      : null;

  const app = await NestFactory.create(
    AppModule.register({
      db,
      clock: systemClock,
      limiter: rateLimiter(config, logger),
      delivery: delivery(config, logger),
      allowInsecureIdp: config.ATLAS_IDENTITY_ALLOW_INSECURE_IDP,
      settings: {
        issuer: config.ATLAS_AUTH_ISSUER,
        audience: config.ATLAS_AUTH_AUDIENCE,
        appBaseUrl: config.ATLAS_IDENTITY_APP_BASE_URL,
        keys: keyEncryption(config),
        oauthClients: Object.fromEntries(
          Object.entries(config.ATLAS_IDENTITY_OAUTH_CLIENTS).map(([id, c]) => [
            id,
            { redirectUris: c.redirect_uris },
          ]),
        ),
        staffIdp,
      },
      staffVerifiers,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger, { bodyLimit: '256kb' }); // SAML responses can be large
  app.enableShutdownHooks();

  // First boot creates a signing key; afterwards this rotates it when 30 days old.
  await app.get(SigningKeyService).ensureCurrent();
  if (config.ATLAS_IDENTITY_STAFF_BOOTSTRAP_EMAIL) {
    await app.get(AdminService).ensureBootstrapStaff(config.ATLAS_IDENTITY_STAFF_BOOTSTRAP_EMAIL);
  }

  const consumer = createConsumer({
    name: IDENTITY_CONSUMER,
    db,
    handlers: app.get(TenantEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_IDENTITY_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'identity-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: IDENTITY_CONSUMER,
      deadLetterTopic: 'dlq.identity-svc',
      logger,
    });
    logger.info({ topics: consumer.topics }, 'consuming tenant events from Kafka');
  } else {
    logger.warn('no event source: tenant status changes will not reach identity-svc (dev only)');
  }

  process.on('SIGTERM', () => {
    void (async () => {
      await source?.stop();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_IDENTITY_PORT);
  logger.info({ port: config.ATLAS_IDENTITY_PORT }, 'identity-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`identity-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

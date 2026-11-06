import 'reflect-metadata';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import { Kafka } from 'kafkajs';
import {
  AwsKmsKeyEncryption,
  ClientCredentialsTokenProvider,
  configureHttpApp,
  createConsumer,
  createLogger,
  HttpWrappedKeySource,
  JwtVerifier,
  type KafkaClientLike,
  type KeyEncryption,
  LocalKeyEncryption,
  PgDatabase,
  PinoNestLogger,
  runKafkaSource,
  systemClock,
  TenantKeyCache,
} from '@atlas/platform';
import { AppModule } from './app.module';
import { PROFILE_CONSUMER, ProfileEventHandlers } from './application/event-handlers';
import { DEFAULT_POLICY } from './domain/fusion';
import { loadProfileSvcConfig, type ProfileSvcConfig } from './config';
import { HttpSkillCatalog } from './infrastructure/skill-catalog';
import { MemoryObjectStorage, S3ObjectStorage } from './infrastructure/storage';

function kek(config: ProfileSvcConfig): KeyEncryption {
  if (config.ATLAS_PROFILE_KEK_MODE === 'aws' && config.ATLAS_PROFILE_KMS_KEY_ID) {
    return new AwsKmsKeyEncryption(new KMSClient({}), config.ATLAS_PROFILE_KMS_KEY_ID);
  }
  if (!config.ATLAS_PROFILE_LOCAL_KEK) throw new Error('ATLAS_PROFILE_LOCAL_KEK is required.');
  return new LocalKeyEncryption(
    config.ATLAS_PROFILE_KEK_NAME,
    Buffer.from(config.ATLAS_PROFILE_LOCAL_KEK, 'base64'),
  );
}

async function bootstrap(): Promise<void> {
  const config = loadProfileSvcConfig(); // exits below on invalid config (§4.10)
  const logger = createLogger({ service: 'profile-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'profile-svc',
  });
  const verifier = new JwtVerifier({
    issuer: config.ATLAS_AUTH_ISSUER,
    audience: config.ATLAS_AUTH_AUDIENCE,
    ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
    ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
  });
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.ATLAS_IDENTITY_TOKEN_URL,
    clientId: config.ATLAS_PROFILE_CLIENT_ID,
    clientSecret: config.ATLAS_PROFILE_CLIENT_SECRET,
    scopes: ['tenant-keys:read'],
  });
  const token = () => tokens.token();
  const keys = new TenantKeyCache(
    new HttpWrappedKeySource({ baseUrl: config.ATLAS_TENANT_SVC_URL, token }),
    kek(config),
  );
  const storage =
    config.ATLAS_PROFILE_STORAGE === 's3' && config.ATLAS_PROFILE_S3_BUCKET
      ? new S3ObjectStorage(
          new S3Client({
            ...(config.ATLAS_PROFILE_S3_ENDPOINT
              ? { endpoint: config.ATLAS_PROFILE_S3_ENDPOINT, forcePathStyle: true }
              : {}),
          }),
          config.ATLAS_PROFILE_S3_BUCKET,
        )
      : new MemoryObjectStorage();

  const app = await NestFactory.create(
    AppModule.register({
      db,
      clock: systemClock,
      verifier,
      keys,
      storage,
      skills: new HttpSkillCatalog({ baseUrl: config.ATLAS_TAXONOMY_SVC_URL, token }),
      settings: {
        erasureConsumers: config.ATLAS_PROFILE_ERASURE_CONSUMERS,
        retentionInactiveDays: config.ATLAS_PROFILE_RETENTION_DAYS,
        fusionPolicy: DEFAULT_POLICY,
      },
      logger,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger, { bodyLimit: '512kb' });
  app.enableShutdownHooks();

  const consumer = createConsumer({
    name: PROFILE_CONSUMER,
    db,
    handlers: app.get(ProfileEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_PROFILE_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'profile-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: PROFILE_CONSUMER,
      deadLetterTopic: 'dlq.profile-svc',
      logger,
    });
  } else {
    logger.warn('no event source: parsing, assessment and purge events will not arrive (dev only)');
  }

  process.on('SIGTERM', () => {
    void (async () => {
      await source?.stop();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_PROFILE_PORT);
  logger.info({ port: config.ATLAS_PROFILE_PORT }, 'profile-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`profile-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

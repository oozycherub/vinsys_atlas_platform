import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Kafka } from 'kafkajs';
import {
  ClientCredentialsTokenProvider,
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
import { type EmbeddingPort } from './application/ports';
import { TAXONOMY_CONSUMER, TenantEventHandlers } from './application/tenant-events';
import { loadTaxonomySvcConfig, type TaxonomySvcConfig } from './config';
import { GatewayEmbeddingClient, HashingEmbeddingStub } from './infrastructure/embeddings';

function embeddings(config: TaxonomySvcConfig): EmbeddingPort {
  if (config.ATLAS_TAXONOMY_EMBEDDINGS !== 'gateway') return new HashingEmbeddingStub();
  const { ATLAS_LLM_GATEWAY_URL: url, ATLAS_IDENTITY_TOKEN_URL: tokenUrl } = config;
  const { ATLAS_TAXONOMY_CLIENT_ID: clientId, ATLAS_TAXONOMY_CLIENT_SECRET: clientSecret } = config;
  if (!url || !tokenUrl || !clientId || !clientSecret)
    throw new Error('Gateway settings are incomplete.');
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl,
    clientId,
    clientSecret,
    scopes: ['embeddings:create'],
  });
  return new GatewayEmbeddingClient({ baseUrl: url, token: () => tokens.token() });
}

async function bootstrap(): Promise<void> {
  const config = loadTaxonomySvcConfig(); // exits below on invalid config (§4.10)
  const logger = createLogger({ service: 'taxonomy-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'taxonomy-svc',
  });
  const verifier = new JwtVerifier({
    issuer: config.ATLAS_AUTH_ISSUER,
    audience: config.ATLAS_AUTH_AUDIENCE,
    ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
    ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
  });

  const app = await NestFactory.create(
    AppModule.register({
      db,
      clock: systemClock,
      verifier,
      embeddings: embeddings(config),
      logger,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger, { bodyLimit: '256kb' });
  app.enableShutdownHooks();

  const consumer = createConsumer({
    name: TAXONOMY_CONSUMER,
    db,
    handlers: app.get(TenantEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_TAXONOMY_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'taxonomy-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: TAXONOMY_CONSUMER,
      deadLetterTopic: 'dlq.taxonomy-svc',
      logger,
    });
  } else {
    logger.warn('no event source: tenant purges will not reach taxonomy-svc (dev only)');
  }

  process.on('SIGTERM', () => {
    void (async () => {
      await source?.stop();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_TAXONOMY_PORT);
  logger.info({ port: config.ATLAS_TAXONOMY_PORT }, 'taxonomy-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`taxonomy-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

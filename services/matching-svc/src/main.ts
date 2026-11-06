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
import { MATCHING_CONSUMER, MatchingEventHandlers } from './application/event-handlers';
import { DEFAULT_MATCHING_SETTINGS } from './application/ports';
import { RescoreWorker } from './application/worker';
import { loadMatchingSvcConfig } from './config';
import { MemoryMatchCache } from './infrastructure/cache';
import {
  GatewayEmbedder,
  HttpTaxonomy,
  ParsingVectorSearch,
  TenantWeights,
} from './infrastructure/clients';
import { OpenSearchLexicalIndex, PgLexicalIndex } from './infrastructure/lexical';

async function bootstrap(): Promise<void> {
  const config = loadMatchingSvcConfig();
  const logger = createLogger({ service: 'matching-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'matching-svc',
  });
  const verifier = new JwtVerifier({
    issuer: config.ATLAS_AUTH_ISSUER,
    audience: config.ATLAS_AUTH_AUDIENCE,
    ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
    ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
  });
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.ATLAS_IDENTITY_TOKEN_URL,
    clientId: config.ATLAS_MATCHING_CLIENT_ID,
    clientSecret: config.ATLAS_MATCHING_CLIENT_SECRET,
    scopes: ['embeddings:create', 'embeddings:search', 'tenant-settings:read'],
  });
  const token = () => tokens.token();

  const app = await NestFactory.create(
    AppModule.register({
      db,
      clock: systemClock,
      verifier,
      vectors: new ParsingVectorSearch({ baseUrl: config.ATLAS_PARSING_SVC_URL, token }),
      embedder: new GatewayEmbedder({
        baseUrl: config.ATLAS_LLM_GATEWAY_URL,
        token,
        timeoutMs: 10_000,
      }),
      taxonomy: new HttpTaxonomy({ baseUrl: config.ATLAS_TAXONOMY_SVC_URL, token }),
      weights: new TenantWeights({ baseUrl: config.ATLAS_TENANT_SVC_URL, token }),
      lexical:
        config.ATLAS_MATCHING_LEXICAL === 'opensearch' && config.ATLAS_OPENSEARCH_URL
          ? new OpenSearchLexicalIndex(config.ATLAS_OPENSEARCH_URL)
          : new PgLexicalIndex(db),
      cache: new MemoryMatchCache(),
      settings: {
        ...DEFAULT_MATCHING_SETTINGS,
        cacheTtlSeconds: config.ATLAS_MATCHING_CACHE_TTL_SECONDS,
      },
      logger,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger, { bodyLimit: '256kb' });
  app.enableShutdownHooks();

  const consumer = createConsumer({
    name: MATCHING_CONSUMER,
    db,
    handlers: app.get(MatchingEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_MATCHING_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'matching-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: MATCHING_CONSUMER,
      deadLetterTopic: 'dlq.matching-svc',
      logger,
    });
  } else {
    logger.warn('no event source: profile and taxonomy changes will not re-score (dev only)');
  }
  void app.get(RescoreWorker).runForever();

  process.on('SIGTERM', () => {
    void (async () => {
      await source?.stop();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_MATCHING_PORT);
  logger.info({ port: config.ATLAS_MATCHING_PORT }, 'matching-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`matching-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

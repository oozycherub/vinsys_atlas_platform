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
import { INTEL_CONSUMER, IntelEventHandlers } from './application/event-handlers';
import { DEFAULT_INTEL_SETTINGS } from './application/ports';
import { IntelWorker } from './application/worker';
import { loadIntelligenceSvcConfig } from './config';
import { GatewayEmbedder, HttpTaxonomy, ParsingVectorSearch } from './infrastructure/clients';
import { ExcelDemandSheets } from './infrastructure/sheets';

async function bootstrap(): Promise<void> {
  const config = loadIntelligenceSvcConfig();
  const logger = createLogger({ service: 'intelligence-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'intelligence-svc',
  });
  const verifier = new JwtVerifier({
    issuer: config.ATLAS_AUTH_ISSUER,
    audience: config.ATLAS_AUTH_AUDIENCE,
    ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
    ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
  });
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.ATLAS_IDENTITY_TOKEN_URL,
    clientId: config.ATLAS_INTELLIGENCE_CLIENT_ID,
    clientSecret: config.ATLAS_INTELLIGENCE_CLIENT_SECRET,
    scopes: ['embeddings:create', 'embeddings:search'],
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
      sheets: new ExcelDemandSheets(),
      settings: DEFAULT_INTEL_SETTINGS,
      logger,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  // Demand sheets arrive base64-encoded in JSON (5 MB of file, ~6.7 MB encoded).
  configureHttpApp(app, logger, { bodyLimit: '8mb' });
  app.enableShutdownHooks();

  const consumer = createConsumer({
    name: INTEL_CONSUMER,
    db,
    handlers: app.get(IntelEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_INTELLIGENCE_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'intelligence-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: INTEL_CONSUMER,
      deadLetterTopic: 'dlq.intelligence-svc',
      logger,
    });
  } else {
    logger.warn('no event source: skills and job-profile changes will not re-score (dev only)');
  }
  const worker = app.get(IntelWorker);
  void worker.runForever();

  process.on('SIGTERM', () => {
    void (async () => {
      worker.stop();
      await source?.stop();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_INTELLIGENCE_PORT);
  logger.info({ port: config.ATLAS_INTELLIGENCE_PORT }, 'intelligence-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`intelligence-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

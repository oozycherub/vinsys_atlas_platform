import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Kafka } from 'kafkajs';
import { chromium } from 'playwright-core';
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
import { REPORT_CONSUMER, ReportEventHandlers } from './application/event-handlers';
import { type Lakehouse, UpstreamError } from './application/ports';
import { ReportWorker } from './application/report.worker';
import { loadReportSvcConfig } from './config';
import {
  ChromiumPdfRenderer,
  FsArtifactStore,
  HttpDirectory,
  HttpProctoringEvidence,
  S3ArtifactStore,
  s3Client,
  TrinoLakehouse,
} from './infrastructure/adapters';

async function bootstrap(): Promise<void> {
  const config = loadReportSvcConfig();
  const logger = createLogger({ service: 'report-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'report-svc',
  });
  const verifier = new JwtVerifier({
    issuer: config.ATLAS_AUTH_ISSUER,
    audience: config.ATLAS_AUTH_AUDIENCE,
    ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
    ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
  });
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.ATLAS_IDENTITY_TOKEN_URL,
    clientId: config.ATLAS_REPORT_CLIENT_ID,
    clientSecret: config.ATLAS_REPORT_CLIENT_SECRET,
    scopes: ['candidates:read', 'skills:read', 'proctoring:evidence:read'],
  });
  const token = () => tokens.token();
  const pdf = new ChromiumPdfRenderer(
    () =>
      chromium.launch({
        headless: true,
        ...(config.ATLAS_CHROMIUM_PATH ? { executablePath: config.ATLAS_CHROMIUM_PATH } : {}),
      }),
    config.ATLAS_PDF_CONCURRENCY,
  );
  const lakehouse: Lakehouse = config.ATLAS_TRINO_URL
    ? new TrinoLakehouse({
        baseUrl: config.ATLAS_TRINO_URL,
        user: 'report-svc',
        catalog: config.ATLAS_TRINO_CATALOG,
      })
    : { query: () => Promise.reject(new UpstreamError('no lakehouse configured')) };

  const app = await NestFactory.create(
    AppModule.register({
      db,
      clock: systemClock,
      verifier,
      pdf,
      artifacts:
        config.ATLAS_REPORT_STORAGE === 's3'
          ? new S3ArtifactStore(
              s3Client(config.ATLAS_REPORT_S3_REGION as string, config.ATLAS_REPORT_S3_ENDPOINT),
              config.ATLAS_REPORT_S3_BUCKET as string,
              config.ATLAS_REPORT_S3_KMS_KEY_ID,
            )
          : new FsArtifactStore(config.ATLAS_REPORT_FS_ROOT),
      lakehouse,
      directory: new HttpDirectory(
        { baseUrl: config.ATLAS_PROFILE_SVC_URL, token },
        { baseUrl: config.ATLAS_TAXONOMY_SVC_URL, token },
      ),
      evidence: new HttpProctoringEvidence({ baseUrl: config.ATLAS_PROCTORING_SVC_URL, token }),
      settings: {
        publicBaseUrl: config.ATLAS_REPORT_PUBLIC_URL,
        linkKey: Buffer.from(config.ATLAS_REPORT_LINK_KEY, 'base64'),
        linkTtlMs: 15 * 60_000,
        artifactRetentionMs: config.ATLAS_REPORT_RETENTION_DAYS * 86_400_000,
        batchSize: config.ATLAS_PDF_CONCURRENCY,
        leaseMs: 5 * 60_000,
        maxAttempts: 3,
      },
      logger,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger);
  app.enableShutdownHooks();

  const consumer = createConsumer({
    name: REPORT_CONSUMER,
    db,
    handlers: app.get(ReportEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_REPORT_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'report-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: REPORT_CONSUMER,
      deadLetterTopic: 'dlq.report-svc',
      logger,
    });
  } else {
    logger.warn('no event source: report data will not update (dev only)');
  }
  const worker = app.get(ReportWorker);
  void worker.runForever();

  process.on('SIGTERM', () => {
    void (async () => {
      worker.stop();
      await source?.stop();
      await pdf.close();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_REPORT_PORT);
  logger.info({ port: config.ATLAS_REPORT_PORT }, 'report-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`report-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

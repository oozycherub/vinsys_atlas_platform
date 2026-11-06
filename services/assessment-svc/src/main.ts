import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import {
  ClientCredentialsTokenProvider,
  configureHttpApp,
  createConsumer,
  createLogger,
  JwtVerifier,
  type KafkaClientLike,
  MemoryRateLimiter,
  PgDatabase,
  PinoNestLogger,
  type RateLimiter,
  RedisRateLimiter,
  runKafkaSource,
  systemClock,
} from '@atlas/platform';
import { AppModule } from './app.module';
import { ASSESSMENT_CONSUMER, AssessmentEventHandlers } from './application/event-handlers';
import { DEFAULT_ASSESSMENT_SETTINGS } from './application/ports';
import { ResultsService } from './application/results.service';
import { loadAssessmentSvcConfig } from './config';
import { HttpProfileDirectory } from './infrastructure/profile-directory';
import { HttpInterviewGateway } from './infrastructure/interview-gateway';
import { HttpProctoringGateway } from './infrastructure/proctoring-gateway';
import { HttpSandboxGateway } from './infrastructure/sandbox-gateway';

async function bootstrap(): Promise<void> {
  const config = loadAssessmentSvcConfig();
  const logger = createLogger({ service: 'assessment-svc', level: config.ATLAS_LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'assessment-svc',
  });
  const verifier = new JwtVerifier({
    issuer: config.ATLAS_AUTH_ISSUER,
    audience: config.ATLAS_AUTH_AUDIENCE,
    ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
    ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
  });
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.ATLAS_IDENTITY_TOKEN_URL,
    clientId: config.ATLAS_ASSESSMENT_CLIENT_ID,
    clientSecret: config.ATLAS_ASSESSMENT_CLIENT_SECRET,
    scopes: [
      'pii:read',
      'sandbox:execute',
      'sandbox:bundles',
      'proctoring:sessions',
      'interviews:sessions',
    ],
  });
  const limiter: RateLimiter = config.ATLAS_REDIS_URL
    ? new RedisRateLimiter(
        new Redis(config.ATLAS_REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false }),
        logger,
      )
    : new MemoryRateLimiter(systemClock);

  const app = await NestFactory.create(
    AppModule.register({
      db,
      clock: systemClock,
      verifier,
      limiter,
      profiles: new HttpProfileDirectory({
        baseUrl: config.ATLAS_PROFILE_SVC_URL,
        token: () => tokens.token(),
      }),
      sandbox: new HttpSandboxGateway({
        baseUrl: config.ATLAS_SANDBOX_SVC_URL,
        token: () => tokens.token(),
      }),
      proctoring: new HttpProctoringGateway({
        baseUrl: config.ATLAS_PROCTORING_SVC_URL,
        token: () => tokens.token(),
      }),
      interviews: new HttpInterviewGateway({
        baseUrl: config.ATLAS_INTERVIEW_SVC_URL,
        token: () => tokens.token(),
      }),
      settings: {
        ...DEFAULT_ASSESSMENT_SETTINGS,
        inviteBaseUrl: config.ATLAS_ASSESSMENT_INVITE_BASE_URL,
        sessionRateLimit: config.ATLAS_ASSESSMENT_SESSION_RPS,
      },
      logger,
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger, { bodyLimit: '512kb' });
  app.enableShutdownHooks();

  const consumer = createConsumer({
    name: ASSESSMENT_CONSUMER,
    db,
    handlers: app.get(AssessmentEventHandlers).handlers(),
    logger,
  });
  let source: { stop(): Promise<void> } | null = null;
  if (config.ATLAS_ASSESSMENT_EVENT_SOURCE === 'kafka' && config.ATLAS_KAFKA_BROKERS) {
    const kafka = new Kafka({ clientId: 'assessment-svc', brokers: config.ATLAS_KAFKA_BROKERS });
    source = await runKafkaSource(kafka as unknown as KafkaClientLike, consumer, {
      groupId: ASSESSMENT_CONSUMER,
      deadLetterTopic: 'dlq.assessment-svc',
      logger,
    });
  } else {
    logger.warn('no event source: judge, proctoring and erasure events will not arrive (dev only)');
  }
  void app.get(ResultsService).runForever();

  process.on('SIGTERM', () => {
    void (async () => {
      await source?.stop();
      await db.close();
    })();
  });

  await app.listen(config.ATLAS_ASSESSMENT_PORT);
  logger.info({ port: config.ATLAS_ASSESSMENT_PORT }, 'assessment-svc listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`assessment-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

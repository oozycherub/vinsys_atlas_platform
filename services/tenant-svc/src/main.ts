import 'reflect-metadata';
import { KMSClient } from '@aws-sdk/client-kms';
import { NestFactory } from '@nestjs/core';
import {
  AwsKmsKeyEncryption,
  LocalKeyEncryption,
  configureHttpApp,
  createLogger,
  JwtVerifier,
  PgDatabase,
  PinoNestLogger,
  systemClock,
} from '@atlas/platform';
import { AppModule } from './app.module';
import { loadTenantSvcConfig } from './config';
import { type KeyManagementPort } from './application/ports';
import { KmsKeyManagement } from './infrastructure/kms-key-management';

async function bootstrap(): Promise<void> {
  const config = loadTenantSvcConfig(); // exits below on invalid config (§4.10)
  const logger = createLogger({ service: 'tenant-svc', level: config.ATLAS_LOG_LEVEL });

  const db = new PgDatabase({
    connectionString: config.ATLAS_DATABASE_URL,
    applicationName: 'tenant-svc',
  });
  const kms = buildKeyManagement(config);
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
      kms,
      settings: {
        cells: config.ATLAS_TENANT_CELLS,
        kmsKeyRef: kms.keyRef,
        purgeGraceDays: config.ATLAS_TENANT_PURGE_GRACE_DAYS,
      },
    }),
    { logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  configureHttpApp(app, logger);
  app.enableShutdownHooks();
  process.on('SIGTERM', () => void db.close());

  await app.listen(config.ATLAS_TENANT_PORT);
  logger.info({ port: config.ATLAS_TENANT_PORT }, 'tenant-svc listening');
}

function buildKeyManagement(
  config: ReturnType<typeof loadTenantSvcConfig>,
): KeyManagementPort & { keyRef: string } {
  if (config.ATLAS_TENANT_KMS_MODE === 'aws') {
    if (!config.ATLAS_TENANT_KMS_KEY_ID) throw new Error('ATLAS_TENANT_KMS_KEY_ID is required.');
    return new KmsKeyManagement(
      new AwsKmsKeyEncryption(new KMSClient({}), config.ATLAS_TENANT_KMS_KEY_ID),
    );
  }
  if (!config.ATLAS_TENANT_LOCAL_KEK) throw new Error('ATLAS_TENANT_LOCAL_KEK is required.');
  return new KmsKeyManagement(
    new LocalKeyEncryption(
      config.ATLAS_TENANT_KMS_KEY_NAME,
      Buffer.from(config.ATLAS_TENANT_LOCAL_KEK, 'base64'),
    ),
  );
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`tenant-svc failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

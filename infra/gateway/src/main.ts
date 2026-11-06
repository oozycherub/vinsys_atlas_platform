import path from 'node:path';
import Redis from 'ioredis';
import {
  ClientCredentialsTokenProvider,
  createLogger,
  JwtVerifier,
  MemoryRateLimiter,
  type RateLimiter,
  RedisRateLimiter,
  systemClock,
} from '@atlas/platform';
import { loadGatewayConfig } from './config';
import { Edge } from './edge';
import { createGatewayServer } from './proxy';
import { HttpDirectorySource, TenantResolver } from './resolver';
import { loadRouteMap } from './route-map';

function main(): void {
  const config = loadGatewayConfig();
  const logger = createLogger({ service: 'gateway', level: config.ATLAS_LOG_LEVEL });
  const routes = loadRouteMap(path.resolve(__dirname, '..', config.ATLAS_GATEWAY_ROUTES));
  const tokens = new ClientCredentialsTokenProvider({
    tokenUrl: config.ATLAS_IDENTITY_TOKEN_URL,
    clientId: config.ATLAS_GATEWAY_CLIENT_ID,
    clientSecret: config.ATLAS_GATEWAY_CLIENT_SECRET,
    scopes: ['tenant-directory:read'],
  });
  const limiter: RateLimiter = config.ATLAS_REDIS_URL
    ? new RedisRateLimiter(
        new Redis(config.ATLAS_REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
        logger,
      )
    : new MemoryRateLimiter(systemClock);
  const edge = new Edge({
    routes,
    resolver: new TenantResolver(
      new HttpDirectorySource({
        baseUrl: config.ATLAS_TENANT_SVC_URL,
        token: () => tokens.token(),
      }),
      systemClock,
    ),
    verifier: new JwtVerifier({
      issuer: config.ATLAS_AUTH_ISSUER,
      audience: config.ATLAS_AUTH_AUDIENCE,
      ...(config.ATLAS_AUTH_JWKS_URL ? { jwksUrl: config.ATLAS_AUTH_JWKS_URL } : {}),
      ...(config.ATLAS_AUTH_SHARED_SECRET ? { sharedSecret: config.ATLAS_AUTH_SHARED_SECRET } : {}),
    }),
    limiter,
    baseDomain: config.ATLAS_GATEWAY_BASE_DOMAIN,
    limits: {
      pooled: config.ATLAS_GATEWAY_RPM_POOLED,
      dedicated: config.ATLAS_GATEWAY_RPM_DEDICATED,
      anonymous: config.ATLAS_GATEWAY_RPM_ANONYMOUS,
    },
    logger,
  });
  const server = createGatewayServer(edge, logger);
  server.listen(config.ATLAS_GATEWAY_PORT, () =>
    logger.info({ port: config.ATLAS_GATEWAY_PORT, routes: routes.version }, 'gateway listening'),
  );
  process.on('SIGTERM', () => server.close());
}

main();

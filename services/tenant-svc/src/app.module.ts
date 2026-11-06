import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AuthGuard,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '@atlas/platform';
import {
  KEY_MANAGEMENT,
  type KeyManagementPort,
  TENANT_REPOSITORY,
  TENANT_SERVICE_SETTINGS,
  type TenantServiceSettings,
} from './application/ports';
import { TenantService } from './application/tenant.service';
import { DataKeysController } from './http/data-keys.controller';
import { DirectoryController, HealthController } from './http/directory.controller';
import { TenantsController } from './http/tenants.controller';
import { PgTenantRepository } from './infrastructure/pg-tenant.repository';

/** Everything that differs between production and tests is passed in (composition root). */
export interface TenantSvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  kms: KeyManagementPort;
  settings: TenantServiceSettings;
}

@Module({})
export class AppModule {
  static register(deps: TenantSvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [TenantsController, DataKeysController, DirectoryController, HealthController],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: KEY_MANAGEMENT, useValue: deps.kms },
        { provide: TENANT_SERVICE_SETTINGS, useValue: deps.settings },
        { provide: TENANT_REPOSITORY, useClass: PgTenantRepository },
        { provide: APP_GUARD, useClass: AuthGuard },
        TenantService,
      ],
    };
  }
}

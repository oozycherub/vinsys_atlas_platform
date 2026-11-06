import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { type Logger } from 'pino';
import {
  AuthGuard,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '@atlas/platform';
import { AttritionService } from './application/attrition.service';
import { CatalogueService } from './application/catalogue.service';
import { DemandService } from './application/demand.service';
import { IntelEventHandlers } from './application/event-handlers';
import { MarketplaceService } from './application/marketplace.service';
import { Matcher } from './application/matcher';
import {
  ATTRITION_REPOSITORY,
  CATALOGUE_REPOSITORY,
  DEMAND_REPOSITORY,
  DEMAND_SHEETS,
  type DemandSheets,
  EMBEDDER,
  type Embedder,
  EMPLOYEE_REPOSITORY,
  INTEL_LOGGER,
  INTEL_SETTINGS,
  type IntelSettings,
  OPPORTUNITY_REPOSITORY,
  PROJECT_REPOSITORY,
  TAXONOMY,
  type Taxonomy,
  VECTOR_SEARCH,
  type VectorSearch,
  WORK_QUEUE,
} from './application/ports';
import { IntelWorker } from './application/worker';
import { WorkforceService } from './application/workforce.service';
import {
  HealthController,
  MarketplaceController,
  PlanningController,
  WorkforceController,
} from './http/controllers';
import {
  PgAttritionRepository,
  PgCatalogueRepository,
  PgDemandRepository,
  PgEmployeeRepository,
  PgOpportunityRepository,
  PgProjectRepository,
  PgWorkQueue,
} from './infrastructure/pg.repositories';

/** Everything that differs between production and tests is passed in (composition root). */
export interface IntelligenceSvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  vectors: VectorSearch;
  embedder: Embedder;
  taxonomy: Taxonomy;
  sheets: DemandSheets;
  settings: IntelSettings;
  logger?: Logger;
}

@Module({})
export class AppModule {
  static register(deps: IntelligenceSvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        WorkforceController,
        MarketplaceController,
        PlanningController,
        HealthController,
      ],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: VECTOR_SEARCH, useValue: deps.vectors },
        { provide: EMBEDDER, useValue: deps.embedder },
        { provide: TAXONOMY, useValue: deps.taxonomy },
        { provide: DEMAND_SHEETS, useValue: deps.sheets },
        { provide: INTEL_SETTINGS, useValue: deps.settings },
        { provide: INTEL_LOGGER, useValue: deps.logger ?? null },
        { provide: EMPLOYEE_REPOSITORY, useClass: PgEmployeeRepository },
        { provide: CATALOGUE_REPOSITORY, useClass: PgCatalogueRepository },
        { provide: OPPORTUNITY_REPOSITORY, useClass: PgOpportunityRepository },
        { provide: PROJECT_REPOSITORY, useClass: PgProjectRepository },
        { provide: DEMAND_REPOSITORY, useClass: PgDemandRepository },
        { provide: ATTRITION_REPOSITORY, useClass: PgAttritionRepository },
        { provide: WORK_QUEUE, useClass: PgWorkQueue },
        { provide: APP_GUARD, useClass: AuthGuard },
        WorkforceService,
        CatalogueService,
        MarketplaceService,
        DemandService,
        AttritionService,
        Matcher,
        IntelWorker,
        IntelEventHandlers,
      ],
      exports: [IntelEventHandlers, IntelWorker],
    };
  }
}

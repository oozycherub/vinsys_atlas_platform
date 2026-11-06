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
import { ImportService, SPREADSHEET_PARSER } from './application/import.service';
import { JobService } from './application/job.service';
import { NormalizeService } from './application/normalize.service';
import {
  EDGE_REPOSITORY,
  EMBEDDING_PORT,
  type EmbeddingPort,
  IMPORT_REPOSITORY,
  JOB_REPOSITORY,
  OVERRIDE_REPOSITORY,
  PURGE_REPOSITORY,
  SKILL_REPOSITORY,
  SUGGESTION_REPOSITORY,
  VERSION_REPOSITORY,
} from './application/ports';
import { SkillService } from './application/skill.service';
import { TAXONOMY_LOGGER, TenantEventHandlers } from './application/tenant-events';
import { JobsController } from './http/jobs.controller';
import { HealthController, SkillsController, TaxonomyController } from './http/skills.controller';
import {
  PgImportRepository,
  PgJobRepository,
  PgPurgeRepository,
  PgSuggestionRepository,
  PgVersionRepository,
} from './infrastructure/pg-misc.repository';
import {
  PgEdgeRepository,
  PgOverrideRepository,
  PgSkillRepository,
} from './infrastructure/pg-skills.repository';
import { TaxonomySpreadsheetParser } from './infrastructure/spreadsheet-parser';

/** Everything that differs between production and tests is passed in (composition root). */
export interface TaxonomySvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  embeddings: EmbeddingPort;
  logger?: Logger;
}

@Module({})
export class AppModule {
  static register(deps: TaxonomySvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [SkillsController, TaxonomyController, JobsController, HealthController],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: EMBEDDING_PORT, useValue: deps.embeddings },
        { provide: TAXONOMY_LOGGER, useValue: deps.logger ?? null },
        { provide: SKILL_REPOSITORY, useClass: PgSkillRepository },
        { provide: EDGE_REPOSITORY, useClass: PgEdgeRepository },
        { provide: OVERRIDE_REPOSITORY, useClass: PgOverrideRepository },
        { provide: SUGGESTION_REPOSITORY, useClass: PgSuggestionRepository },
        { provide: VERSION_REPOSITORY, useClass: PgVersionRepository },
        { provide: IMPORT_REPOSITORY, useClass: PgImportRepository },
        { provide: JOB_REPOSITORY, useClass: PgJobRepository },
        { provide: PURGE_REPOSITORY, useClass: PgPurgeRepository },
        { provide: SPREADSHEET_PARSER, useClass: TaxonomySpreadsheetParser },
        { provide: APP_GUARD, useClass: AuthGuard },
        SkillService,
        NormalizeService,
        ImportService,
        JobService,
        TenantEventHandlers,
      ],
      exports: [TenantEventHandlers],
    };
  }
}

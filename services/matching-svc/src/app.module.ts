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
import { MatchingEventHandlers } from './application/event-handlers';
import { MatchService } from './application/match.service';
import {
  EMBEDDER,
  type Embedder,
  FEATURE_REPOSITORY,
  LEXICAL_INDEX,
  type LexicalIndex,
  MATCH_CACHE,
  type MatchCache,
  MATCHING_LOGGER,
  MATCHING_SETTINGS,
  type MatchingSettings,
  REQUISITION_REPOSITORY,
  SCORE_REPOSITORY,
  TAXONOMY,
  type Taxonomy,
  VECTOR_SEARCH,
  type VectorSearch,
  WEIGHTS_SOURCE,
  type WeightsSource,
  WORK_QUEUE,
} from './application/ports';
import { RequisitionService } from './application/requisition.service';
import { RescoreWorker } from './application/worker';
import { HealthController, RequisitionsController } from './http/controllers';
import {
  PgFeatureRepository,
  PgRequisitionRepository,
  PgScoreRepository,
  PgWorkQueue,
} from './infrastructure/pg.repositories';

/** Everything that differs between production and tests is passed in (composition root). */
export interface MatchingSvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  vectors: VectorSearch;
  embedder: Embedder;
  taxonomy: Taxonomy;
  weights: WeightsSource;
  lexical: LexicalIndex;
  cache: MatchCache;
  settings: MatchingSettings;
  logger?: Logger;
}

@Module({})
export class AppModule {
  static register(deps: MatchingSvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [RequisitionsController, HealthController],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: VECTOR_SEARCH, useValue: deps.vectors },
        { provide: EMBEDDER, useValue: deps.embedder },
        { provide: TAXONOMY, useValue: deps.taxonomy },
        { provide: WEIGHTS_SOURCE, useValue: deps.weights },
        { provide: LEXICAL_INDEX, useValue: deps.lexical },
        { provide: MATCH_CACHE, useValue: deps.cache },
        { provide: MATCHING_SETTINGS, useValue: deps.settings },
        { provide: MATCHING_LOGGER, useValue: deps.logger ?? null },
        { provide: REQUISITION_REPOSITORY, useClass: PgRequisitionRepository },
        { provide: FEATURE_REPOSITORY, useClass: PgFeatureRepository },
        { provide: SCORE_REPOSITORY, useClass: PgScoreRepository },
        { provide: WORK_QUEUE, useClass: PgWorkQueue },
        { provide: APP_GUARD, useClass: AuthGuard },
        RequisitionService,
        MatchService,
        RescoreWorker,
        MatchingEventHandlers,
      ],
      exports: [MatchingEventHandlers, RescoreWorker],
    };
  }
}

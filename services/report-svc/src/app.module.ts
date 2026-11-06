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
import { ReportEventHandlers } from './application/event-handlers';
import {
  ARTIFACT_STORE,
  type ArtifactStore,
  DIRECTORY,
  type Directory,
  LAKEHOUSE,
  type Lakehouse,
  PDF_RENDERER,
  type PdfRenderer,
  PROCTORING_EVIDENCE,
  type ProctoringEvidence,
  REPORT_LOGGER,
  REPORT_SETTINGS,
  type ReportSettings,
} from './application/ports';
import { ReportWorker } from './application/report.worker';
import { ReportsService } from './application/reports.service';
import { REPORT_STORE } from './application/store';
import { HealthController, ReportsController } from './http/controllers';
import { PgReportStore } from './infrastructure/pg.store';

export interface ReportSvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  pdf: PdfRenderer;
  artifacts: ArtifactStore;
  lakehouse: Lakehouse;
  directory: Directory;
  evidence: ProctoringEvidence;
  settings: ReportSettings;
  logger?: Logger;
}

@Module({})
export class AppModule {
  static register(deps: ReportSvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [ReportsController, HealthController],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: PDF_RENDERER, useValue: deps.pdf },
        { provide: ARTIFACT_STORE, useValue: deps.artifacts },
        { provide: LAKEHOUSE, useValue: deps.lakehouse },
        { provide: DIRECTORY, useValue: deps.directory },
        { provide: PROCTORING_EVIDENCE, useValue: deps.evidence },
        { provide: REPORT_SETTINGS, useValue: deps.settings },
        { provide: REPORT_LOGGER, useValue: deps.logger ?? null },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: REPORT_STORE, useClass: PgReportStore },
        ReportsService,
        ReportWorker,
        ReportEventHandlers,
      ],
      exports: [ReportEventHandlers, ReportWorker],
    };
  }
}

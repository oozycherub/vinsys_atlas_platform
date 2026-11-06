import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { type Logger } from 'pino';
import {
  AuthGuard,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  RATE_LIMITER,
  type RateLimiter,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '@atlas/platform';
import { AuthoringService } from './application/authoring.service';
import { CodingDispatcher } from './application/coding-dispatch.service';
import { EvaluationService } from './application/evaluation.service';
import { AssessmentEventHandlers } from './application/event-handlers';
import {
  ASSESSMENT_LOGGER,
  ASSESSMENT_REPOSITORY,
  ASSESSMENT_SETTINGS,
  type AssessmentServiceSettings,
  INTERVIEW_GATEWAY,
  type InterviewGateway,
  INVITE_REPOSITORY,
  PROFILE_DIRECTORY,
  type ProfileDirectory,
  PROCTORING_GATEWAY,
  type ProctoringGateway,
  SANDBOX_GATEWAY,
  type SandboxGateway,
  QUESTION_REPOSITORY,
  RESPONSE_REPOSITORY,
  REVIEW_REPOSITORY,
  SESSION_REPOSITORY,
} from './application/ports';
import { ResultsService } from './application/results.service';
import { RuntimeService } from './application/runtime.service';
import {
  AuthoringController,
  HealthController,
  ResultsController,
  RuntimeController,
} from './http/controllers';
import {
  PgAssessmentRepository,
  PgInviteRepository,
  PgQuestionRepository,
  PgResponseRepository,
  PgReviewRepository,
  PgSessionRepository,
} from './infrastructure/pg.repositories';

export interface AssessmentSvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  limiter: RateLimiter;
  profiles: ProfileDirectory;
  sandbox: SandboxGateway;
  proctoring: ProctoringGateway;
  interviews: InterviewGateway;
  settings: AssessmentServiceSettings;
  logger?: Logger;
}

@Module({})
export class AppModule {
  static register(deps: AssessmentSvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthoringController, ResultsController, RuntimeController, HealthController],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: RATE_LIMITER, useValue: deps.limiter },
        { provide: PROFILE_DIRECTORY, useValue: deps.profiles },
        { provide: SANDBOX_GATEWAY, useValue: deps.sandbox },
        { provide: PROCTORING_GATEWAY, useValue: deps.proctoring },
        { provide: INTERVIEW_GATEWAY, useValue: deps.interviews },
        { provide: ASSESSMENT_SETTINGS, useValue: deps.settings },
        { provide: ASSESSMENT_LOGGER, useValue: deps.logger ?? null },
        { provide: QUESTION_REPOSITORY, useClass: PgQuestionRepository },
        { provide: ASSESSMENT_REPOSITORY, useClass: PgAssessmentRepository },
        { provide: INVITE_REPOSITORY, useClass: PgInviteRepository },
        { provide: SESSION_REPOSITORY, useClass: PgSessionRepository },
        { provide: RESPONSE_REPOSITORY, useClass: PgResponseRepository },
        { provide: REVIEW_REPOSITORY, useClass: PgReviewRepository },
        { provide: APP_GUARD, useClass: AuthGuard },
        AuthoringService,
        EvaluationService,
        CodingDispatcher,
        RuntimeService,
        ResultsService,
        AssessmentEventHandlers,
      ],
      exports: [AssessmentEventHandlers, ResultsService],
    };
  }
}

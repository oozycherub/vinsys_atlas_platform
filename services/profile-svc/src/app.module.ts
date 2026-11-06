import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { type Logger } from 'pino';
import {
  AuthGuard,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  FieldCipher,
  type TenantKeyCache,
  type TenantKeys,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '@atlas/platform';
import { CandidateService } from './application/candidate.service';
import { DocumentService } from './application/document.service';
import { KEY_CACHE, ProfileEventHandlers } from './application/event-handlers';
import { EvidenceService } from './application/evidence.service';
import {
  CANDIDATE_REPOSITORY,
  DOCUMENT_REPOSITORY,
  EVIDENCE_REPOSITORY,
  FIELD_CIPHER,
  OBJECT_STORAGE,
  type ObjectStorage,
  PRIVACY_REPOSITORY,
  PROFILE_LOGGER,
  PROFILE_SETTINGS,
  type ProfileSettings,
  PURGE_REPOSITORY,
  SKILL_CATALOG,
  type SkillCatalog,
} from './application/ports';
import { PrivacyService } from './application/privacy.service';
import {
  CandidatesController,
  DocumentsController,
  HealthController,
  PrivacyController,
} from './http/controllers';
import {
  PgCandidateRepository,
  PgDocumentRepository,
  PgEvidenceRepository,
  PgPrivacyRepository,
  PgPurgeRepository,
} from './infrastructure/pg.repositories';

/** Everything that differs between production and tests is passed in (composition root). */
export interface ProfileSvcDependencies {
  db: Database;
  clock: Clock;
  verifier: TokenVerifier;
  /** Tenant DEKs: a TenantKeyCache over tenant-svc + KMS in production. */
  keys: TenantKeys & Partial<Pick<TenantKeyCache, 'evict'>>;
  storage: ObjectStorage;
  skills: SkillCatalog;
  settings: ProfileSettings;
  logger?: Logger;
}

@Module({})
export class AppModule {
  static register(deps: ProfileSvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [CandidatesController, DocumentsController, PrivacyController, HealthController],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: TOKEN_VERIFIER, useValue: deps.verifier },
        { provide: FIELD_CIPHER, useValue: new FieldCipher(deps.keys) },
        {
          provide: KEY_CACHE,
          useValue: deps.keys.evict ? { evict: (t: string) => deps.keys.evict?.(t) } : null,
        },
        { provide: OBJECT_STORAGE, useValue: deps.storage },
        { provide: SKILL_CATALOG, useValue: deps.skills },
        { provide: PROFILE_SETTINGS, useValue: deps.settings },
        { provide: PROFILE_LOGGER, useValue: deps.logger ?? null },
        { provide: CANDIDATE_REPOSITORY, useClass: PgCandidateRepository },
        { provide: EVIDENCE_REPOSITORY, useClass: PgEvidenceRepository },
        { provide: DOCUMENT_REPOSITORY, useClass: PgDocumentRepository },
        { provide: PRIVACY_REPOSITORY, useClass: PgPrivacyRepository },
        { provide: PURGE_REPOSITORY, useClass: PgPurgeRepository },
        { provide: APP_GUARD, useClass: AuthGuard },
        CandidateService,
        EvidenceService,
        DocumentService,
        PrivacyService,
        ProfileEventHandlers,
      ],
      exports: [ProfileEventHandlers],
    };
  }
}

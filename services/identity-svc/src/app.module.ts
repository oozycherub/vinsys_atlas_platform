import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AnyOfVerifier,
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
import { AdminService } from './application/admin.service';
import { AuthService } from './application/auth.service';
import { FederationService } from './application/federation.service';
import {
  CREDENTIAL_REPOSITORY,
  FEDERATION_REPOSITORY,
  IDENTITY_SETTINGS,
  type IdentitySettings,
  LINK_DELIVERY,
  type LinkDelivery,
  OIDC_RELYING_PARTY,
  type OidcRelyingParty,
  SAML_SERVICE_PROVIDER,
  type SamlServiceProvider,
  STAFF_REPOSITORY,
  SERVICE_CLIENT_REPOSITORY,
  SIGNING_KEY_REPOSITORY,
  SSO_REPOSITORY,
  TENANT_ACCESS_REPOSITORY,
  USER_REPOSITORY,
} from './application/ports';
import { SigningKeyService } from './application/signing-key.service';
import { TenantEventHandlers } from './application/tenant-events';
import { UserService } from './application/user.service';
import { AuthController, WellKnownController } from './http/auth.controller';
import { FederationController, StaffController } from './http/federation.controller';
import { AdminController, UsersController } from './http/users.controller';
import { HttpOidcRelyingParty } from './infrastructure/http-oidc-relying-party';
import { NodeSamlServiceProvider } from './infrastructure/node-saml-service-provider';
import { PgCredentialRepository } from './infrastructure/pg-credentials.repository';
import {
  PgFederationRepository,
  PgServiceClientRepository,
  PgSigningKeyRepository,
  PgSsoRepository,
  PgStaffRepository,
  PgTenantAccessRepository,
} from './infrastructure/pg-platform.repository';
import { PgUserRepository } from './infrastructure/pg-users.repository';

/** Everything that differs between production and tests is passed in (composition root). */
export interface IdentitySvcDependencies {
  db: Database;
  clock: Clock;
  limiter: RateLimiter;
  /** A delivery, or a factory for one that needs the signer (notification-svc tokens). */
  delivery: LinkDelivery | ((signer: SigningKeyService) => LinkDelivery);
  settings: IdentitySettings;
  /** Development and tests only: lets IdP URLs be http or point at localhost. */
  allowInsecureIdp?: boolean;
  oidc?: OidcRelyingParty;
  saml?: SamlServiceProvider;
  /** Platform-staff token verifiers (workforce IdP), tried after identity's own keys. */
  staffVerifiers?: readonly TokenVerifier[];
}

@Module({})
export class AppModule {
  static register(deps: IdentitySvcDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        UsersController,
        AdminController,
        AuthController,
        WellKnownController,
        FederationController,
        StaffController,
      ],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: CLOCK, useValue: deps.clock },
        { provide: RATE_LIMITER, useValue: deps.limiter },
        {
          provide: LINK_DELIVERY,
          useFactory: (signer: SigningKeyService): LinkDelivery =>
            typeof deps.delivery === 'function' ? deps.delivery(signer) : deps.delivery,
          inject: [SigningKeyService],
        },
        {
          provide: OIDC_RELYING_PARTY,
          useValue:
            deps.oidc ??
            new HttpOidcRelyingParty(deps.clock, { allowInsecure: deps.allowInsecureIdp ?? false }),
        },
        { provide: SAML_SERVICE_PROVIDER, useValue: deps.saml ?? new NodeSamlServiceProvider() },
        { provide: FEDERATION_REPOSITORY, useClass: PgFederationRepository },
        { provide: STAFF_REPOSITORY, useClass: PgStaffRepository },
        { provide: IDENTITY_SETTINGS, useValue: deps.settings },
        { provide: USER_REPOSITORY, useClass: PgUserRepository },
        { provide: CREDENTIAL_REPOSITORY, useClass: PgCredentialRepository },
        { provide: TENANT_ACCESS_REPOSITORY, useClass: PgTenantAccessRepository },
        { provide: SIGNING_KEY_REPOSITORY, useClass: PgSigningKeyRepository },
        { provide: SERVICE_CLIENT_REPOSITORY, useClass: PgServiceClientRepository },
        { provide: SSO_REPOSITORY, useClass: PgSsoRepository },
        SigningKeyService,
        {
          provide: TOKEN_VERIFIER,
          useFactory: (keys: SigningKeyService): TokenVerifier =>
            new AnyOfVerifier([keys, ...(deps.staffVerifiers ?? [])]),
          inject: [SigningKeyService],
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        UserService,
        AuthService,
        AdminService,
        FederationService,
        TenantEventHandlers,
      ],
      exports: [TenantEventHandlers, SigningKeyService, AdminService],
    };
  }
}

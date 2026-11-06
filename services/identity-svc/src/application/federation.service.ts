import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LoginSucceeded, UserActivated } from '@atlas/contracts';
import {
  appendOutbox,
  BadRequestError,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  newId,
  NotFoundError,
  randomToken,
  sha256,
  type Tx,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { normalizeEmail } from '../domain/email';
import { IdentityDomainError } from '../domain/errors';
import {
  assertCodeChallenge,
  assertDomainAllowed,
  AUTHORIZATION_CODE_TTL_MS,
  FEDERATION_STATE_TTL_MS,
  isUsable,
  resolveRedirectUri,
} from '../domain/federation';
import { activateUser, inviteUser, recordLogin, type User } from '../domain/user';
import {
  FEDERATION_REPOSITORY,
  type FederatedIdentity,
  type FederationRepository,
  type FederationState,
  IDENTITY_SETTINGS,
  type IdentitySettings,
  OIDC_RELYING_PARTY,
  type OidcProviderConfig,
  type OidcRelyingParty,
  SAML_SERVICE_PROVIDER,
  type SamlProviderConfig,
  type SamlServiceProvider,
  type SsoConnection,
  SSO_REPOSITORY,
  type SsoRepository,
  STAFF_REPOSITORY,
  type StaffRepository,
  type SubjectKind,
  TENANT_ACCESS_REPOSITORY,
  type TenantAccess,
  type TenantAccessRepository,
  USER_REPOSITORY,
  type UserRepository,
} from './ports';
import { translate } from './translate';

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string | undefined;
  state: string;
}

/** Endpoints a tenant registers at its IdP. */
export function serviceProviderEndpoints(
  issuer: string,
  slug: string,
): { oidc_redirect_uri: string; saml_acs_url: string; saml_entity_id: string } {
  const base = `${issuer.replace(/\/$/, '')}/v1/sso/${slug}`;
  return {
    oidc_redirect_uri: `${base}/callback`,
    saml_acs_url: `${base}/acs`,
    saml_entity_id: base,
  };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Where a federated login was started, as recorded in its state row. */
interface StartContext {
  kind: SubjectKind;
  access: TenantAccess | null;
}

/**
 * Federated sign-in (docs/prompts/02-identity-svc.md §2): Atlas is an OIDC relying party / SAML
 * service provider towards the tenant's IdP (or the workforce IdP for staff), and an OAuth
 * authorization server with PKCE towards its own web app.
 *
 * Errors before the state is validated are problem documents (the redirect URI is not yet
 * trusted). After that, failures redirect back to the client with `error=access_denied`.
 */
@Injectable()
export class FederationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FEDERATION_REPOSITORY) private readonly federation: FederationRepository,
    @Inject(TENANT_ACCESS_REPOSITORY) private readonly tenants: TenantAccessRepository,
    @Inject(SSO_REPOSITORY) private readonly sso: SsoRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    @Inject(OIDC_RELYING_PARTY) private readonly oidc: OidcRelyingParty,
    @Inject(SAML_SERVICE_PROVIDER) private readonly saml: SamlServiceProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
  ) {}

  /** GET /v1/sso/{slug}/start: returns the IdP URL to redirect the browser to. */
  async startTenant(slug: string, request: AuthorizeRequest): Promise<string> {
    const redirectUri = await translate(() => Promise.resolve(this.checkClient(request, slug)));
    const access = await this.loginTenant(slug);
    const connection = await withTenantTx(this.db, access.tenantId, (tx) => this.sso.find(tx));
    if (!connection) {
      throw new NotFoundError('SSO_NOT_CONFIGURED', 'This organisation has no single sign-on.');
    }
    const endpoints = serviceProviderEndpoints(this.settings.issuer, slug);
    if (connection.protocol === 'saml') {
      const state = randomToken();
      const { url, requestId } = await this.saml.authorizeUrl(samlConfig(connection), {
        acsUrl: endpoints.saml_acs_url,
        spEntityId: endpoints.saml_entity_id,
        relayState: state,
      });
      await this.saveState(state, { kind: 'tenant', access }, 'saml', request, redirectUri, {
        samlRequestId: requestId,
      });
      return url;
    }
    return this.startOidc(
      await this.oidcConfig(connection),
      endpoints.oidc_redirect_uri,
      { kind: 'tenant', access },
      request,
      redirectUri,
    );
  }

  /** GET /v1/staff/sso/start */
  async startStaff(request: AuthorizeRequest): Promise<string> {
    const redirectUri = await translate(() => Promise.resolve(this.checkClient(request, null)));
    const idp = this.staffIdp();
    return this.startOidc(
      idp,
      this.staffCallbackUrl(),
      { kind: 'staff', access: null },
      request,
      redirectUri,
    );
  }

  /** GET /v1/sso/{slug}/callback (OIDC). Returns the client redirect URL. */
  async oidcCallbackTenant(
    slug: string,
    params: { state?: string | undefined; code?: string | undefined; error?: string | undefined },
  ): Promise<string> {
    const state = await this.takeState(params.state, 'tenant', slug);
    return this.finish(state, async () => {
      if (params.error || !params.code) throw denied('idp_denied');
      const access = await this.loginTenant(slug);
      const connection = await withTenantTx(this.db, access.tenantId, (tx) => this.sso.find(tx));
      if (connection?.protocol !== 'oidc') throw denied('sso_not_configured');
      const identity = await this.oidc.exchangeCode(await this.oidcConfig(connection), {
        code: params.code,
        redirectUri: serviceProviderEndpoints(this.settings.issuer, slug).oidc_redirect_uri,
        codeVerifier: state.idpCodeVerifier ?? '',
        nonce: state.nonce ?? '',
      });
      return this.completeTenant(access, identity, state);
    });
  }

  /** POST /v1/sso/{slug}/acs (SAML HTTP-POST binding). Returns the client redirect URL. */
  async samlAcs(
    slug: string,
    params: { SAMLResponse?: string | undefined; RelayState?: string | undefined },
  ): Promise<string> {
    const state = await this.takeState(params.RelayState, 'tenant', slug);
    return this.finish(state, async () => {
      if (!params.SAMLResponse || state.protocol !== 'saml' || !state.samlRequestId) {
        throw denied('invalid_saml_response');
      }
      const access = await this.loginTenant(slug);
      const connection = await withTenantTx(this.db, access.tenantId, (tx) => this.sso.find(tx));
      if (connection?.protocol !== 'saml') throw denied('sso_not_configured');
      const endpoints = serviceProviderEndpoints(this.settings.issuer, slug);
      const identity = await this.saml.validateResponse(samlConfig(connection), {
        acsUrl: endpoints.saml_acs_url,
        spEntityId: endpoints.saml_entity_id,
        samlResponse: params.SAMLResponse,
        expectedRequestId: state.samlRequestId,
      });
      return this.completeTenant(access, identity, state);
    });
  }

  /** GET /v1/staff/sso/callback */
  async oidcCallbackStaff(params: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
  }): Promise<string> {
    const state = await this.takeState(params.state, 'staff', null);
    return this.finish(state, async () => {
      if (params.error || !params.code) throw denied('idp_denied');
      const idp = this.staffIdp();
      const identity = await this.oidc.exchangeCode(idp, {
        code: params.code,
        redirectUri: this.staffCallbackUrl(),
        codeVerifier: state.idpCodeVerifier ?? '',
        nonce: state.nonce ?? '',
      });
      const email = normalizeEmail(identity.email);
      assertDomainAllowed(email, idp.allowedDomains, 'STAFF_DOMAIN_NOT_ALLOWED');
      return withSystemTx(this.db, async (tx) => {
        const account = await this.staff.findByEmail(tx, email);
        if (account?.status !== 'active') throw denied('staff_account_not_found');
        const now = this.clock.now();
        await this.staff.recordLogin(tx, account.id, now);
        await this.audit(tx, null, account.id, 'staff');
        return this.issueCode(tx, state, account.id, null);
      });
    });
  }

  private async completeTenant(
    access: TenantAccess,
    identity: FederatedIdentity,
    state: FederationState,
  ): Promise<string> {
    return withTenantTx(this.db, access.tenantId, async (tx) => {
      const connection = await this.sso.find(tx);
      if (!connection) throw denied('sso_not_configured');
      const email = normalizeEmail(identity.email);
      assertDomainAllowed(email, connection.domainHints, 'SSO_DOMAIN_NOT_ALLOWED');
      const user = await this.signInUser(tx, access.tenantId, email, identity, connection);
      await this.audit(tx, access.tenantId, user.id, 'user');
      return this.issueCode(tx, state, user.id, access.tenantId);
    });
  }

  /** Existing active user, invited user (SSO proves the address), or JIT if the tenant allows it. */
  private async signInUser(
    tx: Tx,
    tenantId: string,
    email: string,
    identity: FederatedIdentity,
    connection: SsoConnection,
  ): Promise<User> {
    const now = this.clock.now();
    const existing = await this.users.findByEmail(tx, email);
    if (existing?.status === 'active') {
      const next = recordLogin(existing, now);
      await this.users.update(tx, next, existing.version);
      return next;
    }
    if (existing?.status === 'invited') {
      const next = activateUser(existing, now);
      await this.users.update(tx, next, existing.version);
      await this.emitActivated(tx, next);
      return next;
    }
    if (existing) throw denied('user_deactivated');
    if (!connection.jitRole) throw denied('user_not_provisioned');
    const { user } = inviteUser({
      id: newId(),
      tenantId,
      email,
      displayName: identity.displayName ?? email.split('@')[0] ?? email,
      roles: [connection.jitRole],
      actor: { subject: 'sso-jit', roles: ['service'] },
      now,
    });
    const active = activateUser(user, now);
    await this.users.insert(tx, active);
    await this.emitActivated(tx, active);
    return active;
  }

  private async emitActivated(tx: Tx, user: User): Promise<void> {
    await appendOutbox(
      tx,
      UserActivated.build({
        tenantId: user.tenantId,
        aggregateId: user.id,
        payload: {
          tenant_id: user.tenantId,
          user_id: user.id,
          occurred_at: this.clock.now().toISOString(),
        },
      }),
    );
  }

  private async audit(
    tx: Tx,
    tenantId: string | null,
    subjectId: string,
    kind: 'user' | 'staff',
  ): Promise<void> {
    await appendOutbox(
      tx,
      LoginSucceeded.build({
        tenantId,
        aggregateId: subjectId,
        payload: {
          tenant_id: tenantId,
          subject_id: subjectId,
          subject_kind: kind,
          method: 'sso',
          amr: ['sso'],
          occurred_at: this.clock.now().toISOString(),
        },
      }),
    );
  }

  private async issueCode(
    tx: Tx,
    state: FederationState,
    subjectId: string,
    tenantId: string | null,
  ): Promise<string> {
    const code = randomToken();
    await this.federation.insertCode(tx, {
      codeHash: sha256(code),
      kind: state.kind,
      tenantId,
      subjectId,
      clientId: state.clientId,
      redirectUri: state.redirectUri,
      codeChallenge: state.codeChallenge,
      amr: ['sso'],
      expiresAt: new Date(this.clock.now().getTime() + AUTHORIZATION_CODE_TTL_MS),
      consumedAt: null,
    });
    return clientRedirect(state, { code });
  }

  private async startOidc(
    provider: OidcProviderConfig,
    callbackUrl: string,
    context: StartContext,
    request: AuthorizeRequest,
    redirectUri: string,
  ): Promise<string> {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const url = await translate(() =>
      this.oidc.authorizationUrl(provider, {
        redirectUri: callbackUrl,
        state,
        nonce,
        codeChallenge: pkceChallenge(verifier),
      }),
    );
    await this.saveState(state, context, 'oidc', request, redirectUri, {
      nonce,
      idpCodeVerifier: verifier,
    });
    return url;
  }

  private async saveState(
    state: string,
    context: StartContext,
    protocol: 'oidc' | 'saml',
    request: AuthorizeRequest,
    redirectUri: string,
    extra: { nonce?: string; idpCodeVerifier?: string; samlRequestId?: string },
  ): Promise<void> {
    await withSystemTx(this.db, (tx) =>
      this.federation.insertState(tx, {
        stateHash: sha256(state),
        kind: context.kind,
        tenantId: context.access?.tenantId ?? null,
        protocol,
        nonce: extra.nonce ?? null,
        idpCodeVerifier: extra.idpCodeVerifier ?? null,
        samlRequestId: extra.samlRequestId ?? null,
        clientId: request.clientId,
        redirectUri,
        codeChallenge: request.codeChallenge,
        clientState: request.state,
        expiresAt: new Date(this.clock.now().getTime() + FEDERATION_STATE_TTL_MS),
        consumedAt: null,
      }),
    );
  }

  /** Validates and consumes the state in its own transaction, before any IdP call. */
  private async takeState(
    raw: string | undefined,
    kind: SubjectKind,
    slug: string | null,
  ): Promise<FederationState> {
    const invalid = (): BadRequestError =>
      new BadRequestError(
        'INVALID_STATE',
        'This sign-in attempt is invalid or has expired. Start again.',
      );
    if (!raw || raw.length > 200) throw invalid();
    const access = slug
      ? await withSystemTx(this.db, (tx) => this.tenants.findBySlug(tx, slug))
      : null;
    return withSystemTx(this.db, async (tx) => {
      const state = await this.federation.findState(tx, sha256(raw));
      const now = this.clock.now();
      if (
        !state ||
        !isUsable(state, now) ||
        state.kind !== kind ||
        (kind === 'tenant' && state.tenantId !== access?.tenantId)
      ) {
        throw invalid();
      }
      await this.federation.consumeState(tx, state.stateHash, now);
      return state;
    });
  }

  /** Runs the post-state part of a login; domain failures become an OAuth error redirect. */
  private async finish(state: FederationState, work: () => Promise<string>): Promise<string> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof IdentityDomainError) {
        return clientRedirect(state, {
          error: 'access_denied',
          error_description: error.code.toLowerCase(),
        });
      }
      throw error;
    }
  }

  private checkClient(request: AuthorizeRequest, slug: string | null): string {
    const client = this.settings.oauthClients[request.clientId];
    if (!client) {
      throw new IdentityDomainError('validation', 'INVALID_CLIENT', 'Unknown client_id.');
    }
    const redirectUri = resolveRedirectUri(client.redirectUris, request.redirectUri, slug);
    assertCodeChallenge(request.codeChallenge, request.codeChallengeMethod);
    if (!request.state || request.state.length > 500) {
      throw new IdentityDomainError(
        'validation',
        'INVALID_STATE',
        'state is required (≤ 500 characters).',
      );
    }
    return redirectUri;
  }

  private async loginTenant(slug: string): Promise<TenantAccess> {
    const access = await withSystemTx(this.db, (tx) => this.tenants.findBySlug(tx, slug));
    if (!access || access.status === 'purged') {
      throw new NotFoundError('TENANT_NOT_FOUND', 'Unknown organisation.');
    }
    if (!['provisioning', 'active'].includes(access.status)) {
      throw new IdentityDomainError(
        'unauthorized',
        'TENANT_SUSPENDED',
        'This organisation’s access is suspended.',
      );
    }
    return access;
  }

  private async oidcConfig(connection: SsoConnection): Promise<OidcProviderConfig> {
    const issuer = connection.metadata['issuer'];
    const clientId = connection.metadata['client_id'];
    if (
      typeof issuer !== 'string' ||
      typeof clientId !== 'string' ||
      !connection.clientSecretCiphertext
    ) {
      throw denied('sso_not_configured');
    }
    const secret = await this.settings.keys.decrypt(
      connection.clientSecretCiphertext,
      ssoSecretContext(connection.tenantId),
    );
    return { issuer, clientId, clientSecret: secret.toString('utf8') };
  }

  private staffIdp(): OidcProviderConfig & { allowedDomains: readonly string[] } {
    if (!this.settings.staffIdp) {
      throw new NotFoundError('STAFF_SSO_NOT_CONFIGURED', 'Staff sign-in is not configured.');
    }
    return this.settings.staffIdp;
  }

  private staffCallbackUrl(): string {
    return `${this.settings.issuer.replace(/\/$/, '')}/v1/staff/sso/callback`;
  }
}

export function ssoSecretContext(tenantId: string): string {
  return `sso-client-secret:${tenantId}`;
}

function samlConfig(connection: SsoConnection): SamlProviderConfig {
  const entryPoint = connection.metadata['entry_point'];
  const idpCert = connection.metadata['idp_cert'];
  const idpIssuer = connection.metadata['idp_issuer'];
  if (typeof entryPoint !== 'string' || typeof idpCert !== 'string')
    throw denied('sso_not_configured');
  return { entryPoint, idpCert, idpIssuer: typeof idpIssuer === 'string' ? idpIssuer : null };
}

function denied(reason: string): IdentityDomainError {
  return new IdentityDomainError('forbidden', reason.toUpperCase(), reason);
}

function clientRedirect(state: FederationState, params: Record<string, string>): string {
  const url = new URL(state.redirectUri);
  for (const [k, v] of Object.entries({ ...params, state: state.clientState }))
    url.searchParams.set(k, v);
  return url.toString();
}

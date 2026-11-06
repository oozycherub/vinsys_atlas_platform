import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LoginSucceeded, RefreshReuseDetected, UserActivated } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  ForbiddenError,
  newId,
  RATE_LIMITER,
  type RateLimiter,
  randomToken,
  sha256,
  TooManyRequestsError,
  type Tx,
  UnauthorizedError,
  verifySecret,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { emailDomain, normalizeEmail } from '../domain/email';
import { IdentityDomainError } from '../domain/errors';
import {
  evaluateRefresh,
  formatRefreshToken,
  grantScopes,
  MAGIC_LINK_TTL_MS,
  parseRefreshToken,
  REFRESH_TOKEN_TTL_MS,
} from '../domain/tokens';
import { activateUser, recordLogin, requiresSso, type User } from '../domain/user';
import { isUsable } from '../domain/federation';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepository,
  FEDERATION_REPOSITORY,
  type FederationRepository,
  IDENTITY_SETTINGS,
  type IdentitySettings,
  LINK_DELIVERY,
  type LinkDelivery,
  SERVICE_CLIENT_REPOSITORY,
  type ServiceClientRepository,
  SSO_REPOSITORY,
  type SsoRepository,
  STAFF_REPOSITORY,
  type StaffRepository,
  type TenantAccess,
  TENANT_ACCESS_REPOSITORY,
  type TenantAccessRepository,
  USER_REPOSITORY,
  type UserRepository,
} from './ports';
import { pkceChallenge } from './federation.service';
import { SigningKeyService } from './signing-key.service';
import { translate } from './translate';
import { linkUrl } from './user.service';
import { type TokenResponse } from './views';

/** Brute-force limits (docs/prompts/02-identity-svc.md §4 and §7). */
export const LIMITS = {
  magicLinkPerEmail: { limit: 5, windowSec: 3600 },
  magicLinkPerIp: { limit: 30, windowSec: 3600 },
  clientCredentialsPerClient: { limit: 60, windowSec: 60 },
} as const;

const LOGIN_STATUSES: readonly string[] = ['provisioning', 'active'];

interface IssuedSession {
  user: User;
  refreshToken: string;
  amr: readonly string[];
}

/** Login flows and the OAuth token endpoint. */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(TENANT_ACCESS_REPOSITORY) private readonly tenants: TenantAccessRepository,
    @Inject(SSO_REPOSITORY) private readonly sso: SsoRepository,
    @Inject(SERVICE_CLIENT_REPOSITORY) private readonly clients: ServiceClientRepository,
    @Inject(LINK_DELIVERY) private readonly delivery: LinkDelivery,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    @Inject(FEDERATION_REPOSITORY) private readonly federation: FederationRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    private readonly signer: SigningKeyService,
  ) {}

  /**
   * authorization_code grant with PKCE (RFC 7636) for Atlas's own clients. Codes are single use,
   * live 60 s and are bound to client_id, redirect_uri and the S256 challenge.
   */
  async authorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
  }): Promise<TokenResponse> {
    const code = await withSystemTx(this.db, async (tx) => {
      const found = await this.federation.findCode(tx, sha256(input.code));
      const now = this.clock.now();
      if (
        !found ||
        !isUsable(found, now) ||
        found.clientId !== input.clientId ||
        found.redirectUri !== input.redirectUri ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
        pkceChallenge(input.codeVerifier) !== found.codeChallenge
      ) {
        return null;
      }
      await this.federation.consumeCode(tx, found.codeHash, now);
      return found;
    });
    if (!code) {
      throw new UnauthorizedError(
        'The authorization code is invalid or expired.',
        'INVALID_GRANT',
        {
          error: 'invalid_grant',
        },
      );
    }
    if (code.kind === 'staff') {
      const account = await withSystemTx(this.db, (tx) => this.staff.findById(tx, code.subjectId));
      if (account?.status !== 'active') throw invalidGrant();
      const { token, expiresIn } = await this.signer.sign({
        subject: account.id,
        tenantId: null,
        roles: account.roles,
        businessUnitIds: [],
        scopes: [],
        amr: code.amr,
      });
      // Staff get no refresh token: they re-authenticate at the workforce IdP (short sessions).
      return { access_token: token, token_type: 'Bearer', expires_in: expiresIn };
    }
    const tenantId = code.tenantId ?? '';
    await this.activeTenant(tenantId);
    const session = await withTenantTx(this.db, tenantId, async (tx) => {
      const user = await this.users.findById(tx, code.subjectId);
      if (user?.status !== 'active') return null;
      return this.startSession(tx, user, code.amr);
    });
    if (!session) throw invalidGrant();
    return this.respond(session);
  }

  /**
   * Starts a password-less login. Always answers the same way whether or not the email is
   * registered (no account enumeration). The returned `binding` must accompany the redeem
   * call, so a forwarded or intercepted link is useless in another browser.
   */
  async requestMagicLink(
    slug: string,
    rawEmail: string,
    clientIp: string,
  ): Promise<{ binding: string; expires_in: number }> {
    const email = await translate(() => Promise.resolve(normalizeEmail(rawEmail)));
    await this.limit(`magic:ip:${clientIp}`, LIMITS.magicLinkPerIp);
    await this.limit(`magic:email:${slug}:${email}`, LIMITS.magicLinkPerEmail);

    const binding = randomToken();
    const expiresIn = MAGIC_LINK_TTL_MS / 1000;
    const access = await withSystemTx(this.db, (tx) => this.tenants.findBySlug(tx, slug));
    if (!access || !LOGIN_STATUSES.includes(access.status)) {
      return { binding, expires_in: expiresIn };
    }

    const pending = await withTenantTx(this.db, access.tenantId, async (tx) => {
      const connection = await this.sso.find(tx);
      if (connection?.enforced && connection.domainHints.includes(emailDomain(email))) {
        throw ssoRequired();
      }
      const user = await this.users.findByEmail(tx, email);
      if (!user || user.status !== 'active') return null;
      const token = randomToken();
      const expiresAt = new Date(this.clock.now().getTime() + MAGIC_LINK_TTL_MS);
      await this.credentials.insertMagicLink(tx, {
        id: newId(),
        tenantId: access.tenantId,
        userId: user.id,
        tokenHash: sha256(token),
        bindingHash: sha256(binding),
        expiresAt,
      });
      return {
        email,
        expiresAt,
        url: linkUrl(this.settings.appBaseUrl, slug, '/login/verify', token),
      };
    });
    if (pending) {
      await this.delivery.send({ kind: 'magic_link', tenantId: access.tenantId, ...pending });
    }
    return { binding, expires_in: expiresIn };
  }

  async redeemMagicLink(slug: string, token: string, binding: string): Promise<TokenResponse> {
    const access = await this.loginTenant(slug);
    const session = await withTenantTx(this.db, access.tenantId, (tx) =>
      translate(async () => {
        const link = await this.credentials.findMagicLink(tx, sha256(token));
        const now = this.clock.now();
        if (
          !link?.bindingHash ||
          !sameHash(link.bindingHash, sha256(binding)) ||
          link.consumedAt ||
          now.getTime() >= link.expiresAt.getTime()
        ) {
          throw invalidLink();
        }
        const user = await this.users.findById(tx, link.userId, { forUpdate: true });
        if (!user) throw invalidLink();
        if (requiresSso(user) && (await this.sso.find(tx))?.enforced) throw ssoRequired();
        if (!(await this.credentials.consumeMagicLink(tx, link.id, now))) throw invalidLink();
        const next = recordLogin(user, now);
        await this.users.update(tx, next, user.version);
        await this.audit(tx, next, 'magic_link');
        return this.startSession(tx, next, ['email']);
      }),
    );
    return this.respond(session);
  }

  /** Redeeming an invitation activates the user and signs them in. */
  async redeemInvitation(slug: string, token: string): Promise<TokenResponse> {
    const access = await this.loginTenant(slug);
    const session = await withTenantTx(this.db, access.tenantId, (tx) =>
      translate(async () => {
        const invitation = await this.credentials.findInvitation(tx, sha256(token));
        const now = this.clock.now();
        if (!invitation || invitation.consumedAt) throw invalidLink();
        if (now.getTime() >= invitation.expiresAt.getTime()) {
          throw new UnauthorizedError(
            'This invitation has expired. Ask your administrator for a new one.',
            'INVITATION_EXPIRED',
          );
        }
        const user = await this.users.findById(tx, invitation.userId, { forUpdate: true });
        if (!user) throw invalidLink();
        if (!(await this.credentials.consumeInvitation(tx, invitation.id, now)))
          throw invalidLink();
        const next = activateUser(user, now);
        await this.users.update(tx, next, user.version);
        await appendOutbox(
          tx,
          UserActivated.build({
            tenantId: next.tenantId,
            aggregateId: next.id,
            payload: { tenant_id: next.tenantId, user_id: next.id, occurred_at: now.toISOString() },
          }),
        );
        await this.audit(tx, next, 'invitation');
        return this.startSession(tx, next, ['email']);
      }),
    );
    return this.respond(session);
  }

  /**
   * Refresh-token rotation. A token that was already exchanged revokes its whole family and
   * raises a security event. That revocation must survive the failed request, so it commits
   * before the 401 is thrown.
   */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const { tenantId } = await translate(() => Promise.resolve(parseRefreshToken(refreshToken)));
    await this.activeTenant(tenantId);
    const outcome = await withTenantTx(this.db, tenantId, async (tx) => {
      const current = await this.credentials.findRefreshToken(tx, sha256(refreshToken));
      if (!current) return { kind: 'invalid' as const };
      const now = this.clock.now();
      const decision = evaluateRefresh(current, now);
      if (decision.kind === 'reuse') {
        const revoked = await this.credentials.revokeFamily(tx, current.familyId, now);
        await appendOutbox(
          tx,
          RefreshReuseDetected.build({
            tenantId,
            aggregateId: current.familyId,
            payload: {
              tenant_id: tenantId,
              user_id: current.userId,
              family_id: current.familyId,
              revoked_tokens: revoked,
              occurred_at: now.toISOString(),
            },
          }),
        );
        return { kind: 'reuse' as const };
      }
      if (decision.kind === 'invalid') return { kind: 'invalid' as const };
      const user = await this.users.findById(tx, current.userId);
      if (!user || user.status !== 'active') {
        await this.credentials.revokeFamily(tx, current.familyId, now);
        return { kind: 'invalid' as const };
      }
      await this.credentials.markRefreshUsed(tx, current.id, now);
      const session = await this.startSession(tx, user, current.amr, {
        familyId: current.familyId,
        rotatedFrom: current.id,
      });
      return { kind: 'ok' as const, session };
    });
    if (outcome.kind === 'reuse') {
      throw new UnauthorizedError(
        'This refresh token was already used. All sessions from this login were revoked.',
        'TOKEN_REUSE_DETECTED',
        { error: 'invalid_grant' },
      );
    }
    if (outcome.kind === 'invalid') throw invalidGrant();
    return this.respond(outcome.session);
  }

  /** OAuth client credentials for machine principals (`roles: ["service"]`). */
  async clientCredentials(
    clientId: string,
    clientSecret: string,
    scope: string | undefined,
  ): Promise<TokenResponse> {
    await this.limit(`cc:${clientId}`, LIMITS.clientCredentialsPerClient);
    const client = await withSystemTx(this.db, (tx) => this.clients.find(tx, clientId));
    // Hash even for unknown clients so response time does not reveal which ids exist.
    const ok = await verifySecret(clientSecret, client?.secretHash ?? DUMMY_HASH);
    if (!client || !ok || client.disabledAt) {
      throw new UnauthorizedError('Client authentication failed.', 'INVALID_CLIENT', {
        error: 'invalid_client',
      });
    }
    if (client.tenantId) await this.activeTenant(client.tenantId);
    const scopes = await translate(() => Promise.resolve(grantScopes(client.scopes, scope)));
    const { token, expiresIn } = await this.signer.sign({
      subject: client.clientId,
      tenantId: client.tenantId,
      roles: ['service'],
      businessUnitIds: [],
      scopes,
      amr: ['client'],
    });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: scopes.join(' '),
    };
  }

  private async audit(tx: Tx, user: User, method: 'invitation' | 'magic_link'): Promise<void> {
    await appendOutbox(
      tx,
      LoginSucceeded.build({
        tenantId: user.tenantId,
        aggregateId: user.id,
        payload: {
          tenant_id: user.tenantId,
          subject_id: user.id,
          subject_kind: 'user',
          method,
          amr: ['email'],
          occurred_at: this.clock.now().toISOString(),
        },
      }),
    );
  }

  private async startSession(
    tx: Tx,
    user: User,
    amr: readonly string[],
    family?: { familyId: string; rotatedFrom: string },
  ): Promise<IssuedSession> {
    const secret = randomToken();
    const refreshToken = formatRefreshToken(user.tenantId, secret);
    const now = this.clock.now();
    await this.credentials.insertRefreshToken(tx, {
      id: newId(),
      tenantId: user.tenantId,
      userId: user.id,
      familyId: family?.familyId ?? newId(),
      amr,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      usedAt: null,
      revokedAt: null,
      tokenHash: sha256(refreshToken),
      rotatedFrom: family?.rotatedFrom ?? null,
    });
    return { user, refreshToken, amr };
  }

  private async respond(session: IssuedSession): Promise<TokenResponse> {
    const { user } = session;
    const { token, expiresIn } = await this.signer.sign({
      subject: user.id,
      tenantId: user.tenantId,
      roles: user.roles,
      businessUnitIds: user.businessUnitIds,
      scopes: [],
      amr: session.amr,
    });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: session.refreshToken,
    };
  }

  /** A tenant users may sign in to: unknown or purged → invalid link; suspended → TENANT_SUSPENDED. */
  private async loginTenant(slug: string): Promise<TenantAccess> {
    const access = await withSystemTx(this.db, (tx) => this.tenants.findBySlug(tx, slug));
    if (!access || access.status === 'purged') throw invalidLink();
    assertLoginAllowed(access);
    return access;
  }

  private async activeTenant(tenantId: string): Promise<void> {
    const access = await withSystemTx(this.db, (tx) => this.tenants.findById(tx, tenantId));
    if (!access || access.status === 'purged') throw invalidGrant();
    assertLoginAllowed(access);
  }

  private async limit(key: string, rule: { limit: number; windowSec: number }): Promise<void> {
    const decision = await this.limiter.consume(key, rule.limit, rule.windowSec);
    if (!decision.allowed) {
      throw new TooManyRequestsError(
        'RATE_LIMITED',
        'Too many attempts. Try again later.',
        decision.retryAfterSec,
      );
    }
  }
}

/** A valid argon2id PHC string that matches no secret; verified for unknown client ids. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function assertLoginAllowed(access: TenantAccess): void {
  if (!LOGIN_STATUSES.includes(access.status)) {
    throw new UnauthorizedError(
      'This organisation’s access is suspended. Contact your administrator.',
      'TENANT_SUSPENDED',
    );
  }
}

function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function invalidLink(): IdentityDomainError {
  return new IdentityDomainError(
    'unauthorized',
    'INVALID_LINK',
    'This link is invalid, expired or already used.',
  );
}

function invalidGrant(): UnauthorizedError {
  return new UnauthorizedError('The refresh token is invalid or expired.', 'INVALID_GRANT', {
    error: 'invalid_grant',
  });
}

function ssoRequired(): ForbiddenError {
  return new ForbiddenError('Your organisation requires single sign-on.', 'SSO_REQUIRED');
}

import { Inject, Injectable } from '@nestjs/common';
import {
  BadRequestError,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  hashSecret,
  newId,
  NotFoundError,
  PreconditionFailedError,
  PreconditionRequiredError,
  type Principal,
  randomToken,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { normalizeEmail } from '../domain/email';
import { serviceProviderEndpoints, ssoSecretContext } from './federation.service';
import {
  IDENTITY_SETTINGS,
  type IdentitySettings,
  SERVICE_CLIENT_REPOSITORY,
  type ServiceClientRepository,
  type SsoConnection,
  SSO_REPOSITORY,
  type SsoRepository,
  type StaffAccount,
  STAFF_REPOSITORY,
  type StaffRepository,
  TENANT_ACCESS_REPOSITORY,
  type TenantAccessRepository,
} from './ports';
import { actingTenant } from './tenant-scope';
import { type SsoConnectionView, type StaffAccountView, toSsoView, toStaffView } from './views';

export interface SsoConnectionInput {
  protocol: 'oidc' | 'saml';
  enforced: boolean;
  /** oidc: { issuer, client_id }; saml: { entry_point, idp_cert, idp_issuer? } */
  metadata: Record<string, unknown>;
  domainHints: readonly string[];
  /** OIDC only. Write-only; omit on replace to keep the stored secret. */
  clientSecret?: string;
  jitRole: string | null;
}

export interface ServiceClientInput {
  name: string;
  tenantId: string | null;
  scopes: readonly string[];
  description: string;
}

/** SSO federation config (per tenant), machine clients and staff accounts (platform). */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SSO_REPOSITORY) private readonly sso: SsoRepository,
    @Inject(SERVICE_CLIENT_REPOSITORY) private readonly clients: ServiceClientRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    @Inject(TENANT_ACCESS_REPOSITORY) private readonly tenants: TenantAccessRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
  ) {}

  async getSso(principal: Principal, tenantId: string): Promise<SsoConnectionView> {
    const scoped = actingTenant(principal, tenantId);
    const { connection, slug } = await withTenantTx(this.db, scoped, async (tx) => ({
      connection: await this.sso.find(tx),
      slug: (await this.tenants.findById(tx, scoped))?.slug ?? null,
    }));
    if (!connection) {
      throw new NotFoundError('SSO_CONNECTION_NOT_FOUND', 'No SSO connection is configured.');
    }
    return this.view(connection, slug);
  }

  /** Create-or-replace. Replacing an existing connection requires If-Match (428/412). */
  async putSso(
    principal: Principal,
    tenantId: string,
    input: SsoConnectionInput,
    ifMatch: number | undefined,
  ): Promise<{ view: SsoConnectionView; created: boolean }> {
    const scoped = actingTenant(principal, tenantId);
    // Sealed before the transaction: a KMS round trip should not hold row locks.
    const sealed = input.clientSecret
      ? await this.settings.keys.encrypt(
          Buffer.from(input.clientSecret, 'utf8'),
          ssoSecretContext(scoped),
        )
      : null;
    return withTenantTx(this.db, scoped, async (tx) => {
      const existing = await this.sso.find(tx);
      if (existing && ifMatch === undefined) {
        throw new PreconditionRequiredError(
          'IF_MATCH_REQUIRED',
          'Send If-Match with the ETag from your last read.',
        );
      }
      if (existing && ifMatch !== existing.version) {
        throw new PreconditionFailedError(
          'VERSION_MISMATCH',
          'The SSO connection changed since you read it.',
        );
      }
      // An OIDC connection replaced without a new secret keeps the stored one.
      let secret: Buffer | null = null;
      let kekRef: string | null = null;
      if (input.protocol === 'oidc') {
        if (sealed) {
          secret = sealed;
          kekRef = this.settings.keys.keyRef;
        } else if (existing?.protocol === 'oidc' && existing.clientSecretCiphertext) {
          secret = existing.clientSecretCiphertext;
          kekRef = existing.kekRef;
        } else {
          throw new BadRequestError(
            'CLIENT_SECRET_REQUIRED',
            'An OIDC connection needs a client_secret.',
          );
        }
      }
      const connection: SsoConnection = {
        tenantId: scoped,
        protocol: input.protocol,
        enforced: input.enforced,
        metadata: input.metadata,
        domainHints: [...new Set(input.domainHints.map((d) => d.toLowerCase()))].sort(),
        clientSecretCiphertext: secret,
        kekRef,
        jitRole: input.jitRole,
        version: (existing?.version ?? 0) + 1,
        updatedAt: this.clock.now(),
      };
      if (!(await this.sso.upsert(tx, connection, existing?.version ?? null))) {
        throw new PreconditionFailedError(
          'VERSION_MISMATCH',
          'The SSO connection changed concurrently.',
        );
      }
      const slug = (await this.tenants.findById(tx, scoped))?.slug ?? null;
      return { view: this.view(connection, slug), created: !existing };
    });
  }

  /** Returns the secret exactly once; only its argon2id hash is stored. */
  async createServiceClient(
    principal: Principal,
    input: ServiceClientInput,
  ): Promise<{
    client_id: string;
    client_secret: string;
    tenant_id: string | null;
    scopes: string[];
  }> {
    const clientId = `svc_${input.name}`;
    const secret = randomToken();
    const secretHash = await hashSecret(secret);
    const scopes = [...new Set(input.scopes)].sort();
    await withSystemTx(this.db, async (tx) => {
      if (await this.clients.find(tx, clientId)) {
        throw new ConflictError('CLIENT_EXISTS', `A client named "${input.name}" already exists.`);
      }
      await this.clients.insert(tx, {
        clientId,
        tenantId: input.tenantId,
        secretHash,
        scopes,
        description: input.description,
        disabledAt: null,
        createdBy: principal.subject,
        createdAt: this.clock.now(),
      });
    });
    return { client_id: clientId, client_secret: secret, tenant_id: input.tenantId, scopes };
  }

  async listStaff(): Promise<StaffAccountView[]> {
    return (await withSystemTx(this.db, (tx) => this.staff.list(tx))).map(toStaffView);
  }

  async createStaff(
    principal: Principal,
    input: { email: string; displayName: string },
  ): Promise<StaffAccountView> {
    const account = this.newStaff(input.email, input.displayName, principal.subject);
    const inserted = await withSystemTx(this.db, (tx) => this.staff.insert(tx, account));
    if (!inserted) {
      throw new ConflictError('STAFF_EMAIL_TAKEN', 'A staff account with this email exists.');
    }
    return toStaffView(account);
  }

  async disableStaff(principal: Principal, staffId: string): Promise<StaffAccountView> {
    if (staffId === principal.subject) {
      throw new BadRequestError('SELF_DISABLE', 'You cannot disable your own staff account.');
    }
    return withSystemTx(this.db, async (tx) => {
      const account = await this.staff.findById(tx, staffId);
      if (!account) throw new NotFoundError('STAFF_NOT_FOUND', 'Staff account not found.');
      await this.staff.setStatus(tx, staffId, 'disabled');
      return toStaffView({ ...account, status: 'disabled' });
    });
  }

  /** First boot: makes sure the configured bootstrap address has a staff account. Idempotent. */
  async ensureBootstrapStaff(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const account = this.newStaff(normalized, normalized.split('@')[0] ?? 'Admin', 'bootstrap');
    await withSystemTx(this.db, (tx) => this.staff.insert(tx, account));
  }

  private view(connection: SsoConnection, slug: string | null): SsoConnectionView {
    return toSsoView(
      connection,
      slug ? serviceProviderEndpoints(this.settings.issuer, slug) : null,
    );
  }

  private newStaff(email: string, displayName: string, createdBy: string): StaffAccount {
    return {
      id: newId(),
      email: normalizeEmail(email),
      displayName: displayName.trim() || 'Staff',
      roles: ['super_admin'],
      status: 'active',
      lastLoginAt: null,
      createdBy,
      createdAt: this.clock.now(),
    };
  }
}
